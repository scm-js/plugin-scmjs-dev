/**
 * Invite links. A shared map's link is the editor's own address with `share/<invite>` on the
 * end (and the `?scmjs-server=` a development build is pointed at, so the link reaches the
 * same server); opening it starts the editor with the Join dialog up. The editor answers any
 * path with its one page (GitHub Pages through 404.html, nginx and Vite through a fallback),
 * so nothing needs to exist at that path. Anything the user pastes — the link, the link with
 * more around it, or the bare invite — comes back to the invite.
 */
import { DEFAULT_SERVER_URL, SERVER_QUERY } from "../account";

/** Where the web editor lives, for a link made in the desktop editor (whose own address is `app://`). */
export const WEB_EDITOR_URL = "https://editor.scmjs.dev/";

/** An invite is URL-safe base64, 24 characters. */
const INVITE = /^[A-Za-z0-9_-]{16,64}$/;

/** `<base>share/<invite>`, with or without a trailing slash; group 1 is the base, group 2 the invite. */
const SHARE_PATH = /^(.*\/)share\/([A-Za-z0-9_-]{16,64})\/?$/;

/** The path the editor is served from: the page's path less a `share/<invite>` or a file name on the end. */
export function editorBase(pathname: string): string {
  const m = SHARE_PATH.exec(pathname);
  if (m) return m[1]!;
  return pathname.replace(/[^/]*$/, "") || "/";
}

export function inviteLink(invite: string, serverUrl: string, where: { protocol: string; origin: string; pathname: string } | null): string {
  const base = where && (where.protocol === "http:" || where.protocol === "https:") ? `${where.origin}${editorBase(where.pathname)}` : WEB_EDITOR_URL;
  const query = serverUrl.replace(/\/+$/, "") !== DEFAULT_SERVER_URL ? `?${new URLSearchParams({ [SERVER_QUERY]: serverUrl }).toString()}` : "";
  return `${base}share/${invite}${query}`;
}

/** The invite in what was pasted, or null. */
export function inviteFrom(text: string): string | null {
  const t = text.trim();
  if (INVITE.test(t)) return t;
  const m = /\/share\/([A-Za-z0-9_-]{16,64})(?![A-Za-z0-9_-])/.exec(t);
  return m ? m[1]! : null;
}

/** The invite on the editor's own address, if it was opened from a link. */
export function inviteOnPage(pathname: string): string | null {
  return SHARE_PATH.exec(pathname)?.[2] ?? null;
}
