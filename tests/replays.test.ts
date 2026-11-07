import { describe, expect, it } from "vitest";
import { ScmjsClient } from "../client";
import type { PublicReplayView, ReplayResponse } from "../protocol";
import { factsLine, formatLength, openAsDropped, playersLine } from "../replays";
import type { Ctx } from "../ui";

const FACTS: PublicReplayView = {
  token: "Qy2kqoBd5UCkc13EmPIFTajs", fileName: "legacy_cp949.rep", sizeBytes: 154392, note: "", uploadedAt: "2026-11-07T07:35:02.124Z",
  mapName: "투혼 1.3", mapWidth: 128, mapHeight: 128,
  players: [{ name: "Question", race: "protoss", team: 1, color: "#0c48cc" }, { name: "Drywater", race: "terran", team: 2, color: "#703014" }],
  matchup: "PvT", frames: 14482, durationSec: 608, gameType: 2, gameTypeName: "Melee", title: "441", playedAt: "2013-01-12T17:25:06.000Z", format: "legacy",
};

describe("replays", () => {
  it("say who played, how long and when", () => {
    expect(playersLine(FACTS)).toBe("Question (P) vs Drywater (T)");
    expect(playersLine({ players: [{ name: "A", race: "zerg", team: 0, color: "#000000" }, { name: "B", race: null, team: 0, color: "#000000" }, { name: "C", race: "terran", team: 0, color: "#000000" }] })).toBe("A (Z) vs B (?) vs C (T)");
    expect(playersLine({ players: [{ name: "A", race: "zerg", team: 1, color: "" }, { name: "B", race: "zerg", team: 1, color: "" }, { name: "C", race: "terran", team: 2, color: "" }] })).toBe("A (Z) & B (Z) vs C (T)");
    expect(formatLength(608)).toBe("10:08");
    expect(formatLength(3909)).toBe("1:05:09");
    expect(factsLine(FACTS)).toMatch(/^PvT · 10:08 · Melee · played .*2013$/);
  });

  it("upload as one multipart request, and a link is looked up without the session", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const answer: ReplayResponse = { replay: { ...FACTS, id: "r1", sha256: "x", links: [] }, storage: { usedBytes: 1, capBytes: 2, maps: 0, revisions: 0, replays: 1 } };
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(input), init });
      return new Response(JSON.stringify(String(input).includes("/replay-links/") ? { replay: FACTS } : answer), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new ScmjsClient(() => ({ serverUrl: "https://api.example", session: "sess_1" }), fetchImpl);
    await client.uploadReplay(new Uint8Array([1, 2, 3]), { fileName: "game.rep", note: "gg", link: true });
    const form = sent[0]!.init.body as FormData;
    expect(sent[0]!.url).toBe("https://api.example/v1/replays");
    expect((form.get("file") as File).name).toBe("game.rep");
    expect(form.get("fileName")).toBe("game.rep");
    expect(form.get("note")).toBe("gg");
    expect(form.get("link")).toBe("1");
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sess_1");
    const found = await client.linkedReplay(FACTS.token);
    expect(found.replay.matchup).toBe("PvT");
    expect(sent[1]!.url).toBe(`https://api.example/v1/replay-links/${FACTS.token}`);
    expect(sent[1]!.init.headers).toBeUndefined();
  });

  it("wait for the replay viewer, and say when there is none", async () => {
    let has = false;
    const ctx = { api: { commands: { has: (id: string) => has && id === "aftermath.open-replay" } } } as unknown as Ctx;
    expect(await openAsDropped(ctx, new Uint8Array([1]), "game.rep", 0)).toBe("no-viewer");
    has = true;
    // No DataTransfer outside a browser: the replay cannot be dropped.
    expect(await openAsDropped(ctx, new Uint8Array([1]), "game.rep", 0)).toBe("no-drop");
  });
});
