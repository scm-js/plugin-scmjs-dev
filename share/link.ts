/**
 * Invite links. A shared map's link is the editor's own address with `?scmjs-room=<invite>`
 * (and the `?scmjs-server=` a development build is pointed at, so the link reaches the same
 * server); opening it starts the editor with the Join dialog up. Anything the user pastes —
 * the link, the link with more around it, or the bare invite — comes back to the invite.
 */
import { DEFAULT_SERVER_URL, SERVER_QUERY } from "../account";

export const ROOM_QUERY = "scmjs-room";

/** Where the web editor lives, for a link made in the desktop editor (whose own address is `app://`). */
export const WEB_EDITOR_URL = "https://editor.scmjs.dev/";

/** An invite is URL-safe base64, 24 characters. */
const INVITE = /^[A-Za-z0-9_-]{16,64}$/;

export function inviteLink(invite: string, serverUrl: string, where: { protocol: string; origin: string; pathname: string } | null): string {
  const base = where && (where.protocol === "http:" || where.protocol === "https:") ? `${where.origin}${where.pathname}` : WEB_EDITOR_URL;
  const params = new URLSearchParams({ [ROOM_QUERY]: invite });
  if (serverUrl.replace(/\/+$/, "") !== DEFAULT_SERVER_URL) params.set(SERVER_QUERY, serverUrl);
  return `${base}?${params.toString()}`;
}

/** The invite in what was pasted, or null. */
export function inviteFrom(text: string): string | null {
  const t = text.trim();
  if (INVITE.test(t)) return t;
  const m = /[?&]scmjs-room=([A-Za-z0-9_-]{16,64})/.exec(t);
  return m ? m[1]! : null;
}

/** The invite on the editor's own address, if it was opened from a link. */
export function inviteOnPage(search: string): string | null {
  const v = new URLSearchParams(search).get(ROOM_QUERY);
  return v && INVITE.test(v) ? v : null;
}
