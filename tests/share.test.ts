import { describe, expect, it } from "vitest";
import { inviteFrom, inviteLink, inviteOnPage, WEB_EDITOR_URL } from "../share/link";
import { doing } from "../share/presence";
import { fromBase64, toBase64 } from "../share/shared";

const INVITE = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("invite links", () => {
  it("point at the editor the link was made in, or the web editor from the desktop one", () => {
    expect(inviteLink(INVITE, "https://api.scmjs.dev", { protocol: "https:", origin: "https://editor.scmjs.dev", pathname: "/" })).toBe(`https://editor.scmjs.dev/?scmjs-room=${INVITE}`);
    expect(inviteLink(INVITE, "https://api.scmjs.dev", { protocol: "app:", origin: "app://scmjs", pathname: "/index.html" })).toBe(`${WEB_EDITOR_URL}?scmjs-room=${INVITE}`);
    // A development server travels with the link, so the one who opens it reaches the same server.
    expect(inviteLink(INVITE, "http://localhost:8080", { protocol: "http:", origin: "http://localhost:5173", pathname: "/" })).toBe(`http://localhost:5173/?scmjs-room=${INVITE}&scmjs-server=http%3A%2F%2Flocalhost%3A8080`);
  });

  it("find the invite in whatever was pasted", () => {
    expect(inviteFrom(`  https://editor.scmjs.dev/?scmjs-room=${INVITE}  `)).toBe(INVITE);
    expect(inviteFrom(`Join me: https://editor.scmjs.dev/?a=1&scmjs-room=${INVITE}&b=2`)).toBe(INVITE);
    expect(inviteFrom(INVITE)).toBe(INVITE);
    expect(inviteFrom("https://editor.scmjs.dev/")).toBeNull();
    expect(inviteFrom("hello")).toBeNull();
    expect(inviteOnPage(`?scmjs-room=${INVITE}`)).toBe(INVITE);
    expect(inviteOnPage("?scmjs-room=<script>")).toBeNull();
  });
});

describe("presence", () => {
  it("says which dialog someone is in, in words", () => {
    expect(doing({ px: 0, py: 0, view: null, layer: "terrain", dialog: "triggerEditor" })).toBe("in the Trigger Editor");
    expect(doing({ px: 0, py: 0, view: null, layer: "terrain", dialog: null })).toBe("");
    expect(doing({ px: 0, py: 0, view: null, layer: "terrain", dialog: "preferences" })).toBe("");
  });

  it("carries a map's bytes through base64", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 255);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
