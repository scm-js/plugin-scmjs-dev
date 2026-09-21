/**
 * What the toolkit's triggers *do*, run through the editor's parser and TrigScript's trigger
 * interpreter (`helpers/play.ts`) — `ums.test.ts` beside this one reads their text.
 *
 * `owed` is a test of behaviour the toolkit does not have yet: the claim is written the way
 * it will be true, and today it has to fail *as an assertion* — a harness that throws, or a
 * builder that stops building, is a real failure, not the expected one. The day the claim
 * holds the test says so, and `owed(` becomes `it(` with the arrangement folded in.
 */
import { describe, expect, it } from "vitest";
import { buildSystem, DEFAULT_DC_UNITS, waitingOn, type BuiltSystem, type ToolkitContext } from "../ai/ums";
import { ActionType, ConditionType, parse, play } from "./helpers/play";

const SPOTS = Array.from({ length: 16 }, (_, i) => `Spot ${i + 1}`);
const LOCATIONS = ["Start", "Checkpoint 1", "Checkpoint 2", "Finish", ...SPOTS];
const ctx: ToolkitContext = { humans: [1, 2], computers: [8], hyper: true, dcUnits: DEFAULT_DC_UNITS, locations: LOCATIONS };

function owed<T>(name: string, fix: string, arrange: () => T, claim: (got: T) => void) {
  it(`${name} [owed: ${fix}]`, () => {
    const got = arrange();
    let failure: unknown = null;
    try { claim(got); } catch (err) { failure = err; }
    if (failure === null) throw new Error(`This holds now — make it a plain test (${fix}).`);
    if ((failure as Error).name !== "AssertionError") throw failure;
  });
}

const created = (b: BuiltSystem) => parse(b.text, LOCATIONS)
  .map((t) => t.actions.filter((x) => x.type === ActionType.CreateUnit).map((x) => LOCATIONS[x.location - 1]))
  .filter((spots) => spots.length > 0);

describe("the harness", () => {
  it("runs the toolkit's text: a checkpoint is recorded and a lost runner comes back there", () => {
    const b = buildSystem("checkpoints", { unit: "Zerg Zergling", start: "Start", checkpoints: "Checkpoint 1, Checkpoint 2" }, ctx);
    const game = play(b.text, { players: [1, 2], locations: LOCATIONS, units: [{ type: "Zerg Zergling", owner: 1, at: "Checkpoint 1" }] }, 1);
    expect(game.death(1, b.dcUsed[0])).toBe(1);
    expect(game.units(2, "Zerg Zergling")).toBe(1);
    game.kill(1);
    game.run(1);
    expect(game.units(1, "Zerg Zergling")).toBe(1);
    expect(game.sim.game.living().find((u) => u.owner === 0)?.x).toBe(125);
    expect(game.results()).toEqual([]);
  });
});

describe("what the toolkit owes", () => {
  owed("waves are won when the wave is dead, though the enemy keeps a unit", "1b",
    () => {
      const b = buildSystem("waves", { spawn: "Start", goal: "Finish", units: "Zerg Zergling", waves: "1", interval: "5" }, ctx);
      // Elapsed time is not the interpreter's to know; every wave is due.
      const game = play(b.text, { players: [1, 2, 8], locations: LOCATIONS, units: [{ type: "Zerg Overlord", owner: 8 }], condition: (c) => (c.type === ConditionType.ElapsedTime ? true : undefined) }, 1);
      expect(game.units(8, "Zerg Zergling")).toBe(6);
      expect(game.results()).toEqual([]);
      game.kill(8, "Zerg Zergling");
      game.run(1);
      return game;
    },
    (game) => expect(game.results().map((r) => `${r.player} ${r.result}`)).toEqual(["1 victory", "2 victory"]));

  owed("no obstacle trigger holds more actions than the game reads", "1d",
    () => buildSystem("obstacles", { spots: SPOTS.join(","), groups: "8" }, { ...ctx, humans: [1, 2, 3, 4, 5, 6, 7] }),
    (b) => expect(() => parse(b.text, LOCATIONS)).not.toThrow());

  owed("a short last group of obstacles is short, not wrapped round to the first spot", "1d",
    () => created(buildSystem("obstacles", { spots: SPOTS.slice(0, 5).join(","), groups: "2" }, ctx)),
    (groups) => expect(groups).toEqual([["Spot 1", "Spot 4"], ["Spot 2", "Spot 5"], ["Spot 3"]]));

  owed("a checkpoint does not count before the one ahead of it", "1e",
    () => {
      const b = buildSystem("checkpoints", { unit: "Zerg Zergling", start: "Start", checkpoints: "Checkpoint 1, Checkpoint 2" }, ctx);
      return { b, game: play(b.text, { players: [1, 2], locations: LOCATIONS, units: [{ type: "Zerg Zergling", owner: 1, at: "Checkpoint 2" }] }, 1) };
    },
    ({ b, game }) => expect(game.death(1, b.dcUsed[0])).toBe(0));

  owed("two runners at the finish in one cycle both get a result", "1e",
    () => {
      const b = buildSystem("checkpoints", { unit: "Zerg Zergling", start: "Start", checkpoints: "Checkpoint 1, Checkpoint 2", finish: "Finish" }, ctx);
      const at = { type: "Zerg Zergling", at: "Finish" };
      return play(b.text, { players: [1, 2], locations: LOCATIONS, units: [{ ...at, owner: 1 }, { ...at, owner: 2 }], deaths: [[1, b.dcUsed[0], 2], [2, b.dcUsed[0], 2]] }, 4);
    },
    (game) => expect(game.results().map((r) => `${r.player} ${r.result}`).sort()).toEqual(["1 victory", "2 victory"]));

  owed("a system waits on a location named inside a list", "1f",
    () => waitingOn({ params: [{ key: "spots", value: "Spot 1, Spot 2" }] }, ["Spot 2"]),
    (waiting) => expect(waiting).toEqual(["Spot 2"]));

  owed("a spawn is not built on a {p} location the map lacks", "1f",
    () => (params: Record<string, string>) => buildSystem("spawn", params, ctx),
    (build) => expect(() => build({ location: "Missing {p}", unit: "Zerg Zergling" })).toThrow(/Missing [12]/));
});
