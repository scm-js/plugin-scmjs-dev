/**
 * What the toolkit's triggers *do*, run through the editor's parser and TrigScript's trigger
 * interpreter (`helpers/play.ts`) — `ums.test.ts` beside this one reads their text.
 *
 * `owed` is for behaviour the toolkit does not have yet: the claim is written the way it
 * will be true, and until then it has to fail *as an assertion* — a harness that throws, or
 * a builder that stops building, is a real failure, not the expected one. The day the claim
 * holds the test says so, and `owed(` becomes `it(`. Nothing is owed at the moment.
 */
import { describe, expect, it } from "vitest";
import { buildSystem, countedUnit, cyclesFor, DEFAULT_DC_UNITS, systemKinds, timerText, waitingOn, type BuiltSystem, type ToolkitContext } from "../ai/ums";
import { ActionType, ConditionType, parse, play } from "./helpers/play";

const SPOTS = Array.from({ length: 16 }, (_, i) => `Spot ${i + 1}`);
const LOCATIONS = ["Start", "Checkpoint 1", "Checkpoint 2", "Finish", ...SPOTS];
const ctx: ToolkitContext = { humans: [1, 2], computers: [8], tempo: "hyper", dcUnits: DEFAULT_DC_UNITS, locations: LOCATIONS };

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

const ELAPSED = (c: { type: number }) => (c.type === ConditionType.ElapsedTime ? true : undefined);
const results = (game: { results(): { player: number; result: string }[] }) => game.results().map((r) => `${r.player} ${r.result}`).sort();
const runner = (owner: number, at?: string) => ({ type: "Zerg Zergling", owner, at });

describe("waves", () => {
  const wave = (units: string, waves = "1") => buildSystem("waves", { spawn: "Start", goal: "Finish", units, waves, interval: "5" }, ctx);

  it("are won when the wave is dead, though the enemy keeps a unit", () => {
    // Elapsed time is not the interpreter's to know; every wave is due.
    const game = play(wave("Zerg Zergling").text, { players: [1, 2, 8], locations: LOCATIONS, units: [{ type: "Zerg Overlord", owner: 8 }], condition: ELAPSED }, 1);
    expect(game.units(8, "Zerg Zergling")).toBe(6);
    expect(game.results()).toEqual([]);
    game.kill(8, "Zerg Zergling");
    game.run(1);
    expect(results(game)).toEqual(["1 victory", "2 victory"]);
  });

  it("are not won while any of the waves' types lives", () => {
    const game = play(wave("Zerg Zergling, Zerg Hydralisk", "2").text, { players: [1, 8], locations: LOCATIONS, condition: ELAPSED }, 1);
    game.kill(8, "Zerg Zergling");
    game.run(1);
    expect(game.results()).toEqual([]);
    game.kill(8, "Zerg Hydralisk");
    game.run(1);
    expect(results(game)).toEqual(["1 victory"]);
  });

  it("two lanes are one system: a wave at every spawn, and one victory", () => {
    const b = buildSystem("waves", { spawn: "Start, Checkpoint 1", goal: "Finish", units: "Zerg Zergling", waves: "2", interval: "5", count: "3", growth: "0" }, ctx);
    expect(b.count).toBe(3);
    expect(b.dcUsed).toHaveLength(1);
    const game = play(b.text, { players: [1, 8], locations: LOCATIONS, units: [{ type: "Zerg Overlord", owner: 8 }], condition: ELAPSED }, 1);
    expect(game.units(8, "Zerg Zergling")).toBe(12);
    expect(game.sim.game.living().filter((u) => u.type === 37).map((u) => u.x).sort((x, y) => x - y)).toEqual([...Array(6).fill(25), ...Array(6).fill(125)]);
    game.kill(8, "Zerg Zergling");
    game.run(1);
    expect(results(game)).toEqual(["1 victory"]);
    expect(() => buildSystem("waves", { spawn: "Start, Nowhere", goal: "Finish", units: "Zerg Zergling" }, ctx)).toThrow(/"spawn" names location "Nowhere"/);
  });

  it("count Men when the types are more than a trigger's conditions hold", () => {
    const many = ["Zerg Zergling", "Zerg Hydralisk", "Zerg Ultralisk", "Zerg Drone", "Zerg Mutalisk", "Zerg Guardian", "Zerg Queen", "Zerg Defiler", "Zerg Scourge", "Zerg Lurker", "Zerg Devourer", "Zerg Broodling", "Terran Marine", "Terran Firebat"];
    const b = wave(many.join(", "), "14");
    expect(b.text).toContain('Command("Player 8", "Men", Exactly, 0)');
    expect(b.notes.join(" ")).toMatch(/counts Men/);
    expect(() => parse(b.text, LOCATIONS)).not.toThrow();
    expect(parse(wave(many.slice(0, 13).join(", "), "13").text, LOCATIONS).at(-1)!.conditions.filter((x) => x.type !== 0)).toHaveLength(15);
  });
});

