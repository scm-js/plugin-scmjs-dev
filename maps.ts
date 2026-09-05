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
import { storageBar } from "./dialogs";
import type { MapDetail, MapMeta, MapRevisionView, MapSummary } from "./protocol";
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
async function thumbnailOf(ctx: Ctx): Promise<string | null> {
  try {
    const blob = await ctx.api.document.renderImage({ pixelsPerTile: 1, units: true, sprites: false, locations: false, locationNames: false, startLocations: true, fog: false, grid: 0 });
    if (!blob || blob.size > 150_000) return null;
    return await dataUrlOf(blob);
  } catch {
    return null;
  }
}

/** Which stored map the open document came from or last went to, so Save offers the right one. */
export interface Link { mapId: string; mapName: string; fileName: string | null }

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

function thumb(m: MapMeta): HTMLElement {
  return h("div", { className: "sd-thumb" }, m.thumbnail ? h("img", { src: m.thumbnail, alt: "" }) : h("span", null, m.width && m.height ? `${m.width}×${m.height}` : "map"));
}

/* ── My Maps ──────────────────────────────────────────────── */

export function openMapsDialog(ctx: Ctx, link: { get(): Link | null; set(link: Link | null): void }): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  const client = account.client;
  return api.ui.dialog({
    title: "My Maps on scmjs.dev",
    size: "lg",
    tall: true,
    mount(body, dialog) {
      const root = styled(body);
      if (needsAccount(ctx, root, dialog)) return;
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);
      const storageBox = h("div", null);
      const listBox = h("div", { className: "sd-scroll sd-maps" });
      const detailBox = h("div", null);
      let maps: MapSummary[] = [];
      let picked: MapDetail | null = null;
      let pickedRevision: MapRevisionView | null = null;
      let loading: AbortController | null = null;

      const renderStorage = (s: { usedBytes: number; capBytes: number } | null) => { clear(storageBox); if (s) storageBox.append(storageBar(s.usedBytes, s.capBytes)); };

      const renderList = () => {
        clear(listBox);
        if (!maps.length) { listBox.append(h("div", { className: "sd-empty-list" }, "No maps yet. Account ▸ Save to scmjs.dev… puts the open map here.")); return; }
        for (const m of maps) {
          const row = h("div", { className: `sd-map${picked?.id === m.id ? " sd-picked" : ""}`, onClick: () => void pick(m.id) },
            thumb(m.head.meta),
            h("div", null,
              h("div", { className: "sd-name" }, m.name),
              h("div", { className: "sd-sub" }, describeMeta(m.head.meta) || m.head.fileName),
              h("div", { className: "sd-sub" }, `${m.revisions} revision${m.revisions === 1 ? "" : "s"} · ${formatBytes(m.head.sizeBytes)}${m.head.note ? ` · ${m.head.note.split("\n")[0]}` : ""}`),
            ),
            h("div", { className: "sd-when", title: formatDate(m.updatedAt) }, ago(m.updatedAt)),
          );
          listBox.append(row);
        }
      };

      const renderDetail = () => {
        clear(detailBox);
        const m = picked;
        if (!m) { detailBox.append(h("div", { className: "sd-empty-list" }, maps.length ? "Pick a map to see its revisions." : "")); return; }
        const rev = pickedRevision ?? m.head;
        const revs = h("div", { className: "sd-scroll sd-revs" });
        for (const r of m.history) {
          revs.append(h("div", { className: `sd-rev${r.number === rev.number ? " sd-picked" : ""}`, onClick: () => { pickedRevision = r; renderDetail(); } },
            h("span", { className: "sd-n" }, `#${r.number}`),
            h("span", { className: `sd-note-text${r.note ? "" : " sd-empty"}` }, r.note || "no note"),
            h("span", { className: "sd-when", title: formatDate(r.createdAt) }, ago(r.createdAt)),
            h("span", { className: "sd-sub" }, `${r.fileName} · ${formatBytes(r.sizeBytes)}${r.meta.scenarioName && r.meta.scenarioName !== m.name ? ` · "${r.meta.scenarioName}"` : ""}`),
          ));
        }
        const open = w.button(`Open #${rev.number}`, { primary: true, onClick: async () => {
          open.setBusy(true);
          try {
            status.busy(`Downloading #${rev.number}…`);
            const { bytes, fileName } = await client.revisionFile(m.id, rev.number);
            const opened = await api.document.open(bytes, fileName || rev.fileName);
            if (opened) { link.set({ mapId: m.id, mapName: m.name, fileName: fileName || rev.fileName }); dialog.close(); api.ui.toast({ kind: "ok", title: `Opened ${m.name} #${rev.number}`, detail: rev.note || undefined }); }
            else say("Not opened.");
          } catch (err) { say(describeError(err), "error"); }
          finally { open.setBusy(false); }
        } });
        const download = w.button("Download", { onClick: async () => {
          download.setBusy(true);
          try {
            const { bytes, fileName } = await client.revisionFile(m.id, rev.number);
            const out = await api.ui.saveFile(bytes, fileName || rev.fileName);
            say(out ? `Saved ${out.fileName}.` : "Not saved.", out ? "ok" : undefined);
          } catch (err) { say(describeError(err), "error"); }
          finally { download.setBusy(false); }
        } });
        const note = w.button("Edit note…", { onClick: async () => {
          const text = await api.ui.prompt(`Note for revision #${rev.number} of ${m.name}:`, { title: "Revision note", value: rev.note, multiline: true, confirmLabel: "Save" });
          if (text === null) return;
          try { await update(await client.patchRevision(m.id, rev.number, { note: text })); say("Note saved.", "ok"); }
          catch (err) { say(describeError(err), "error"); }
        } });
        const rename = w.button("Rename…", { onClick: async () => {
          const name = await api.ui.prompt("Name for this map:", { title: "Rename map", value: m.name, confirmLabel: "Rename" });
          if (name === null || !name.trim()) return;
          try { await update(await client.patchMap(m.id, { name: name.trim() })); say("Renamed.", "ok"); }
          catch (err) { say(describeError(err), "error"); }
        } });
        const delRev = w.button(`Delete #${rev.number}`, { danger: true, disabled: m.history.length <= 1, title: m.history.length <= 1 ? "A map keeps its last revision; delete the map to remove it." : undefined, onClick: async () => {
          if (!(await api.ui.confirm(`Delete revision #${rev.number} of ${m.name}? Its file is removed from the account when no other revision shares it.`, { title: "Delete revision", confirmLabel: "Delete", danger: true }))) return;
          try { pickedRevision = null; await update(await client.deleteRevision(m.id, rev.number)); say(`Revision #${rev.number} deleted.`, "ok"); }
          catch (err) { say(describeError(err), "error"); }
        } });
        const delMap = w.button("Delete map", { danger: true, onClick: async () => {
          if (!(await api.ui.confirm(`Delete ${m.name} and all ${m.revisions} of its revisions from the account?`, { title: "Delete map", confirmLabel: "Delete", danger: true }))) return;
          try {
            const r = await client.deleteMap(m.id);
            account.noteStorage(r.storage);
            if (link.get()?.mapId === m.id) link.set(null);
            picked = null; pickedRevision = null;
            await load();
            say("Map deleted.", "ok");
          } catch (err) { say(describeError(err), "error"); }
        } });
        detailBox.append(
          h("div", { className: "sd-head" },
            h("span", { className: "sd-k" }, "Map"), h("span", { className: "sd-v sd-big" }, m.name),
            ...(m.description ? [h("span", { className: "sd-k" }, "About"), h("span", { className: "sd-v" }, m.description)] : []),
            h("span", { className: "sd-k" }, "Created"), h("span", { className: "sd-v" }, formatDate(m.createdAt)),
          ),
          h("div", { className: "sd-btns" }, open, download, note, rename),
          revs,
          h("div", { className: "sd-btns" }, delRev, delMap),
        );
      };

      const update = async (r: { map: MapDetail; storage: { usedBytes: number; capBytes: number; maps: number; revisions: number } }) => {
        picked = r.map;
        if (pickedRevision && !r.map.history.some((x) => x.number === pickedRevision!.number)) pickedRevision = null;
        account.noteStorage(r.storage);
        renderStorage(r.storage);
        const i = maps.findIndex((m) => m.id === r.map.id);
        const summary: MapSummary = { id: r.map.id, name: r.map.name, description: r.map.description, createdAt: r.map.createdAt, updatedAt: r.map.updatedAt, revisions: r.map.revisions, head: r.map.head };
        if (i >= 0) maps[i] = summary; else maps.unshift(summary);
        maps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        renderList();
        renderDetail();
      };

      const pick = async (id: string) => {
        if (picked?.id === id) return;
        pickedRevision = null;
        try {
          status.busy("Loading…");
          const r = await client.map(id);
          picked = r.map;
          renderList(); renderDetail();
          say("");
        } catch (err) { say(describeError(err), "error"); }
      };

      const load = async () => {
        loading?.abort();
        loading = new AbortController();
        clear(listBox);
        listBox.append(w.skeleton({ lines: 4, block: true }));
        status.busy("Loading your maps…");
        try {
          const r = await client.listMaps(loading.signal);
          maps = r.maps;
          account.noteStorage(r.storage);
          renderStorage(r.storage);
          renderList();
          renderDetail();
          say(maps.length ? `${maps.length} map${maps.length === 1 ? "" : "s"}.` : "");
          const current = link.get();
          if (current && maps.some((m) => m.id === current.mapId)) void pick(current.mapId);
        } catch (err) {
          if (err instanceof ScmjsError && err.code === "aborted") return;
          clear(listBox);
          say(describeError(err), "error");
        }
      };

      const saveHere = w.button("Save the open map here…", { disabled: !api.document.isOpen(), onClick: () => { dialog.close(); ctx.saveToCloud(); } });
      root.append(
        storageBox,
        h("div", { className: "sd-split" }, listBox, detailBox),
        h("div", { className: "sd-btns" }, saveHere, w.button("Refresh", { onClick: () => void load() })),
        status,
      );
      void load();
      return () => { loading?.abort(); };
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
          status.busy("Packing the map…");
          const file = await api.document.export();
          if (!file) throw new Error("the map could not be packed.");
          const meta = metaOf(info, api.query.statistics(), api.settings.players());
          if (thumbBox.input.checked) { const t = await thumbnailOf(ctx); if (t) meta.thumbnail = t; }
          const fields = { fileName: info.fileName ?? file.name ?? `${info.name || "map"}.scx`, note: noteField.value.trim(), meta };
          status.busy("Uploading…");
          const r = target.value === NEW
            ? await client.createMap(file, { ...fields, name: nameField.value.trim() || undefined })
            : await client.uploadRevision(target.value, file, fields);
          account.noteStorage(r.storage);
          link.set({ mapId: r.map.id, mapName: r.map.name, fileName: fields.fileName });
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
        try {
          const r = await client.listMaps();
          account.noteStorage(r.storage);
          for (const m of r.maps) target.add(new Option(`${m.name} — new revision #${m.head.number + 1}`, m.id));
          if (current && r.maps.some((m) => m.id === current.mapId)) target.value = current.mapId;
          sync();
          say(`${formatBytes(r.storage.usedBytes)} of ${formatBytes(r.storage.capBytes)} used.`);
        } catch (err) { say(describeError(err), "error"); }
      })();
    },
    buttons: [{ label: "Cancel" }],
  });
}
