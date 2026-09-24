/**
 * Map storage on the account: *My Maps* (the list with thumbnails, each map's revisions
 * and notes, open / download / rename / delete) and *Save to scmjs.dev* (the open map
 * as a new map or a new revision of one, with a note). The bytes are what File ▸ Save
 * would write (`document.export`), and what comes back opens through `document.open`,
 * so the unsaved-changes question is the editor's own.
 *
 * `metaOf` is the pure part: what the plugin can say about the open map from the
 * document info, the statistics and the player slots, which the server shows in the
 * list without opening the file.
 */
import type { DialogHandle, DocumentInfo, MapStatistics, PlayerSlotView } from "@scm-js/plugin-api";
import { describeError, formatBytes, ScmjsError } from "./client";
import { linksSection } from "./copies";
import { storageBar } from "./dialogs";
import type { MapDetail, MapMeta, MapResponse, MapRevisionView, MapSummary, SharedMapView } from "./protocol";
import { endsLine, lower } from "./share/kept";
import { ago, clear, formatDate, h, styled, textarea, type Ctx } from "./ui";

/** Player slots the game would seat: humans, computers and rescuables (neutral and inactive are not players). */
export function metaOf(info: DocumentInfo, stats: MapStatistics | null, players: PlayerSlotView[]): MapMeta {
  const seated = players.filter((p) => p.typeName === "Human" || p.typeName === "Computer" || p.typeName === "Rescuable" || p.typeName === "Computer (game)" || p.typeName === "Occupied");
  const meta: MapMeta = {
    scenarioName: info.name.slice(0, 256),
    tileset: info.tileset,
    width: info.width,
    height: info.height,
    players: seated.length,
    humanPlayers: players.filter((p) => p.typeName === "Human" || p.typeName === "Occupied").length,
  };
  const description = info.description.trim();
  if (description) meta.description = description.slice(0, 4000);
  if (stats) { meta.units = stats.units.total; meta.triggers = stats.triggers.count; }
  return meta;
}

