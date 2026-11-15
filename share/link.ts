/**
 * The links the plugin hands out. A shared map's is the editor's own address with
 * `share/<invite>` on the end, a copy link's `map/<token>`, a replay link's `replay/<token>` (on the site the
 * site's own, `scmjs.dev/replay/<token>`, which the site sends on to the editor's; see `replayLink`) (and each carries the
 * `?scmjs-server=` a development build is pointed at, so the link reaches the same server);
 * opening one starts the editor with the Join dialog, or the Open a Copy dialog, up. The
 * editor answers any path with its one page (GitHub Pages through 404.html, nginx and Vite
 * through a fallback), so nothing needs to exist at that path. Anything the user pastes —
 * the link, the link with more around it, or the bare invite — comes back to the invite.
 */
import { DEFAULT_SERVER_URL, SERVER_QUERY } from "../account";

/** Where the web editor lives, for a link made in the desktop editor (whose own address is `app://`). */
export const WEB_EDITOR_URL = "https://scmjs.dev/editor/";

/** An invite is URL-safe base64, 24 characters. */
const INVITE = /^[A-Za-z0-9_-]{16,64}$/;

/** `<base>share/<invite>`, `<base>map/<token>` or `<base>replay/<token>`, with or without a trailing slash; group 1 is the base, group 2 the kind, group 3 the token. */
const LINK_PATH = /^(.*\/)(share|map|replay)\/([A-Za-z0-9_-]{16,64})\/?$/;

/** The path the editor is served from: the page's path less a `share/<invite>`, a `map/<token>`, a `replay/<token>` or a file name on the end. */
export function editorBase(pathname: string): string {
  const m = LINK_PATH.exec(pathname);
  if (m) return m[1]!;
  return pathname.replace(/[^/]*$/, "") || "/";
}

type Where = { protocol: string; origin: string; pathname: string } | null;

function linkTo(kind: "share" | "map" | "replay", token: string, serverUrl: string, where: Where): string {
  const base = where && (where.protocol === "http:" || where.protocol === "https:") ? `${where.origin}${editorBase(where.pathname)}` : WEB_EDITOR_URL;
  return `${base}${kind}/${token}${serverQuery(serverUrl)}`;
}

/** `?scmjs-server=…` for a server other than scmjs.dev's, so the link reaches the same one; empty for scmjs.dev's. */
function serverQuery(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "") !== DEFAULT_SERVER_URL ? `?${new URLSearchParams({ [SERVER_QUERY]: serverUrl }).toString()}` : "";
}

export function inviteLink(invite: string, serverUrl: string, where: Where): string {
  return linkTo("share", invite, serverUrl, where);
}

/** A copy link: `<editor>/map/<token>`. */
export function copyLink(token: string, serverUrl: string, where: Where): string {
  return linkTo("map", token, serverUrl, where);
}

/**
 * A replay link. On the site (the editor at `<origin>/editor/`) and in the desktop editor it is the site's own,
 * `https://scmjs.dev/replay/<token>`, which the site sends on to the analysis, or to the play page when it says to play
 * from a moment; anywhere else (the nightly, a development server) the editor's own, `<editor>/replay/<token>`.
 */
export function replayLink(token: string, serverUrl: string, where: Where): string {
  const web = !!where && (where.protocol === "http:" || where.protocol === "https:");
  const base = web ? editorBase(where.pathname) : null;
  if (base !== null && !base.endsWith("/editor/")) return linkTo("replay", token, serverUrl, where);
  const site = base !== null ? `${where!.origin}${base.slice(0, -"editor/".length)}` : `${new URL(WEB_EDITOR_URL).origin}/`;
  return `${site}replay/${token}${serverQuery(serverUrl)}`;
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

/** The token on the editor's own address, if it was opened from a replay link. */
export function replayTokenOnPage(pathname: string): string | null {
  const m = LINK_PATH.exec(pathname);
  return m?.[2] === "replay" ? m[3]! : null;
}

/**
 * The editor's own address for one opened from a link: the link's path taken off, and the moment a replay link
 * opened at (`t`, and `play`, which only the play page reads), so a reload opens the editor and not the link again.
 */
export function editorAddress(href: string): string {
  const url = new URL(href);
  url.pathname = editorBase(url.pathname);
  url.searchParams.delete("t");
  url.searchParams.delete("play");
  return url.toString();
}

/** Put the address back to the editor's own (`editorAddress`). */
export function forgetLinkOnPage(): void {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  history.replaceState(history.state, "", editorAddress(location.href));
}
