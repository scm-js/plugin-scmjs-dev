/**
 * Plain DOM for the dialogs: a small `h()` builder, a scoped stylesheet for the few
 * layouts the editor's widget kit does not carry (the account head, the storage bar,
 * the ledger table, the map list with its thumbnails), and the shared context every
 * dialog takes. Everything that waits — buttons that start a request, the status line,
 * the grey rows standing in for a list on its way — is `api.ui.widgets`, so the dialogs
 * wait the way the editor's own do.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { AccountManager } from "./account";

export interface Ctx {
  api: PluginApi;
  account: AccountManager;
  openAccount: () => void;
  openMaps: () => void;
  saveToCloud: () => void;
}

export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") el.className = String(v);
      else if (k === "style") el.setAttribute("style", String(v));
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const STYLE = `
.sd { display: flex; flex-direction: column; gap: 10px; font-size: 12px; min-width: 0; }
.sd .sd-hint { color: var(--text-faint, #6b7382); font-size: 11px; line-height: 1.45; }
.sd .sd-bad { color: #ff9f7a; }
.sd .sd-ok { color: var(--teal, #4fd1c5); }
.sd .sd-btns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sd .sd-head { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: baseline; }
.sd .sd-head .sd-k { color: var(--text-dim, #99a2b3); }
.sd .sd-head .sd-v { color: var(--text, #e6e9ef); }
.sd .sd-big { font-size: 15px; color: var(--gold, #e6b95c); }
.sd .sd-bar { height: 8px; border-radius: 4px; background: var(--bg-0, #0f1115); border: 1px solid var(--border, #333); overflow: hidden; }
.sd .sd-bar > i { display: block; height: 100%; background: var(--teal, #4fd1c5); transition: width 200ms; }
.sd .sd-bar.sd-full > i { background: #ff9f7a; }
.sd table.sd-ledger { width: 100%; border-collapse: collapse; font-size: 11px; }
.sd table.sd-ledger th { text-align: left; color: var(--text-dim, #99a2b3); font-weight: normal; padding: 2px 6px; border-bottom: 1px solid var(--border, #333); }
.sd table.sd-ledger td { padding: 2px 6px; border-bottom: 1px solid var(--border, #222); white-space: nowrap; }
.sd table.sd-ledger td.sd-num { text-align: right; font-variant-numeric: tabular-nums; }
.sd table.sd-ledger td.sd-note { white-space: normal; color: var(--text-dim, #99a2b3); }
.sd .sd-scroll { max-height: 40vh; overflow: auto; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-1, #14171d); }
.sd .sd-maps { display: flex; flex-direction: column; }
.sd .sd-map { display: grid; grid-template-columns: 64px 1fr auto; gap: 8px 10px; padding: 6px 8px; border-bottom: 1px solid var(--border, #222); cursor: pointer; align-items: center; }
.sd .sd-map:hover { background: var(--bg-2, #1b1f27); }
.sd .sd-map.sd-picked { background: var(--bg-2, #1b1f27); outline: 1px solid var(--teal, #4fd1c5); outline-offset: -1px; }
.sd .sd-thumb { width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; background: var(--bg-0, #0f1115); border: 1px solid var(--border, #333); border-radius: 3px; overflow: hidden; }
.sd .sd-thumb img { max-width: 100%; max-height: 100%; image-rendering: pixelated; }
.sd .sd-thumb span { color: var(--text-faint, #6b7382); font-size: 10px; }
.sd .sd-map .sd-name { color: var(--text, #e6e9ef); font-weight: 600; }
.sd .sd-map .sd-sub { color: var(--text-dim, #99a2b3); font-size: 11px; line-height: 1.4; }
.sd .sd-map .sd-when { color: var(--text-faint, #6b7382); font-size: 11px; text-align: right; }
.sd .sd-revs { display: flex; flex-direction: column; }
.sd .sd-rev { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; padding: 5px 8px; border-bottom: 1px solid var(--border, #222); align-items: baseline; }
.sd .sd-rev.sd-picked { background: var(--bg-2, #1b1f27); outline: 1px solid var(--teal, #4fd1c5); outline-offset: -1px; }
.sd .sd-rev:hover { background: var(--bg-2, #1b1f27); cursor: pointer; }
.sd .sd-rev .sd-n { color: var(--gold, #e6b95c); font-variant-numeric: tabular-nums; }
.sd .sd-rev .sd-note-text { color: var(--text, #e6e9ef); white-space: pre-wrap; }
.sd .sd-rev .sd-note-text.sd-empty { color: var(--text-faint, #6b7382); font-style: italic; }
.sd .sd-rev .sd-sub { color: var(--text-dim, #99a2b3); font-size: 11px; grid-column: 2; }
.sd textarea { width: 100%; box-sizing: border-box; min-height: 56px; resize: vertical; font: inherit; background: var(--bg-0, #0f1115); color: var(--text, #e6e9ef); border: 1px solid var(--border, #333); border-radius: 4px; padding: 6px; }
.sd .sd-split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
.sd .sd-empty-list { padding: 18px 8px; text-align: center; color: var(--text-faint, #6b7382); }
`;

/** The dialog's root: a `.sd` box with the stylesheet, appended to the body once. */
export function styled(body: HTMLElement): HTMLDivElement {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const root = h("div", { className: "sd" });
  body.append(style, root);
  return root;
}

export function textarea(props: { value?: string; placeholder?: string; rows?: number }): HTMLTextAreaElement {
  const el = h("textarea", { placeholder: props.placeholder ?? "", rows: props.rows ?? 3 });
  el.value = props.value ?? "";
  return el;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function shortDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** `4 days ago`, `yesterday`, `just now` — for the map list. */
export function ago(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.round(hrs / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.round(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}