/** `jungle · 128 × 128 · 4 players` — the line under a map's name. */
export function describeMeta(m: MapMeta): string {
  const parts: string[] = [];
  if (m.tileset) parts.push(m.tileset);
  if (m.width && m.height) parts.push(`${m.width} × ${m.height}`);
  if (m.players !== undefined) parts.push(`${m.players} player${m.players === 1 ? "" : "s"}${m.humanPlayers !== undefined && m.humanPlayers !== m.players ? ` (${m.humanPlayers} human)` : ""}`);
  if (m.triggers) parts.push(`${m.triggers} trigger${m.triggers === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

async function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("could not read the picture"));
    r.readAsDataURL(blob);
  });
}

/** The open map at one pixel per tile, as the server's thumbnail; null without the graphics. */
export async function thumbnailOf(ctx: Ctx): Promise<string | null> {
  try {
    const blob = await ctx.api.document.renderImage({ pixelsPerTile: 1, units: true, sprites: false, locations: false, locationNames: false, startLocations: true, fog: false, grid: 0 });
    if (!blob || blob.size > 150_000) return null;
    return await dataUrlOf(blob);
  } catch {
    return null;
  }
}

/**
 * The open map about 512 pixels across (as many pixels per tile as fit, 1 to 8), as a
 * JPEG: what the map's card is drawn with, the one people embed and a pasted link shows.
 * Null without the graphics, and from a server that takes no pictures (before 0.17.0,
 * which refuses the extra part).
 */
export async function pictureOf(ctx: Ctx): Promise<Blob | null> {
  if (!ctx.account.state().offers?.cards) return null;
  const info = ctx.api.document.info();
  if (!info) return null;
  const perTile = Math.max(1, Math.min(8, Math.floor(512 / Math.max(info.width, info.height, 1))));
  try {
    const png = await ctx.api.document.renderImage({ pixelsPerTile: perTile, units: true, sprites: true, locations: false, locationNames: false, startLocations: true, fog: false, grid: 0 });
    if (!png) return null;
    const bitmap = await createImageBitmap(png);
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    for (const quality of [0.86, 0.72, 0.55]) {
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality });
      if (jpeg.size <= 900_000) return jpeg;
    }
    return null;
  } catch {
    return null;
  }
}

/** Which stored map the open document came from or last went to, so Save offers the right one. */
export interface Link { mapId: string; mapName: string; fileName: string | null }

/**
 * The open map to the account: a new map (`mapId` null) or a new revision of one. The
 * bytes are what File ▸ Save would write. `step` hears what it is doing, for a status line.
 */
export async function uploadOpenMap(ctx: Ctx, target: { mapId: string | null; name?: string; note: string; thumbnail: boolean }, step: (text: string) => void = () => {}): Promise<{ response: MapResponse; fileName: string }> {
  const { api, account } = ctx;
  const info = api.document.info();
  if (!info) throw new Error("no map is open.");
  step("Packing the map…");
  const file = await api.document.export();
  if (!file) throw new Error("the map could not be packed.");
  const meta = metaOf(info, api.query.statistics(), api.settings.players());
  if (target.thumbnail) { const t = await thumbnailOf(ctx); if (t) meta.thumbnail = t; }
  const picture = target.thumbnail ? await pictureOf(ctx) : null;
  const fields = { fileName: info.fileName ?? file.name ?? `${info.name || "map"}.scx`, note: target.note, meta, picture };
  step("Uploading…");
  const response = target.mapId === null
    ? await account.client.createMap(file, { ...fields, name: target.name || undefined })
    : await account.client.uploadRevision(target.mapId, file, fields);
  account.noteStorage(response.storage);
  return { response, fileName: fields.fileName };
}

/** "Shared · 2 editing" / "Shared · ends 3 Oct unless someone edits it". */
function sharedLine(v: SharedMapView): string {
  return v.people.length ? `Shared · ${v.people.length} editing` : `Shared · ${lower(endsLine(v))}`;
}

function needsAccount(ctx: Ctx, root: HTMLElement, dialog: DialogHandle): boolean {
  const s = ctx.account.state();
  if (s.kind === "account") return false;
  const w = ctx.api.ui.widgets;
  root.append(
    h("div", { className: "sd-hint" }, s.kind === "trial" ? "Maps are kept on a signed-in account; a trial cannot store them." : "Sign in to scmjs.dev to keep maps on your account."),
    h("div", { className: "sd-btns" }, w.button("Sign in…", { primary: true, onClick: () => { dialog.close(); ctx.openAccount(); } })),
  );
  return true;
}

function thumb(m: MapMeta, big = false): HTMLElement {
  return h("div", { className: `sd-thumb${big ? " sd-thumb-big" : ""}` }, m.thumbnail ? h("img", { src: m.thumbnail, alt: "" }) : h("span", null, m.width && m.height ? `${m.width}×${m.height}` : "map"));
}

/** `2 revisions · 55 KB` — the second line of a map, in the list and over its revisions. */
function sizeLine(m: MapSummary): string {
  return `${m.revisions} revision${m.revisions === 1 ? "" : "s"} · ${formatBytes(m.head.sizeBytes)}${m.links ? ` · ${m.links} link${m.links === 1 ? "" : "s"}` : ""}`;
}

/** Whether a map answers the search box: its name, the scenario's name, the tileset, the file. */
export function matchesSearch(m: MapSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [m.name, m.head.meta.scenarioName, m.head.meta.tileset, m.head.fileName, m.head.note].some((s) => !!s && s.toLowerCase().includes(q));
}

/** Grey rows in the shape of the map list, while it is on its way. */
function listSkeleton(ctx: Ctx, rows: number): HTMLElement[] {
  const w = ctx.api.ui.widgets;
  return Array.from({ length: rows }, () => h("div", { className: "sd-map sd-ghost" },
    w.skeleton({ block: true, width: "56px", height: 56 }),
    h("div", null, w.skeleton({ lines: 3 })),
  ));
}

/** Grey stand-ins for the detail pane, while a map's revisions are on their way. */
function detailSkeleton(ctx: Ctx, m: MapSummary | undefined): HTMLElement {
  const w = ctx.api.ui.widgets;
  return h("div", { className: "sd-detail" },
    h("div", { className: "sd-hero" },
      m ? thumb(m.head.meta, true) : w.skeleton({ block: true, width: "112px", height: 112 }),
      h("div", { className: "sd-hero-text" },
        m ? h("div", { className: "sd-title" }, m.name) : w.skeleton({ width: "60%", height: 16 }),
        w.skeleton({ lines: 2 }),
      ),
    ),
    w.skeleton({ width: "40%", height: 24 }),
    h("div", { className: "sd-section" }, "Revisions"),
    w.skeleton({ lines: 4 }),
  );
}

/* ── My Maps ──────────────────────────────────────────────── */

export function openMapsDialog(ctx: Ctx, link: { get(): Link | null; set(link: Link | null): void }): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  const client = account.client;
  return api.ui.dialog({
    title: "My Maps on scmjs.dev",
    size: "xl",
    tall: true,
    mount(body, dialog) {
      const root = styled(body);
      if (needsAccount(ctx, root, dialog)) return;
      root.classList.add("sd-fill");
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);
      const storageBox = h("div", { className: "sd-meter" });
      const listBox = h("div", { className: "sd-pane sd-maps", tabIndex: 0 });
      const detailBox = h("div", { className: "sd-pane sd-detail-pane" });
      const search = w.text({ placeholder: "Search maps" });
      search.classList.add("sd-search");
      const split = h("div", { className: "sd-split" }, listBox, detailBox);
      let maps: MapSummary[] = [];
      /** The account's maps kept open, by map id (a server without them: none). */
      let shares = new Map<string, SharedMapView>();
      /** Maps already fetched in this dialog, so going back to one is instant. */
      const details = new Map<string, MapDetail>();
      let pickedId: string | null = null;
      let picked: MapDetail | null = null;
      let pickedRevision: MapRevisionView | null = null;
      let loading: AbortController | null = null;
      let picking: AbortController | null = null;

      const renderStorage = (s: { usedBytes: number; capBytes: number } | null) => { clear(storageBox); if (s) storageBox.append(storageBar(s.usedBytes, s.capBytes)); };

      /** Cover the detail pane while `work` runs, with `label` over it. */
      const covered = async (label: string, work: () => Promise<void>) => {
        const cover = w.busy(detailBox, label);
        try { await work(); } catch (err) { say(describeError(err), "error"); } finally { cover.done(); }
      };

      const visible = () => maps.filter((m) => matchesSearch(m, search.value));

      const renderList = () => {
        clear(listBox);
        // With nothing stored, the list's own "save" invitation is the whole dialog.
        split.classList.toggle("sd-none", !maps.length);
        saveHere.hidden = !maps.length;
        if (!maps.length) {
          listBox.append(h("div", { className: "sd-empty-state" },
            h("div", { className: "sd-empty-title" }, "No maps yet"),
            h("div", { className: "sd-hint" }, "Maps you save to scmjs.dev show up here, with every revision and its note."),
            api.document.isOpen() ? w.button("Save the open map here…", { primary: true, onClick: () => { dialog.close(); ctx.saveToCloud(); } }) : null,
          ));
          return;
        }
        const shown = visible();
        if (!shown.length) { listBox.append(h("div", { className: "sd-empty-list" }, `No map matches "${search.value.trim()}".`)); return; }
        for (const m of shown) {
          const kept = shares.get(m.id);
          listBox.append(h("div", { className: `sd-map${pickedId === m.id ? " sd-picked" : ""}`, "data-id": m.id, onClick: () => void pick(m.id) },
            thumb(m.head.meta),
            h("div", { className: "sd-map-text" },
              h("div", { className: "sd-name-row" },
                h("span", { className: "sd-name", title: m.name }, m.name),
                h("span", { className: "sd-when", title: formatDate(m.updatedAt) }, ago(m.updatedAt)),
              ),
              h("div", { className: "sd-sub" }, describeMeta(m.head.meta) || m.head.fileName),
              h("div", { className: "sd-sub" }, sizeLine(m)),
              kept ? h("div", { className: "sd-badge" }, sharedLine(kept)) : null,
            ),
          ));
        }
      };

      /** Up and Down move through the list, Enter opens the newest revision. */
      listBox.addEventListener("keydown", (e) => {
        const shown = visible();
        if (!shown.length) return;
        const at = shown.findIndex((m) => m.id === pickedId);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]!;
          void pick(next.id);
          listBox.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && picked && picked.id === pickedId) {
          e.preventDefault();
          (detailBox.querySelector(".sd-open") as HTMLButtonElement | null)?.click();
        }
      });
      search.addEventListener("input", () => renderList());
      search.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); const first = visible()[0]; if (first) { void pick(first.id); listBox.focus(); } }
      });

      const renderDetail = () => {
        clear(detailBox);
        const m = picked;
        if (!m) {
          if (maps.length) detailBox.append(h("div", { className: "sd-empty-list" }, "Pick a map to see its revisions."));
          return;
        }
        const rev = pickedRevision ?? m.head;
        const isHead = rev.number === m.head.number;
        const kept = shares.get(m.id) ?? null;
        const current = ctx.shares?.current() ?? null;
        const inIt = !!kept && current?.room?.id === m.id && current.phase !== "ended";

        const join = kept && !inIt && ctx.shares ? w.button("Join", { primary: true, title: "Open the shared map and edit it with whoever is in it", onClick: () => void covered("Joining…", async () => {
          await ctx.shares!.join(kept.invite, account.current()?.name ?? "Owner");
          dialog.close();
        }) }) : null;
        // The owner, in the shared map: a revision can be put back into it, for everyone.
        const restore = inIt && current?.owner && current.documentId !== null ? w.button(`Put #${rev.number} into the shared map`, { title: "Replace the shared map with this revision, for everyone in it", onClick: async () => {
          if (!(await api.ui.confirm(`Replace the shared map with revision #${rev.number}? Everyone in it gets #${rev.number} at once, and everyone's undo history starts again, as after a resize. The map as it is now is not kept unless you save it first.`, { title: "Put a revision into the shared map", confirmLabel: `Put #${rev.number} in`, danger: true }))) return;
          await covered(`Downloading #${rev.number}…`, async () => {
            const { bytes } = await client.revisionFile(m.id, rev.number);
            const chk = await api.document.sections.chkOf(bytes);
            if (current.documentId === null || !api.document.activate(current.documentId)) throw new Error("the shared map is not open.");
            api.document.sections.replaceFile(chk);
            dialog.close();
            api.ui.toast({ kind: "ok", title: `Put #${rev.number} into the shared map` });
          });
        } }) : null;
        const open = w.button(isHead ? "Open" : `Open #${rev.number}`, { primary: !join, className: "sd-open", title: kept ? "Open this revision on its own, apart from the shared map" : `Open revision #${rev.number} in the editor`, onClick: () => void covered(`Downloading #${rev.number}…`, async () => {
          open.setBusy(true);
          try {
            const { bytes, fileName } = await client.revisionFile(m.id, rev.number);
            const opened = await api.document.open(bytes, fileName || rev.fileName);
            if (opened) { link.set({ mapId: m.id, mapName: m.name, fileName: fileName || rev.fileName }); dialog.close(); api.ui.toast({ kind: "ok", title: `Opened ${m.name} #${rev.number}`, detail: rev.note || undefined }); }
            else say("Not opened.");
          } finally { open.setBusy(false); }
        }) });
        const download = w.button("Download", { title: `Save revision #${rev.number} as a file`, onClick: () => void covered(`Downloading #${rev.number}…`, async () => {
          const { bytes, fileName } = await client.revisionFile(m.id, rev.number);
          const out = await api.ui.saveFile(bytes, fileName || rev.fileName);
          say(out ? `Saved ${out.fileName}.` : "Not saved.", out ? "ok" : undefined);
        }) });
        const rename = w.button("Rename…", { ghost: true, onClick: async () => {
          const name = await api.ui.prompt("Name for this map:", { title: "Rename map", value: m.name, confirmLabel: "Rename" });
          if (name === null || !name.trim() || name.trim() === m.name) return;
          await covered("Renaming…", async () => { await update(await client.patchMap(m.id, { name: name.trim() })); say("Renamed.", "ok"); });
        } });

        const revs = h("div", { className: "sd-revs" });
        for (const r of m.history) {
          const on = r.number === rev.number;
          const row = h("div", { className: `sd-rev${on ? " sd-picked" : ""}`, onClick: () => { if (!on) { pickedRevision = r; renderDetail(); } } },
            h("span", { className: "sd-n" }, `#${r.number}`),
            h("span", { className: `sd-note-text${r.note ? "" : " sd-empty"}` }, r.note || "No note"),
            h("span", { className: "sd-when", title: formatDate(r.createdAt) }, ago(r.createdAt)),
            h("span", { className: "sd-sub" }, `${r.number === m.head.number ? "Newest · " : ""}${r.fileName} · ${formatBytes(r.sizeBytes)}${r.meta.scenarioName && r.meta.scenarioName !== m.name ? ` · "${r.meta.scenarioName}"` : ""}`),
          );
          if (on) {
            const note = w.button(r.note ? "Edit note…" : "Add a note…", { ghost: true, onClick: async (e) => {
              e.stopPropagation();
              const text = await api.ui.prompt(`Note for revision #${r.number} of ${m.name}:`, { title: "Revision note", value: r.note, multiline: true, confirmLabel: "Save" });
              if (text === null) return;
              await covered("Saving the note…", async () => { await update(await client.patchRevision(m.id, r.number, { note: text })); say("Note saved.", "ok"); });
            } });
            const last = m.history.length <= 1;
            const del = w.button("Delete", { ghost: true, danger: true, disabled: last, title: last ? "A map keeps its last revision; delete the map to remove it." : `Delete revision #${r.number}`, onClick: async (e) => {
              e.stopPropagation();
              const pinned = m.linkList.filter((l) => l.revision === r.number).length;
              const also = pinned ? ` ${pinned === 1 ? "The link" : `The ${pinned} links`} to it stop working too.` : "";
              if (!(await api.ui.confirm(`Delete revision #${r.number} of ${m.name}? Its file is removed from the account when no other revision shares it.${also}`, { title: "Delete revision", confirmLabel: "Delete", danger: true }))) return;
              await covered("Deleting…", async () => { pickedRevision = null; await update(await client.deleteRevision(m.id, r.number)); say(`Revision #${r.number} deleted.`, "ok"); });
            } });
            row.append(h("div", { className: "sd-rev-btns" }, note, del));
          }
          revs.append(row);
        }

        const endSharing = kept ? w.button("End sharing", { danger: true, onClick: async () => {
          if (!(await api.ui.confirm(`End sharing ${m.name}? Anyone in it is sent out and the link stops working. The map and its revisions stay here.`, { title: "End sharing", confirmLabel: "End sharing", danger: true }))) return;
          await covered("Ending sharing…", async () => {
            const r = await client.endSharedMap(m.id);
            shares = new Map(r.rooms.filter((x) => x.kind === "kept").map((x) => [x.id, x]));
            renderList(); renderDetail();
            say("Sharing ended.", "ok");
          });
        } }) : null;
        const delMap = w.button("Delete map…", { danger: true, onClick: async () => {
          if (!(await api.ui.confirm(`Delete ${m.name} and all ${m.revisions} of its revisions from the account?${m.links ? ` Its ${m.links === 1 ? "link stops" : `${m.links} links stop`} working too.` : ""}`, { title: "Delete map", confirmLabel: "Delete", danger: true }))) return;
          await covered("Deleting…", async () => {
            const r = await client.deleteMap(m.id);
            account.noteStorage(r.storage);
            if (link.get()?.mapId === m.id) link.set(null);
            details.delete(m.id);
            maps = maps.filter((x) => x.id !== m.id);
            pickedId = null; picked = null; pickedRevision = null;
            renderStorage(r.storage); renderList(); renderDetail();
            say("Map deleted.", "ok");
          });
        } });

        detailBox.append(h("div", { className: "sd-detail" },
          h("div", { className: "sd-hero" },
            thumb(rev.meta.thumbnail ? rev.meta : m.head.meta, true),
            h("div", { className: "sd-hero-text" },
              h("div", { className: "sd-name-row" }, h("span", { className: "sd-title", title: m.name }, m.name), rename),
              h("div", { className: "sd-sub" }, describeMeta(rev.meta) || rev.fileName),
              h("div", { className: "sd-sub" }, `${sizeLine(m)} · created ${formatDate(m.createdAt)}`),
              m.description ? h("div", { className: "sd-about" }, m.description) : null,
              kept ? h("div", { className: "sd-badge" }, `${sharedLine(kept)}${inIt ? " · you are in it" : ""}`) : null,
            ),
          ),
          kept && !inIt ? h("div", { className: "sd-hint" }, "Join it to edit with whoever is there; Open gives you a copy of a revision on its own.") : null,
          h("div", { className: "sd-btns" }, join, open, download, restore),
          h("div", { className: "sd-section" }, `Revisions (${m.history.length})`),
          revs,
          h("div", { className: "sd-section" }, "Links"),
          linksSection(ctx, m, rev.number, update, say),
          h("div", { className: "sd-section" }, "Manage"),
          h("div", { className: "sd-btns" }, delMap, endSharing),
        ));
      };

      const update = async (r: { map: MapDetail; storage: { usedBytes: number; capBytes: number; maps: number; revisions: number } }) => {
        picked = r.map;
        pickedId = r.map.id;
        details.set(r.map.id, r.map);
        if (pickedRevision && !r.map.history.some((x) => x.number === pickedRevision!.number)) pickedRevision = null;
        else if (pickedRevision) pickedRevision = r.map.history.find((x) => x.number === pickedRevision!.number) ?? null;
        account.noteStorage(r.storage);
        renderStorage(r.storage);
        const i = maps.findIndex((m) => m.id === r.map.id);
        const summary: MapSummary = { id: r.map.id, name: r.map.name, description: r.map.description, createdAt: r.map.createdAt, updatedAt: r.map.updatedAt, revisions: r.map.revisions, head: r.map.head, links: r.map.links };
        if (i >= 0) maps[i] = summary; else maps.unshift(summary);
        maps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        renderList();
        renderDetail();
      };

      const pick = async (id: string) => {
        if (pickedId === id && picked?.id === id) return;
        picking?.abort();
        pickedId = id;
        pickedRevision = null;
        renderList();
        const cached = details.get(id);
        if (cached) { picked = cached; renderDetail(); return; }
        picked = null;
        clear(detailBox);
        detailBox.append(detailSkeleton(ctx, maps.find((m) => m.id === id)));
        const ac = picking = new AbortController();
        try {
          const r = await client.map(id, ac.signal);
          details.set(id, r.map);
          if (pickedId !== id) return;
          picked = r.map;
          renderDetail();
        } catch (err) {
          if (err instanceof ScmjsError && err.code === "aborted") return;
          if (pickedId !== id) return;
          clear(detailBox);
          detailBox.append(h("div", { className: "sd-empty-list" }, h("div", { className: "sd-bad" }, describeError(err)), w.button("Try again", { onClick: () => { pickedId = null; void pick(id); } })));
        }
      };

      const load = async () => {
        loading?.abort();
        const ac = loading = new AbortController();
        const first = !maps.length;
        const cover = first ? null : w.busy(listBox, "Refreshing…");
        if (first) { clear(listBox); listBox.append(...listSkeleton(ctx, 5)); clear(detailBox); detailBox.append(detailSkeleton(ctx, undefined)); }
        dialog.setBusy("Loading your maps…");
        refresh.setBusy(true);
        try {
          const [r, shared] = await Promise.all([
            client.listMaps(ac.signal),
            account.state().offers?.keptRooms ? client.sharedMaps(ac.signal).catch(() => null) : Promise.resolve(null),
          ]);
          maps = r.maps;
          shares = new Map((shared?.rooms ?? []).filter((x) => x.kind === "kept").map((x) => [x.id, x]));
          details.clear();
          account.noteStorage(r.storage);
          renderStorage(r.storage);
          say("");
          // The map the open document came from, else the newest.
          const want = link.get()?.mapId;
          const next = (pickedId && maps.some((m) => m.id === pickedId) ? pickedId : null) ?? (want && maps.some((m) => m.id === want) ? want : null) ?? maps[0]?.id ?? null;
          pickedId = null; picked = null;
          renderList();
          renderDetail();
          if (next) void pick(next);
        } catch (err) {
          if (err instanceof ScmjsError && err.code === "aborted") return;
          if (first) {
            clear(listBox); clear(detailBox);
            listBox.append(h("div", { className: "sd-empty-list" }, h("div", { className: "sd-bad" }, describeError(err)), w.button("Try again", { onClick: () => void load() })));
          }
          say(describeError(err), "error");
        } finally {
          cover?.done();
          if (loading === ac) { dialog.setBusy(false); refresh.setBusy(false); }
        }
      };

      const refresh = w.button("Refresh", { ghost: true, title: "Load the list again", onClick: () => void load() });
      const saveHere = w.button("Save the open map here…", { disabled: !api.document.isOpen(), onClick: () => { dialog.close(); ctx.saveToCloud(); } });
      root.append(
        h("div", { className: "sd-toolbar" }, search, storageBox, refresh),
        split,
        h("div", { className: "sd-btns" }, saveHere, h("div", { className: "sd-grow" }, status)),
      );
      void load();
      queueMicrotask(() => search.focus());
      return () => { loading?.abort(); picking?.abort(); };
    },
    buttons: [{ label: "Close", primary: true }],
  });
}

