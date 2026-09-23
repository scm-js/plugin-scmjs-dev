/**
 * The links the plugin hands out. A shared map's is the editor's own address with
 * `share/<invite>` on the end, a copy link's `map/<token>` (and either carries the
 * `?scmjs-server=` a development build is pointed at, so the link reaches the same server);
 * opening one starts the editor with the Join dialog, or the Open a Copy dialog, up. The
 * editor answers any path with its one page (GitHub Pages through 404.html, nginx and Vite
 * through a fallback), so nothing needs to exist at that path. Anything the user pastes —
 * the link, the link with more around it, or the bare invite — comes back to the invite.
 */
import { DEFAULT_SERVER_URL, SERVER_QUERY } from "../account";

/** Where the web editor lives, for a link made in the desktop editor (whose own address is `app://`). */
export const WEB_EDITOR_URL = "https://editor.scmjs.dev/";

/** An invite is URL-safe base64, 24 characters. */
const INVITE = /^[A-Za-z0-9_-]{16,64}$/;

/** `<base>share/<invite>` or `<base>map/<token>`, with or without a trailing slash; group 1 is the base, group 2 the kind, group 3 the token. */
const LINK_PATH = /^(.*\/)(share|map)\/([A-Za-z0-9_-]{16,64})\/?$/;

/** The path the editor is served from: the page's path less a `share/<invite>`, a `map/<token>` or a file name on the end. */
export function editorBase(pathname: string): string {
  const m = LINK_PATH.exec(pathname);
  if (m) return m[1]!;
  return pathname.replace(/[^/]*$/, "") || "/";
}

type Where = { protocol: string; origin: string; pathname: string } | null;

function linkTo(kind: "share" | "map", token: string, serverUrl: string, where: Where): string {
  const base = where && (where.protocol === "http:" || where.protocol === "https:") ? `${where.origin}${editorBase(where.pathname)}` : WEB_EDITOR_URL;
  const query = serverUrl.replace(/\/+$/, "") !== DEFAULT_SERVER_URL ? `?${new URLSearchParams({ [SERVER_QUERY]: serverUrl }).toString()}` : "";
  return `${base}${kind}/${token}${query}`;
}

export function inviteLink(invite: string, serverUrl: string, where: Where): string {
  return linkTo("share", invite, serverUrl, where);
}

/** A copy link: `<editor>/map/<token>`. */
export function copyLink(token: string, serverUrl: string, where: Where): string {
  return linkTo("map", token, serverUrl, where);
}

/** The invite in what was pasted, or null. */
export function inviteFrom(text: string): string | null {
  const t = text.trim();
  if (INVITE.test(t)) return t;
  const m = /\/share\/([A-Za-z0-9_-]{16,64})(?![A-Za-z0-9_-])/.exec(t);
  return m ? m[1]! : null;
}

/** The copy link's token in what was pasted, or null. */
export function copyTokenFrom(text: string): string | null {
  const t = text.trim();
  if (INVITE.test(t)) return t;
  const m = /\/map\/([A-Za-z0-9_-]{16,64})(?![A-Za-z0-9_-])/.exec(t);
  return m ? m[1]! : null;
}

/** The invite on the editor's own address, if it was opened from a shared map's link. */
export function inviteOnPage(pathname: string): string | null {
  const m = LINK_PATH.exec(pathname);
  return m?.[2] === "share" ? m[3]! : null;
}

/** The token on the editor's own address, if it was opened from a copy link. */
export function copyTokenOnPage(pathname: string): string | null {
  const m = LINK_PATH.exec(pathname);
  return m?.[2] === "map" ? m[3]! : null;
}

/** Put the address back to the editor's own, so a reload opens the editor and not the link again. */
export function forgetLinkOnPage(): void {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  const url = new URL(location.href);
  url.pathname = editorBase(url.pathname);
  history.replaceState(history.state, "", url.toString());
}
