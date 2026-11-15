/**
 * The moment a replay link opens at: `?t=6:42` on `scmjs.dev/replay/<token>`, which the site sends on to
 * `<editor>/replay/<token>?t=6:42`. `t` is game time at Fastest, `m:ss` or `h:mm:ss`; a bare number is seconds. A `t`
 * that cannot be read is ignored, and the replay opens at its start as a link without one does.
 */

/** The seconds a link's `t` says, or null when it says nothing that can be read. */
export function readMoment(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const s = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):([0-5]\d)|(\d+):([0-5]\d):([0-5]\d))$/.exec(s);
  if (!m) return null;
  return m[1] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[3]) * 3600 + Number(m[4]) * 60 + Number(m[5]);
}

/** The moment on the editor's own address (`?t=`), or null. */
export function momentOnPage(search: string): number | null {
  return readMoment(new URLSearchParams(search).get("t"));
}