/* ── Save to scmjs.dev ────────────────────────────────────── */

export function openSaveDialog(ctx: Ctx, link: { get(): Link | null; set(link: Link | null): void }): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  const client = account.client;
  return api.ui.dialog({
    title: "Save to scmjs.dev",
    size: "md",
    mount(body, dialog) {
      const root = styled(body);
      if (needsAccount(ctx, root, dialog)) return;
      const info = api.document.info();
      if (!info) { root.append(h("div", { className: "sd-hint" }, "No map is open.")); return; }
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);
      const NEW = "__new__";
      const current = link.get();
      const target = w.select([{ value: NEW, label: "A new map" }], { value: NEW, onChange: () => sync() });
      const nameField = w.text({ value: info.name || (info.fileName ?? "").replace(/\.(scm|scx|chk)$/i, ""), placeholder: "Name in the list" });
      const noteField = textarea({ placeholder: "What changed, or what this version is for (optional)", rows: 3 });
      const thumbBox = w.checkbox("Include a picture of the map in the list (one pixel per tile)", { value: true });
      const nameRow = w.form([{ label: "Name", field: nameField }]);
      const sync = () => { nameRow.hidden = target.value !== NEW; };
      const save = w.button("Save", { primary: true, onClick: async () => {
        save.setBusy(true);
        dialog.setBusy("Saving…");
        try {
          const { response: r, fileName } = await uploadOpenMap(ctx, {
            mapId: target.value === NEW ? null : target.value, name: nameField.value.trim(), note: noteField.value.trim(), thumbnail: thumbBox.input.checked,
          }, (text) => status.busy(text));
          link.set({ mapId: r.map.id, mapName: r.map.name, fileName });
          api.ui.toast({ kind: "ok", title: `Saved to scmjs.dev: ${r.map.name} #${r.map.head.number}`, detail: `${formatBytes(r.storage.usedBytes)} of ${formatBytes(r.storage.capBytes)} used.` });
          dialog.close();
        } catch (err) {
          say(describeError(err), "error");
        } finally {
          save.setBusy(false);
          dialog.setBusy(false);
        }
      } });
      root.append(
        w.form([{ label: "Save as", field: target }]),
        nameRow,
        h("div", null, h("div", { className: "sd-hint", style: "margin-bottom: 4px" }, "Note for this revision"), noteField),
        thumbBox,
        h("div", { className: "sd-hint" }, "The file is what File ▸ Save would write, with the options you last saved with. Saving the same bytes again costs no storage; only the note is new."),
        h("div", { className: "sd-btns" }, save),
        status,
      );
      // The list of maps to add a revision to, with the linked one picked.
      void (async () => {
        status.busy("Loading your maps…");
        target.disabled = true;
        try {
          const r = await client.listMaps();
          account.noteStorage(r.storage);
          for (const m of r.maps) target.add(new Option(`${m.name} — new revision #${m.head.number + 1}`, m.id));
          if (current && r.maps.some((m) => m.id === current.mapId)) target.value = current.mapId;
          sync();
          say(`${formatBytes(r.storage.usedBytes)} of ${formatBytes(r.storage.capBytes)} used.`);
        } catch (err) { say(describeError(err), "error"); }
        finally { target.disabled = false; }
      })();
    },
    buttons: [{ label: "Cancel" }],
  });
}
