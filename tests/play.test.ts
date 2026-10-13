// Tools ▸ Test Map in Browser is offered only where the site's play page is beside the editor (`play.ts`).
import { describe, expect, it } from "vitest";
import { playAddress } from "../play";

describe("where the play page is", () => {
  it("is beside the editor on scmjs.dev", () => {
    expect(playAddress({ origin: "https://scmjs.dev", hostname: "scmjs.dev", pathname: "/editor/" })).toBe("https://scmjs.dev/play/");
  });
  it("is beside a stand-in for the site on one's own machine", () => {
    expect(playAddress({ origin: "http://127.0.0.1:5180", hostname: "127.0.0.1", pathname: "/editor/" })).toBe("http://127.0.0.1:5180/play/");
  });
  it("is nowhere for a dev server, the nightly, the desktop app or an editor hosted elsewhere", () => {
    expect(playAddress({ origin: "http://localhost:5173", hostname: "localhost", pathname: "/" })).toBeNull();
    expect(playAddress({ origin: "https://nightly.editor.scmjs.dev", hostname: "nightly.editor.scmjs.dev", pathname: "/" })).toBeNull();
    expect(playAddress({ origin: "file://", hostname: "", pathname: "/C:/app/index.html" })).toBeNull();
    expect(playAddress({ origin: "https://example.org", hostname: "example.org", pathname: "/editor/" })).toBeNull();
  });
});