describe("starting units", () => {
  it("each player gets them once, where their numbered location is", () => {
    const yards = { ...ctx, locations: [...LOCATIONS, "Yard 1", "Yard 2"] };
    const b = buildSystem("start-units", { units: "1 Terran SCV, 4 Terran Marine, Terran Firebat", location: "Yard {p}" }, yards);
    expect(b.count).toBe(2);
    expect(b.notes[0]).toBe("1 Terran SCV, 4 Terran Marine, 1 Terran Firebat for each of players 1, 2, once, when the game starts");
    const game = play(b.text, { players: [1, 2], locations: yards.locations }, 5);
    expect([game.units(1, "Terran SCV"), game.units(1, "Terran Marine"), game.units(1, "Terran Firebat"), game.units(2)]).toEqual([1, 4, 1, 6]);
    expect(() => buildSystem("start-units", { units: "Terran SCV", location: "Yard {p}", players: "1, 2, 3" }, yards)).toThrow(/"Yard 3"/);
    expect(countedUnit("2x Terran Firebat")).toEqual({ unit: "Terran Firebat", count: 2 });
    expect(countedUnit("Terran SCV")).toEqual({ unit: "Terran SCV", count: 1 });
  });

  it("buildings are not made by trigger — a trigger makes one only at a location's centre — but handed over to be placed", () => {
    const yards = { ...ctx, locations: [...LOCATIONS, "Yard 1", "Yard 2"], isBuilding: (u: string) => /Barracks|Engineering Bay/.test(u) };
    const b = buildSystem("start-units", { units: "1 Terran SCV, Terran Engineering Bay, Terran Barracks, 2 Terran Marine", location: "Yard {p}" }, yards);
    expect(b.text).not.toMatch(/Barracks|Engineering Bay/);
    expect(b.count).toBe(2);
    expect(b.place).toEqual([
      { player: 1, unit: "Terran Engineering Bay", count: 1, location: "Yard 1" }, { player: 1, unit: "Terran Barracks", count: 1, location: "Yard 1" },
      { player: 2, unit: "Terran Engineering Bay", count: 1, location: "Yard 2" }, { player: 2, unit: "Terran Barracks", count: 1, location: "Yard 2" },
    ]);
    expect(b.notes[1]).toMatch(/placed on the map in each player's location.*real race/);
    const only = buildSystem("start-units", { units: "Terran Barracks", location: "Yard {p}", players: "1" }, yards);
    expect([only.count, only.text.trim(), only.place.length]).toEqual([0, "", 1]);
    expect(buildSystem("spawn", { location: "Start", unit: "Zerg Zergling" }, ctx).place).toEqual([]);
  });

  it("the catalogue says which kinds give the players units, and which need one owned", () => {
    const kinds = systemKinds();
    expect(kinds.filter((k) => k.creates).map((k) => `${k.kind}: ${k.creates!.join(",")}`)).toEqual(["start-units: units", "spawn: unit", "stages: units", "checkpoints: unit", "respawn: unit"]);
    expect(kinds.flatMap((k) => k.params.filter((p) => p.owned).map((p) => `${k.kind}.${p.name}`))).toEqual(["last-standing.unit", "defeat-when-lost.unit", "shop.buyer"]);
  });
});

describe("lives", () => {
  it("cost one for each unit that leaks, one a cycle", () => {
    const b = buildSystem("lives", { lives: "5", goal: "Finish" }, ctx);
    const leak = { type: "Zerg Zergling", owner: 8, at: "Finish" };
    const game = play(b.text, { players: [1, 2, 8], locations: LOCATIONS, units: [leak, leak, leak, { type: "Zerg Overlord", owner: 8 }] }, 1);
    expect(game.death(8, b.dcUsed[0])).toBe(4);
    game.run(5);
    expect(game.death(8, b.dcUsed[0])).toBe(2);
    expect(game.units(8, "Zerg Zergling")).toBe(0);
    expect(game.results()).toEqual([]);
  });

  it("say how fast a crowd drains at the map's tempo", () => {
    expect(buildSystem("lives", { lives: "5", goal: "Finish" }, { ...ctx, tempo: "plain" }).notes[0]).toMatch(/about every 2 s without hyper triggers.*add a `hyper` system/);
    expect(buildSystem("lives", { lives: "5", goal: "Finish" }, { ...ctx, tempo: "turbo" }).notes[0]).toMatch(/24 a second/);
  });
});

describe("obstacles", () => {
  it("no trigger holds more actions than the game reads, and a split step still fires whole and once", () => {
    const seven = { ...ctx, humans: [1, 2, 3, 4, 5, 6, 7] };
    const b = buildSystem("obstacles", { spots: SPOTS.join(","), groups: "8", every: "1" }, seven);
    const triggers = parse(b.text, LOCATIONS);
    for (const t of triggers) expect(t.actions.filter((x) => x.type !== 0).length).toBeLessThanOrEqual(64);
    expect(b.notes.join(" ")).toMatch(/2 of the steps hold more actions than a trigger reads and are split/);
    // A runner of every player on every spot; the beat is 12 cycles at hyper tempo.
    const units = SPOTS.flatMap((at) => seven.humans.map((owner) => ({ type: "Terran Marine", owner, at })));
    const game = play(triggers, { players: [...seven.humans, 8], locations: LOCATIONS, units }, 12);
    expect(game.units(1)).toBe(16);
    game.run(1);
    // The first step's eight spots, every player's unit on each, in the one cycle.
    expect(seven.humans.map((p) => game.units(p))).toEqual([8, 8, 8, 8, 8, 8, 8]);
    expect(game.death(8, b.dcUsed[0])).toBe(1);
    // The beat is reset as the step fires, so the next comes exactly twelve cycles after it.
    game.run(11);
    expect(game.units(1)).toBe(8);
    game.run(1);
    expect(game.units(1)).toBe(0);
    expect(game.death(8, b.dcUsed[0])).toBe(0);
  });

  it("a short last group is short, not wrapped round to the first spot", () => {
    const b = buildSystem("obstacles", { spots: SPOTS.slice(0, 5).join(","), groups: "2" }, ctx);
    expect(created(b)).toEqual([["Spot 1", "Spot 4"], ["Spot 2", "Spot 5"], ["Spot 3"]]);
    expect(b.notes.join(" ")).toMatch(/do not divide/);
  });
});

describe("checkpoints", () => {
  const course = (more: Record<string, string> = {}) => buildSystem("checkpoints", { unit: "Zerg Zergling", start: "Start", checkpoints: "Checkpoint 1, Checkpoint 2", ...more }, ctx);

  it("a checkpoint does not count before the one ahead of it, unless the order is any", () => {
    const strict = course();
    expect(play(strict.text, { players: [1, 2], locations: LOCATIONS, units: [runner(1, "Checkpoint 2")] }, 2).death(1, strict.dcUsed[0])).toBe(0);
    const any = course({ order: "any" });
    expect(play(any.text, { players: [1, 2], locations: LOCATIONS, units: [runner(1, "Checkpoint 2")] }, 2).death(1, any.dcUsed[0])).toBe(2);
    expect(() => course({ order: "backwards" })).toThrow(/"order" should be strict or any/);
  });

  it("the first unit costs no life, each one after it does, and the last life ends it", () => {
    const b = course({ lives: "2" });
    const [, used] = b.dcUsed;
    const game = play(b.text, { players: [1], locations: LOCATIONS }, 3);
    expect(game.units(1)).toBe(1);
    expect(game.death(1, used)).toBe(0);
    for (const lost of [1, 2]) {
      game.kill(1);
      game.run(2);
      expect(game.units(1)).toBe(1);
      expect(game.death(1, used)).toBe(lost);
    }
    expect(game.results()).toEqual([]);
    game.kill(1);
    game.run(2);
    expect(game.units(1)).toBe(0);
    expect(results(game)).toEqual(["1 defeat"]);
  });

  it("two runners at the finish in one cycle both win, and the third loses", () => {
    const b = course({ finish: "Finish", players: "1, 2, 3" });
    const game = play(b.text, { players: [1, 2, 3], locations: LOCATIONS, units: [runner(1, "Finish"), runner(2, "Finish"), runner(3, "Start")] }, 4);
    expect(results(game)).toEqual(["1 victory", "2 victory", "3 defeat"]);
    expect(game.results().length).toBe(3);
  });

  it("with tie: first, one of them wins and everyone still gets a result", () => {
    const b = course({ finish: "Finish", tie: "first", players: "1, 2, 3" });
    const game = play(b.text, { players: [1, 2, 3], locations: LOCATIONS, units: [runner(1, "Finish"), runner(2, "Finish"), runner(3, "Start")] }, 4);
    expect(results(game)).toEqual(["1 victory", "2 defeat", "3 defeat"]);
  });

  it("the finish is resolved whoever is missing, and whoever's turn came before the finisher's", () => {
    // Player 1's slot is empty; player 3 finishes, and player 2's turn in that cycle had already passed.
    const b = buildSystem("checkpoints", { unit: "Zerg Zergling", start: "Start", checkpoints: "Checkpoint 1", finish: "Finish", players: "1, 2, 3" }, ctx);
    const game = play(b.text, { players: [2, 3], locations: LOCATIONS, units: [runner(2, "Start"), runner(3, "Finish")] }, 5);
    expect(results(game)).toEqual(["2 defeat", "3 victory"]);
  });

  it("nobody has a result before anybody finishes", () => {
    expect(play(course({ finish: "Finish" }).text, { players: [1, 2], locations: LOCATIONS }, 20).results()).toEqual([]);
  });
});

describe("locations", () => {
  it("a system waits on a location named inside a list", () => {
    expect(waitingOn({ params: [{ key: "spots", value: "Spot 1, Spot 2" }] }, ["Spot 2"])).toEqual(["Spot 2"]);
    expect(waitingOn({ params: [{ key: "spots", value: "Spot 1; Spot 2" }, { key: "where", value: "Anywhere" }] }, ["Spot 3", "Anywhere"])).toEqual([]);
    expect(waitingOn({ params: [{ key: "location", value: "Spawn {p}" }] }, ["Spawn 2", "Spawner"])).toEqual(["Spawn 2"]);
  });

  it("a {p} location is checked for each player it is built for", () => {
    expect(() => buildSystem("spawn", { location: "Missing {p}", unit: "Zerg Zergling" }, ctx)).toThrow(/"Missing 1".*"Missing 2"/);
    const one = { ...ctx, locations: [...LOCATIONS, "Spawn 1"] };
    expect(() => buildSystem("spawn", { location: "Spawn {p}", unit: "Zerg Zergling" }, one)).toThrow(/"location" names location "Spawn 2"/);
    expect(() => buildSystem("stages", { location: "Spawn {p}", units: "Zerg Zergling" }, one)).toThrow(/"location" names location "Spawn 2"/);
    expect(buildSystem("spawn", { location: "Spawn {p}", unit: "Zerg Zergling", players: "1" }, one).count).toBe(2);
  });
});

describe("timing", () => {
  it("counts cycles at the map's tempo and says what they come to", () => {
    expect([cyclesFor(10, "plain"), cyclesFor(10, "hyper"), cyclesFor(10, "turbo")]).toEqual([5, 120, 240]);
    expect(cyclesFor(0.01, "plain")).toBe(1);
    expect(timerText(10, "hyper")).toBe("120 trigger cycles = 10 s; with hyper triggers, about 12 cycles a second");
    expect(timerText(3, "plain")).toBe("2 trigger cycles = 4 s (asked for 3 s); without hyper triggers, a cycle about every 2 s");
    expect(timerText(0.8, "turbo")).toMatch(/^19 trigger cycles = 0\.79 s \(asked for 0\.8 s\); the map has a program/);
  });

  it("a spawn comes as often on a map with a program as on one with hypers", () => {
    for (const tempo of ["hyper", "turbo"] as const) {
      const b = buildSystem("spawn", { location: "Start", unit: "Zerg Zergling", every: "1", players: "1" }, { ...ctx, tempo });
      const perSecond = tempo === "hyper" ? 12 : 24;
      const game = play(b.text, { players: [1], locations: LOCATIONS }, perSecond * 10 + 1);
      expect(game.units(1, "Zerg Zergling")).toBeGreaterThanOrEqual(9);
      expect(game.units(1, "Zerg Zergling")).toBeLessThanOrEqual(10);
    }
  });
});
