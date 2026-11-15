/**
 * Replays on the account, and replay links: `scmjs.dev/replay/<token>` (which the site sends
 * on to `<editor>/replay/<token>`) opens a replay kept on scmjs.dev in whoever's editor the
 * link is opened in, signed in or not, in the replay viewer (the Aftermath plugin), at the
 * moment its `?t=` says.
 *
 * The plugin cannot hand a replay to the viewer through the editor: `document.open` reads any
 * file as a map, and the host routes a file to the plugin that claimed its extension only
 * when it is dropped, picked in File ▸ Open or handed over by the command line. So a
 * replay goes to the viewer's own service, `aftermath.replays` (Aftermath 0.27.0), with
 * where it came from: its link, and the moment a link's `?t=` opens it at. A viewer from
 * before that gets it the way a dropped one is: a `drop` event with the file in it, on the
 * page (`openAsDropped`), and opens it at its start. Both wait for the viewer to be there —
 * Aftermath registers its file type when it starts, which may be after this plugin — and
 * say so when it is not.
 *
 * The viewer's Share asks for a replay's link through this plugin's `scmjs-dev.replays`
 * service (`replaysService`): sign in, keep the replay (by its hash: never a second copy),
 * make the link.
 *
 * The owner's side is the Replays part of My Maps (`replaysPart`): the list, Open, Copy
 * link, Remove link, Delete, and Upload a Replay…. A replay open in the viewer is kept from
 * the viewer's Share, which has its bytes: the viewer's document is the map the game was
 * played on, and the editor gives this plugin no way to the `.rep` it came from.
 */
import { describeError, formatBytes, ScmjsError } from "./client";
import type { ReplayFile, ReplayStatus, ScmjsReplaysService } from "./contract";
import type { PublicReplayView, ReplayFacts, ReplayView, StorageView } from "./protocol";
import { replayLink } from "./share/link";
import { language, t } from "./i18n";
import { ago, clear, formatDate, h, type Ctx } from "./ui";

/** The viewer's command, which is there once it has started (and with it its claim on `.rep`). */
const VIEWER_COMMAND = "aftermath.open-replay";
/** The viewer's service, which takes a replay with where it came from (Aftermath 0.27.0). */
const VIEWER_SERVICE = "aftermath.replays";

/** Where a replay handed to the viewer came from: its link, and the moment to open it at, in seconds of game time. */
export interface ReplayFrom {
  link?: string;
  at?: number;
}

/** The part of Aftermath's `aftermath.replays` service this plugin uses. */
interface ViewerService {
  open(file: File, from?: ReplayFrom): Promise<void>;
}
/** How long a replay link waits at startup for the viewer to start. */
const VIEWER_WAIT_MS = 20_000;

const where = () => (typeof location !== "undefined" ? { protocol: location.protocol, origin: location.origin, pathname: location.pathname } : null);

/** The address a replay link's token makes, from the editor this is running in. */
export function replayAddress(ctx: Ctx, token: string): string {
  return replayLink(token, ctx.account.serverUrl(), where());
}

