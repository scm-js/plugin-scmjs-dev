/**
 * The plugin's words in the editor's language. `bindI18n(api)` at activation registers
 * the Korean catalogue (`ko.ts`) and points `t` / `tc` at `api.i18n`; before that — and
 * in the tests, which run the modules without an editor — they fill the English in with
 * the same message grammar the editor uses (`{name}`, `{n, plural, …}`, `{x, select, …}`,
 * `{name|을}`).
 *
 * The English text is the key, always a literal at the call, so `tests/ko.test.ts` can
 * read every key out of the source. A string kept in a table — or handed to the editor
 * to translate at draw time, as menu labels and command titles are — is marked with
 * `msg("…")` where it is written and shown with `translate(value)`.
 *
 * Never call `t()` at module scope: it would run before the catalogue is registered and
 * never follow a change of language.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { KO } from "./ko";

export type Params = Record<string, string | number>;

let bound: PluginApi | null = null;

/** Registers the catalogue and routes `t` through the editor. Returns the registration's disposer. */
export function bindI18n(api: PluginApi): () => void {
  // An editor from before `api.i18n` shows the English.
  if (!(api as Partial<PluginApi>).i18n) return () => {};
  bound = api;
  const reg = api.i18n.register({ ko: KO });
  return () => { reg.dispose(); if (bound === api) bound = null; };
}

/** The text in the editor's language, its placeholders filled. */
export function t(text: string, params?: Params): string {
  return bound ? bound.i18n.t(text, params) : format(text, params);
}

/** `t` with a context, for the same English meant two ways. */
export function tc(context: string, text: string, params?: Params): string {
  return bound ? bound.i18n.tc(context, text, params) : format(text, params);
}

/** Marks a string kept in a table (or given to the editor to translate) without translating it here. */
export function msg(text: string): string {
  return text;
}

/** Shows a string that was marked with `msg()`. */
export function translate(text: string, params?: Params): string {
  return t(text, params);
}

/** The editor's language (`"en"`, `"ko"`), for the few places that format dates or numbers. */
export function language(): string {
  return bound?.i18n.language ?? "en";
}

/* ── English fallback: the editor's message grammar ─────── */

function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

export function format(message: string, params: Params | undefined): string {
  if (!message.includes("{")) return message;
  let out = "";
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf("{", i);
    if (open < 0) { out += message.slice(i); break; }
    const close = matchBrace(message, open);
    if (close < 0) { out += message.slice(i); break; }
    out += message.slice(i, open) + placeholder(message.slice(open + 1, close), params);
    i = close + 1;
  }
  return out;
}

function placeholder(inner: string, params: Params | undefined): string {
  const comma = inner.indexOf(",");
  if (comma < 0) {
    const bar = inner.indexOf("|");
    const value = params?.[(bar < 0 ? inner : inner.slice(0, bar)).trim()];
    return value === undefined ? `{${inner}}` : String(value);
  }
  const name = inner.slice(0, comma).trim();
  const rest = inner.slice(comma + 1);
  const comma2 = rest.indexOf(",");
  if (comma2 < 0) return `{${inner}}`;
  const kind = rest.slice(0, comma2).trim();
  const branches = parseBranches(rest.slice(comma2 + 1));
  const value = params?.[name];
  if (value === undefined) return `{${inner}}`;
  if (kind === "plural" && typeof value === "number") {
    const branch = branches.get(`=${value}`) ?? branches.get(new Intl.PluralRules("en").select(value)) ?? branches.get("other");
    return branch === undefined ? `{${inner}}` : format(branch.replace(/#/g, new Intl.NumberFormat("en").format(value)), params);
  }
  if (kind === "select") {
    const branch = branches.get(String(value)) ?? branches.get("other");
    return branch === undefined ? `{${inner}}` : format(branch, params);
  }
  return `{${inner}}`;
}

function parseBranches(options: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < options.length) {
    const open = options.indexOf("{", i);
    if (open < 0) break;
    const close = matchBrace(options, open);
    if (close < 0) break;
    const key = options.slice(i, open).trim();
    if (key) out.set(key, options.slice(open + 1, close));
    i = close + 1;
  }
  return out;
}
