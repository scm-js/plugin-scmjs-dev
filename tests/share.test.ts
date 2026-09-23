import { describe, expect, it } from "vitest";
import { copyLink, copyTokenFrom, copyTokenOnPage, editorBase, inviteFrom, inviteLink, inviteOnPage, WEB_EDITOR_URL } from "../share/link";
import { doing } from "../share/presence";
import { fromBase64, toBase64 } from "../share/shared";

const INVITE = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("invite links", () => {
  it("point at the editor the link was made in, or the web editor from the desktop one", () => {
    expect(inviteLink(INVITE, "https://api.scmjs.dev", { protocol: "https:", origin: "https://editor.scmjs.dev", pathname: "/" })).toBe(`https://editor.scmjs.dev/share/${INVITE}`);
    expect(inviteLink(INVITE, "https://api.scmjs.dev", { protocol: "https:", origin: "https://nightly.editor.scmjs.dev", pathname: `/share/${INVITE}` })).toBe(`https://nightly.editor.scmjs.dev/share/${INVITE}`);
    expect(inviteLink(INVITE, "https://api.scmjs.dev", { protocol: "https:", origin: "https://someone.github.io", pathname: "/scm-js/index.html" })).toBe(`https://someone.github.io/scm-js/share/${INVITE}`);
    expect(inviteLink(INVITE, "https://api.scmjs.dev", { protocol: "app:", origin: "app://scmjs", pathname: "/index.html" })).toBe(`${WEB_EDITOR_URL}share/${INVITE}`);
    // A development server travels with the link, so the one who opens it reaches the same server.
    expect(inviteLink(INVITE, "http://localhost:8080", { protocol: "http:", origin: "http://localhost:5173", pathname: "/" })).toBe(`http://localhost:5173/share/${INVITE}?scmjs-server=http%3A%2F%2Flocalhost%3A8080`);
  });

  it("find the invite in whatever was pasted", () => {
    expect(inviteFrom(`  https://editor.scmjs.dev/share/${INVITE}  `)).toBe(INVITE);
    expect(inviteFrom(INVITE)).toBe(INVITE);
    expect(inviteFrom(`https://nightly.editor.scmjs.dev/share/${INVITE}`)).toBe(INVITE);
    expect(inviteFrom(`Join me: https://editor.scmjs.dev/share/${INVITE}/?scmjs-server=x there`)).toBe(INVITE);
    expect(inviteFrom("https://editor.scmjs.dev/")).toBeNull();
    expect(inviteFrom("hello")).toBeNull();
    expect(inviteOnPage(`/share/${INVITE}`)).toBe(INVITE);
    expect(inviteOnPage(`/scm-js/share/${INVITE}/`)).toBe(INVITE);
    expect(inviteOnPage("/share/<script>")).toBeNull();
    expect(inviteOnPage("/")).toBeNull();
    expect(editorBase(`/scm-js/share/${INVITE}`)).toBe("/scm-js/");
    expect(editorBase("/index.html")).toBe("/");
    expect(editorBase("/")).toBe("/");
  });
});

describe("copy links", () => {
  it("are map/<token> beside share/<invite>, and each page path is read as the one it is", () => {
    expect(copyLink(INVITE, "https://api.scmjs.dev", { protocol: "https:", origin: "https://editor.scmjs.dev", pathname: `/share/${INVITE}` })).toBe(`https://editor.scmjs.dev/map/${INVITE}`);
    expect(copyLink(INVITE, "https://api.scmjs.dev", { protocol: "app:", origin: "app://scmjs", pathname: "/index.html" })).toBe(`${WEB_EDITOR_URL}map/${INVITE}`);
    expect(copyLink(INVITE, "http://localhost:8080", { protocol: "http:", origin: "http://localhost:5173", pathname: "/" })).toBe(`http://localhost:5173/map/${INVITE}?scmjs-server=http%3A%2F%2Flocalhost%3A8080`);
    expect(copyTokenOnPage(`/map/${INVITE}`)).toBe(INVITE);
    expect(copyTokenOnPage(`/scm-js/map/${INVITE}/`)).toBe(INVITE);
    expect(copyTokenOnPage(`/share/${INVITE}`)).toBeNull();
    expect(inviteOnPage(`/map/${INVITE}`)).toBeNull();
    expect(editorBase(`/scm-js/map/${INVITE}`)).toBe("/scm-js/");
    expect(copyTokenFrom(`Try this: https://editor.scmjs.dev/map/${INVITE}?scmjs-server=x`)).toBe(INVITE);
    expect(copyTokenFrom(INVITE)).toBe(INVITE);
    expect(copyTokenFrom(`https://editor.scmjs.dev/share/${INVITE}`)).toBeNull();
  });
});

describe("presence", () => {
  it("says which dialog someone is in, in words", () => {
    expect(doing({ px: 0, py: 0, view: null, layer: "terrain", dialog: "triggerEditor" })).toBe("in the Trigger Editor");
    expect(doing({ px: 0, py: 0, view: null, layer: "terrain", dialog: null })).toBe("");
    expect(doing({ px: 0, py: 0, view: null, layer: "terrain", dialog: "preferences" })).toBe("");
    expect(doing({ px: 0, py: 0, view: null, layer: "terrain", dialog: "gameData" })).toBe("in Game Data (getting the game's graphics)");
  });

  it("carries a map's bytes through base64", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 255);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