/** `10:08` or `1:05:09`. */
export function formatLength(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`;
}

const LETTER: Record<string, string> = { zerg: "Z", terran: "T", protoss: "P" };

/** "Question (P) vs Drywater (T)", or "A (P) & B (T) vs C (Z) & D (Z)" when there are teams. Names are the game's, never translated. */
export function playersLine(f: Pick<ReplayFacts, "players">): string {
  const one = (p: ReplayFacts["players"][number]) => `${p.name} (${p.race ? LETTER[p.race] : "?"})`;
  const teams = [...new Set(f.players.map((p) => p.team))].sort((a, b) => a - b);
  if (teams.length <= 1) return f.players.map(one).join(" vs ");
  return teams.map((team) => f.players.filter((p) => p.team === team).map(one).join(" & ")).join(" vs ");
}

/** "PvT · 10:08 · Melee · played 12 Jan 2013": the line under a replay's map name. */
export function factsLine(f: ReplayFacts): string {
  const when = f.playedAt ? t("played {date}", { date: new Date(f.playedAt).toLocaleDateString(language(), { day: "numeric", month: "short", year: "numeric" }) }) : "";
  return [f.matchup, formatLength(f.durationSec), f.gameTypeName, when].filter(Boolean).join(" · ");
}

/**
 * Open a replay as if its file had been dropped on the editor. `"opened"` once the viewer
 * has it; `"no-viewer"` when no viewer started in time (Aftermath is off, or this editor has
 * none); `"no-drop"` when the browser cannot build the event.
 */
export async function openAsDropped(ctx: Ctx, bytes: Uint8Array, fileName: string, waitMs = VIEWER_WAIT_MS): Promise<"opened" | "no-viewer" | "no-drop"> {
  if (!(await viewerStarted(ctx, waitMs))) return "no-viewer";
  return drop(bytes, fileName);
}

/** Whether the viewer is there, waiting up to `waitMs` for it to start. */
async function viewerStarted(ctx: Ctx, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (!ctx.api.commands.has(VIEWER_COMMAND)) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
}

/**
 * Hand a replay to the viewer with where it came from (`from`): through its service, or, from a viewer without one,
 * as a dropped file, which opens at its start.
 */
export async function handToViewer(ctx: Ctx, bytes: Uint8Array, fileName: string, from: ReplayFrom = {}, waitMs = VIEWER_WAIT_MS): Promise<"opened" | "no-viewer" | "no-drop"> {
  if (!(await viewerStarted(ctx, waitMs))) return "no-viewer";
  const viewer = ctx.api.services.get<ViewerService>(VIEWER_SERVICE);
  if (!viewer) return drop(bytes, fileName);
  await viewer.open(new File([bytes as BlobPart], fileName, { type: "application/octet-stream" }), from);
  return "opened";
}

function drop(bytes: Uint8Array, fileName: string): "opened" | "no-drop" {
  let event: DragEvent;
  try {
    const data = new DataTransfer();
    data.items.add(new File([bytes as BlobPart], fileName, { type: "application/octet-stream" }));
    event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });
  } catch {
    return "no-drop";
  }
  // The editor takes a drop on the document that nothing inside the page took first.
  document.dispatchEvent(event);
  return "opened";
}

/** When the viewer is not there: say so, and offer the file. */
async function noViewer(ctx: Ctx, bytes: Uint8Array, fileName: string, reason: "no-viewer" | "no-drop"): Promise<void> {
  const { api } = ctx;
  const message = reason === "no-viewer"
    ? t("Replays open in the Aftermath plugin, which is not running in this editor. Turn it on under Plugins ▸ Manage Plugins… and open the link again, or save the replay and open it later.")
    : t("This browser cannot hand the replay to the replay viewer. Save it, then drop it on the editor or open it with File ▸ Open Replay….");
  if (await api.ui.confirm(message, { title: t("Open the replay"), confirmLabel: t("Save the replay…") })) {
    const out = await api.ui.saveFile(bytes, fileName);
    if (out) api.ui.toast({ kind: "ok", title: t("Saved {name}.", { name: out.fileName }) });
  }
}

/** Open a replay's bytes in the viewer; a toast says what happened. */
async function openReplay(ctx: Ctx, bytes: Uint8Array, facts: ReplayFacts & { fileName: string }, from: ReplayFrom = {}): Promise<boolean> {
  const done = await handToViewer(ctx, bytes, facts.fileName, from);
  if (done !== "opened") { await noViewer(ctx, bytes, facts.fileName, done); return false; }
  ctx.api.ui.toast({ kind: "ok", title: t("Opened the replay: {players}", { players: playersLine(facts) }), detail: `${facts.mapName} · ${factsLine(facts)}` });
  return true;
}

/**
 * The editor was opened from a replay link: look the link up, fetch the file and open it, at
 * `at` (seconds of game time, the link's `?t=`) when it says one. The viewer gets the link
 * with it, so sharing the replay from there needs no sign-in and sends nothing. A link that
 * no longer works says so and leaves the editor as it is.
 */
export async function openReplayLink(ctx: Ctx, token: string, at: number | null = null): Promise<void> {
  const { api, account } = ctx;
  let found: PublicReplayView;
  try {
    found = (await account.client.linkedReplay(token)).replay;
  } catch (err) {
    if (err instanceof ScmjsError && err.code === "not_found") {
      await api.ui.alert(t("This replay link no longer works: the replay was deleted, or its link was removed. The editor is here as usual."), { title: t("Replay link") });
    } else {
      await api.ui.alert(t("The replay could not be opened. {reason}", { reason: describeError(err) }), { title: t("Replay link") });
    }
    return;
  }
  const progress = api.ui.progress(t("Downloading the replay…"));
  let bytes: Uint8Array;
  try {
    bytes = (await account.client.linkedReplayFile(token)).bytes;
  } catch (err) {
    await api.ui.alert(t("The replay could not be opened. {reason}", { reason: describeError(err) }), { title: t("Replay link") });
    return;
  } finally {
    progress.done();
  }
  await openReplay(ctx, bytes, found, { link: replayAddress(ctx, token), ...(at !== null ? { at } : {}) });
}

/* ── In My Maps ───────────────────────────────────────────── */

export interface ReplaysPart {
  element: HTMLElement;
  /** The upload button, for the dialog's bottom row. */
  upload: HTMLElement;
  load(): Promise<void>;
  abort(): void;
}

/**
 * The account's replays, as a list in the dialog's style: the map, the players, the
 * length, when it was played and its size, with Open, Copy link and Delete.
 * `noteStorage` hears the storage line every answer brings.
 */
export function replaysPart(ctx: Ctx, dialogClose: () => void, say: (text: string, kind?: "ok" | "warn" | "error") => void, noteStorage: (s: StorageView) => void): ReplaysPart {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  const client = account.client;
  const box = h("div", { className: "sd-pane sd-maps sd-replays" });
  let replays: ReplayView[] = [];
  let loading: AbortController | null = null;

  const busy = async (row: HTMLElement, label: string, work: () => Promise<void>) => {
    const cover = w.busy(row, label);
    try { await work(); } catch (err) { say(describeError(err), "error"); } finally { cover.done(); }
  };

  const replace = (r: ReplayView) => {
    const i = replays.findIndex((x) => x.id === r.id);
    if (i >= 0) replays[i] = r; else replays.unshift(r);
    render();
  };

  const copy = async (text: string, done: string) => {
    try { await navigator.clipboard.writeText(text); say(done, "ok"); }
    catch { say(t("The link is {link}", { link: text }), "ok"); }
  };

  const row = (r: ReplayView): HTMLElement => {
    const el = h("div", { className: "sd-map sd-replay", "data-id": r.id });
    const link = r.links[0] ?? null;
    const open = w.button(t("Open"), { primary: true, title: t("Watch it in the replay viewer"), onClick: () => void busy(el, t("Downloading…"), async () => {
      const { bytes } = await client.replayFile(r.id);
      if (await openReplay(ctx, bytes, r, r.links[0] ? { link: replayAddress(ctx, r.links[0].token) } : {})) dialogClose();
    }) });
    const copyLink = w.button(link ? t("Copy link") : t("Make a link"), { title: t("A link anyone can watch this replay with, without signing in"), onClick: () => void busy(el, t("Making the link…"), async () => {
      if (link) { await copy(replayAddress(ctx, link.token), t("The link is on the clipboard.")); return; }
      const res = await client.createReplayLink(r.id);
      replace(res.replay);
      await copy(replayAddress(ctx, res.link.token), t("Link made and copied."));
    }) });
    const unlink = link ? w.button(t("Remove link"), { ghost: true, onClick: async () => {
      if (!(await api.ui.confirm(t("Remove the link to this replay? Anyone who has it can no longer open it. The replay stays on your account."), { title: t("Remove link"), confirmLabel: t("Remove"), danger: true }))) return;
      await busy(el, t("Removing…"), async () => {
        let res: { replay: ReplayView; storage: StorageView } | null = null;
        for (const l of r.links) res = await client.deleteReplayLink(r.id, l.token);
        if (res) { noteStorage(res.storage); replace(res.replay); }
        say(t("Link removed."), "ok");
      });
    } }) : null;
    const del = w.button(t("Delete"), { ghost: true, danger: true, onClick: async () => {
      const question = link
        ? t("Delete this replay from the account? Its link stops working too.")
        : t("Delete this replay from the account?");
      if (!(await api.ui.confirm(question, { title: t("Delete replay"), confirmLabel: t("Delete"), danger: true }))) return;
      await busy(el, t("Deleting…"), async () => {
        const res = await client.deleteReplay(r.id);
        noteStorage(res.storage);
        replays = replays.filter((x) => x.id !== r.id);
        render();
        say(t("Replay deleted."), "ok");
      });
    } });
    const opens = r.links.reduce((n, l) => n + l.opens, 0);
    el.append(
      h("div", { className: "sd-thumb" }, h("span", null, r.matchup || t("replay"))),
      h("div", { className: "sd-map-text" },
        h("div", { className: "sd-name-row" },
          h("span", { className: "sd-name", title: r.mapName }, r.mapName),
          h("span", { className: "sd-when", title: t("Uploaded {date}", { date: formatDate(r.uploadedAt) }) }, ago(r.uploadedAt)),
        ),
        h("div", { className: "sd-sub" }, playersLine(r)),
        h("div", { className: "sd-sub" }, `${factsLine(r)} · ${formatBytes(r.sizeBytes)}`),
        r.note ? h("div", { className: "sd-sub" }, r.note) : null,
        link ? h("div", { className: "sd-badge" }, t("Linked · opened {n}×", { n: opens })) : null,
        h("div", { className: "sd-btns" }, open, copyLink, unlink, del),
      ),
    );
    return el;
  };

  const render = () => {
    clear(box);
    if (!replays.length) {
      box.append(h("div", { className: "sd-empty-state" },
        h("div", { className: "sd-empty-title" }, t("No replays yet")),
        h("div", { className: "sd-hint" }, t("Replays you upload show up here. Each can have a link that anyone can watch it with in their editor, without signing in.")),
        w.button(t("Upload a replay…"), { primary: true, onClick: () => void pick() }),
      ));
      return;
    }
    for (const r of replays) box.append(row(r));
  };

  const pick = async () => {
    const [file] = await api.ui.pickFiles({ accept: ".rep" });
    if (!file) return;
    const cover = w.busy(box, t("Uploading…"));
    try {
      const res = await client.uploadReplay(file, { fileName: file.name });
      noteStorage(res.storage);
      replace(res.replay);
      say(res.existing ? t("That replay is already on your account.") : t("Uploaded {name}.", { name: res.replay.fileName }), "ok");
    } catch (err) { say(describeError(err), "error"); }
    finally { cover.done(); }
  };

  const load = async () => {
    loading?.abort();
    const ac = loading = new AbortController();
    clear(box);
    box.append(w.skeleton({ lines: 4 }));
    try {
      const r = await client.listReplays(ac.signal);
      replays = r.replays;
      noteStorage(r.storage);
      render();
    } catch (err) {
      if (err instanceof ScmjsError && err.code === "aborted") return;
      clear(box);
      box.append(h("div", { className: "sd-empty-list" }, h("div", { className: "sd-bad" }, describeError(err)), w.button(t("Try again"), { onClick: () => void load() })));
    }
  };

  return {
    element: box,
    upload: w.button(t("Upload a replay…"), { title: t("Keep a .rep on your account"), onClick: () => void pick() }),
    load,
    abort: () => loading?.abort(),
  };
}

/* ── The viewer's Share: `scmjs-dev.replays` ──────────────── */

/** The SHA-256 of a replay's bytes in hex, as the server keeps it (`ReplayView.sha256`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** How long the account's list of replays is taken as it stands, between asking where a replay stands and sharing it. */
const LIST_FRESH_MS = 60_000;

/**
 * The service the replay viewer's Share reaches (`contract.d.ts`, `ScmjsReplaysService`): where a replay stands with
 * the account, and its link, signing in, keeping it and making the link as needed. Whether the account has a replay
 * goes by its hash against the account's list, so a replay kept once is never sent again.
 */
export function replaysService(ctx: Ctx): ScmjsReplaysService {
  const { account } = ctx;
  const client = account.client;
  const hashes = new WeakMap<Uint8Array, Promise<string>>();
  let list: { session: string; at: number; replays: Promise<ReplayView[]> } | null = null;

  const hashOf = (bytes: Uint8Array) => {
    let h = hashes.get(bytes);
    if (!h) hashes.set(bytes, (h = sha256Hex(bytes)));
    return h;
  };
  const replays = (fresh: boolean): Promise<ReplayView[]> => {
    const session = account.session();
    if (!fresh && list && list.session === session && Date.now() - list.at < LIST_FRESH_MS) return list.replays;
    const asked = { session, at: Date.now(), replays: client.listReplays().then((r) => { account.noteStorage(r.storage); return r.replays; }) };
    asked.replays.catch(() => { if (list === asked) list = null; });
    list = asked;
    return asked.replays;
  };
  /** The list as it stands after a replay was kept or linked. */
  const note = (r: ReplayView) => {
    if (!list || list.session !== account.session()) return;
    list = { ...list, replays: list.replays.then((all) => [r, ...all.filter((x) => x.id !== r.id)]) };
  };
  const failed = (err: unknown): Error => {
    const e = new Error(describeError(err)) as Error & { code?: string };
    if (err instanceof ScmjsError) e.code = err.code;
    return e;
  };

  return {
    async status(replay: ReplayFile): Promise<ReplayStatus> {
      try {
        // (The ways to sign in come from the server, asked once; a sign-in window is opened at once on the press.)
        if (!account.offers()) await account.connect();
        const offers = account.offers();
        if (offers && offers.replays === false) return { state: "unavailable", reason: t("This server keeps no replays.") };
        if (account.kind() !== "account") return { state: "signed-out", providers: offers?.providers ?? [] };
        const [sha, all] = await Promise.all([hashOf(replay.bytes), replays(true)]);
        const kept = all.find((r) => r.sha256 === sha);
        if (!kept) return { state: "not-kept" };
        return { state: "kept", link: kept.links[0] ? replayAddress(ctx, kept.links[0].token) : null };
      } catch (err) {
        return { state: "unavailable", reason: describeError(err) };
      }
    },

    async link(replay: ReplayFile, provider?: string): Promise<string> {
      try {
        // (Before anything is awaited: the sign-in window opens on the press that asked.)
        if (account.kind() !== "account") await account.signIn(provider);
        const [sha, all] = await Promise.all([hashOf(replay.bytes), replays(false)]);
        const kept = all.find((r) => r.sha256 === sha);
        if (kept?.links[0]) return replayAddress(ctx, kept.links[0].token);
        if (kept) {
          const made = await client.createReplayLink(kept.id);
          note(made.replay);
          return replayAddress(ctx, made.link.token);
        }
        const res = await client.uploadReplay(replay.bytes, { fileName: replay.fileName, link: true });
        account.noteStorage(res.storage);
        note(res.replay);
        const token = res.link?.token ?? res.replay.links[0]?.token ?? (await client.createReplayLink(res.replay.id)).link.token;
        return replayAddress(ctx, token);
      } catch (err) {
        throw failed(err);
      }
    },

    onChange(listener: () => void): () => void {
      // (A sign-in or a sign-out only: the account changes on every answer that carries its storage, this service's own among them.)
      let was = `${account.kind()}:${account.session()}`;
      return account.onChange(() => {
        const now = `${account.kind()}:${account.session()}`;
        if (now === was) return;
        was = now;
        listener();
      });
    },
  };
}
