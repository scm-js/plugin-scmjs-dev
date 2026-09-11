import { describe, expect, it } from "vitest";
import { buildSystem, buildSystems, Counters, cyclesFor, waitingOn, dcUnitsFrom, hasLocation, kindByName, kindsText, paramsOf, systemKinds, ToolkitError, trigger, type ToolkitContext } from "../ai/ums";

const ctx: ToolkitContext = { humans: [1, 2], computers: [5], hyper: true, dcUnits: ["Cave (Unused)", "Cantina (Unused)"], locations: ["Spawn 1", "Spawn 2", "Arena", "Goal", "Shop"] };

describe("the UMS toolkit", () => {
  it("lists a catalogue the server can design against", () => {
    const kinds = systemKinds();
    expect(kinds.map((k) => k.kind)).toContain("hyper");
    expect(kinds.map((k) => k.kind)).toContain("waves");
    for (const k of kinds) {
      expect(k.description.length).toBeGreaterThan(20);
      for (const p of k.params) expect(p.description.length).toBeGreaterThan(3);
    }
    expect(kindByName("spawn")?.params.find((p) => p.name === "location")?.required).toBe(true);
    expect(kindByName("nothing")).toBeNull();
    expect(kindsText()).toContain("spawn:");
  });

  it("builds a kind that takes a player list once per player when a parameter holds {p}", () => {
    const shopCtx = { ...ctx, locations: ["Armory 1", "Armory 2", "Spawn 1", "Spawn 2"] };
    const b = buildSystem("shop", { location: "Armory {p}", unit: "Terran Siege Tank (Tank Mode)", price: "250", deliver: "Spawn {p}" }, shopCtx);
    expect(b.count).toBe(2);
    expect(b.text).toContain('Trigger("Player 1"){');
    expect(b.text).toContain('Bring("Current Player", "Any unit", "Armory 1", At least, 1)');
    expect(b.text).toContain('Create Unit("Current Player", "Terran Siege Tank (Tank Mode)", 1, "Spawn 2")');
    expect(b.notes[0]).toContain("once per player (1, 2)");
    expect(() => buildSystem("shop", { location: "Pit {p}", unit: "Zerg Hydralisk" }, shopCtx)).toThrow(/player 1: shop: "location" names location "Pit 1"/);
    // The check on a template itself: backed by a numbered location, or not.
    expect(hasLocation(["Spawn 1", "Arena"], "Spawn {p}")).toBe(true);
    expect(hasLocation(["Spawn 1", "Arena"], "Pit {p}")).toBe(false);
    expect(hasLocation(["Spawn 1", "Arena"], "anywhere")).toBe(true);
  });

  it("builds stages: the counter rises on the clock, extra spawns from a stage on, pay and a message per stage", () => {
    const b = buildSystem("stages", { every: "120", stages: "3", units: "Zerg Hydralisk, Zerg Ultralisk", location: "Spawn {p}", from: "2", interval: "10", count: "2", growth: "1", minerals: "50", message: "Stage {stage}!", attack: "Arena" }, ctx);
    // Per player: 3 stage triggers, 2 spawn triggers (stages 2 and 3), 1 timer.
    expect(b.count).toBe(2 * (3 + 2 + 1));
    expect(b.text).toContain('Elapsed Time(At least, 240)');
    expect(b.text).toContain('Display Text Message(Always Display, "Stage 2!")');
    expect(b.text).toContain('Set Resources("Player 1", Add, 50, ore)');
    expect(b.text).toContain('Create Unit("Player 1", "Zerg Hydralisk", 2, "Spawn 1")');
    expect(b.text).toContain('Create Unit("Player 2", "Zerg Ultralisk", 3, "Spawn 2")');
    expect(b.text).toContain('Order("Player 1", "Zerg Hydralisk", "Spawn 1", "Arena", attack)');
    expect(b.dcUsed).toHaveLength(2);
  });

  it("builds obstacles: spots fire in turn on a beat, the blast created and killed at once, the players' units on the spot killed", () => {
    const b = buildSystem("obstacles", { spots: "Spawn 1, Spawn 2, Arena, Goal", every: "0.5", groups: "2" }, ctx);
    // Two steps of two spots, plus the beat.
    expect(b.count).toBe(3);
    expect(b.text).toContain('Create Unit("Player 5", "Zerg Scourge", 1, "Spawn 1")');
    expect(b.text).toContain('Kill Unit At Location("Player 5", "Zerg Scourge", All, "Spawn 1")');
    expect(b.text).toContain('Kill Unit At Location("Player 1", "Any unit", All, "Spawn 1")');
    expect(b.text).toContain('Kill Unit At Location("Player 2", "Any unit", All, "Arena")');
    expect(b.text).not.toContain("Wait(");
    expect(b.text).toContain("At least, 6)"); // 0.5 s at twelve cycles a second
    expect(() => buildSystem("obstacles", { spots: "Nowhere" }, ctx)).toThrow(ToolkitError);
  });

  it("builds checkpoints: progress recorded in order, a respawn at the last one, the first to the finish wins and the rest lose", () => {
    const b = buildSystem("checkpoints", { unit: "Zerg Zergling", start: "Spawn 1", checkpoints: "Arena, Goal", finish: "Shop", lives: "3" }, ctx);
    // Per player: 2 captures, 3 respawns, 1 out-of-lives; plus 2 finishers and 1 loser trigger.
    expect(b.count).toBe(2 * 6 + 3);
    expect(b.text).toContain('Bring("Player 1", "Zerg Zergling", "Arena", At least, 1)');
    expect(b.text).toContain('Create Unit("Player 2", "Zerg Zergling", 1, "Goal")');
    expect(b.text).toContain("Victory()");
    expect(b.text).toContain("Defeat()");
    expect(b.text).toContain('Set Switch("Switch 255", set)');
    expect(buildSystem("checkpoints", { unit: "Zerg Zergling", start: "Spawn 1", checkpoints: "Arena" }, ctx).text).not.toContain("Victory()");
  });

  it("counts trigger cycles at the map's rate", () => {
    expect(cyclesFor(10, true)).toBe(120);
    expect(cyclesFor(10, false)).toBe(5);
    expect(cyclesFor(1, false)).toBe(1);
  });

  it("prints a trigger in the editor's text format", () => {
    expect(trigger([1, "Force 2"], [], ["Victory()"])).toBe('Trigger("Player 1", "Force 2"){\nConditions:\n\tAlways();\nActions:\n\tVictory();\n}\n');
  });

  it("builds hyper triggers as three preserved Wait(0) triggers", () => {
    const b = buildSystem("hyper", {}, ctx);
    expect(b.count).toBe(3);
    expect(b.text.match(/Wait\(0\)/g)?.length).toBe(62 * 3);
    expect(b.text).toContain('Trigger("All Players"){');
    expect(b.text).toContain("Preserve Trigger();");
  });

  it("spawns per human with {p} substituted, a death-counter timer and an optional attack order", () => {
    const b = buildSystem("spawn", { location: "Spawn {p}", unit: "Zerg Zergling", count: "4", every: "5", attack: "Arena", limit: "40" }, ctx);
    expect(b.count).toBe(4);
    expect(b.text).toContain('Deaths("Player 1", "Cave (Unused)", At least, 60)');
    expect(b.text).toContain('Create Unit("Player 1", "Zerg Zergling", 4, "Spawn 1")');
    expect(b.text).toContain('Create Unit("Player 2", "Zerg Zergling", 4, "Spawn 2")');
    expect(b.text).toContain('Command("Player 2", "Zerg Zergling", At most, 39)');
    expect(b.text).toContain('Order("Player 1", "Zerg Zergling", "Spawn 1", "Arena", attack)');
    expect(b.text).toContain('Set Deaths("Player 1", "Cave (Unused)", Add, 1)');
    expect(b.dcUsed).toEqual(["Cave (Unused)"]);
    expect(b.notes[0]).toContain("60 trigger cycles ≈ 5 s with hyper triggers");
    const slow = buildSystem("spawn", { location: "Spawn {p}", unit: "Zerg Zergling", every: "10", owner: "computer" }, { ...ctx, hyper: false });
    expect(slow.text).toContain("At least, 5)");
    expect(slow.text).toContain('Create Unit("Player 5", "Zerg Zergling", 1, "Spawn 1")');
  });

  it("names every problem instead of guessing", () => {
    expect(() => buildSystem("spawn", { unit: "Zerg Zergling" }, ctx)).toThrow(ToolkitError);
    try {
      buildSystem("spawn", { location: "Nowhere", unit: "Zerg Zergling", every: "fast", speed: "3", players: "everyone" }, ctx);
    } catch (err) {
      const problems = (err as ToolkitError).problems;
      expect(problems.some((p) => p.includes('"every" should be a number'))).toBe(true);
      expect(problems.some((p) => p.includes('"speed" is not a parameter of spawn'))).toBe(true);
      expect(problems.some((p) => p.includes('"players" should be humans'))).toBe(true);
    }
    expect(() => buildSystem("teleport", { from: "Nowhere", to: "Arena" }, ctx)).toThrow(/names location "Nowhere"/);
    expect(() => buildSystem("wave", {}, ctx)).toThrow(/no system kind called "wave"/);
    // Without a location list nothing is checked.
    expect(buildSystem("teleport", { from: "Nowhere", to: "Arena" }, { ...ctx, locations: [] }).count).toBe(1);
  });

  it("pays kills through the kill score and gives income on a timer", () => {
    const k = buildSystem("kill-to-cash", { minerals: "25", scorePerKill: "50" }, ctx);
    expect(k.text).toContain('Score("Current Player", Kills, At least, 50)');
    expect(k.text).toContain('Set Score("Current Player", Subtract, 50, Kills)');
    expect(k.text).toContain('Set Resources("Current Player", Add, 25, ore)');
    expect(k.text.startsWith('Trigger("Player 1", "Player 2"){')).toBe(true);
    const i = buildSystem("income", { minerals: "8", every: "1", perUnit: "Terran Command Center" }, ctx);
    expect(i.text).toContain('Deaths("Current Player", "Cave (Unused)", At least, 12)');
    expect(i.text).toContain('Command("Current Player", "Terran Command Center", At least, 1)');
  });

  it("ends the game: last standing, lost unit, kills, and a countdown", () => {
    const ls = buildSystem("last-standing", { unit: "Buildings" }, ctx);
    expect(ls.text).toContain('Command("Current Player", "Buildings", Exactly, 0)');
    expect(ls.text).toContain('Opponents("Current Player", Exactly, 0)');
    expect(ls.text).toContain("Victory();");
    const cd = buildSystem("countdown", { seconds: "600", onEnd: "victory:Force 1", message: "Time." }, ctx);
    expect(cd.text).toContain("Set Countdown Timer(Set To, 600)");
    expect(cd.text).toContain('Trigger("Force 1"){\nConditions:\n\tCountdown Timer(Exactly, 0);\nActions:\n\tDisplay Text Message(Always Display, "Time.");\n\tVictory();');
    const draw = buildSystem("countdown", { seconds: "60" }, ctx);
    expect(draw.text).toContain("Draw()");
    const vk = buildSystem("victory-on-kills", { count: "50" }, ctx);
    expect(vk.text).toContain('Kill("Current Player", "Any unit", At least, 50)');
    expect(vk.text).toContain('Kill("Foes", "Any unit", At least, 50)');
  });

  it("builds defense: lives on the enemy's counter and waves that grow", () => {
    const [lives, waves] = buildSystems([
      { kind: "lives", params: { lives: "10", goal: "Goal" } },
      { kind: "waves", params: { spawn: "Spawn 1", goal: "Goal", units: "Zerg Zergling, Zerg Hydralisk", waves: "3", interval: "30", count: "5", growth: "5" } },
    ], ctx);
    expect(lives.dcUsed).toEqual(["Cave (Unused)"]);
    expect(waves.dcUsed).toEqual(["Cantina (Unused)"]);
    expect(lives.text).toContain('Set Deaths("Player 5", "Cave (Unused)", Set To, 10)');
    expect(lives.text).toContain('Remove Unit At Location("Player 5", "Any unit", All, "Goal")');
    expect(waves.count).toBe(4);
    expect(waves.text).toContain('Elapsed Time(At least, 60);\n\tDeaths("Player 5", "Cantina (Unused)", Exactly, 1);');
    expect(waves.text).toContain('Create Unit("Player 5", "Zerg Hydralisk", 10, "Spawn 1")');
    expect(waves.text).toContain('Order("Player 5", "Any unit", "Spawn 1", "Goal", attack)');
    expect(waves.text).toContain('Deaths("Player 5", "Cantina (Unused)", At least, 3);\n\tCommand("Player 5", "Any unit", Exactly, 0);\n\tElapsed Time(At least, 100);');
    expect(() => buildSystems([{ kind: "lives", params: { lives: "1", goal: "Goal" } }, { kind: "waves", params: { spawn: "Spawn 1", goal: "Goal", units: "Zerg Zergling" } }, { kind: "income", params: {} }], ctx)).toThrow(/no death-counter unit left/);
  });

  it("passes over the counters and switches the map's triggers already use", () => {
    // What a map's own triggers count on is handed to the context; the allocator steps past it.
    const lives = buildSystem("lives", { lives: "10", goal: "Goal" }, { ...ctx, usedDcUnits: ["Cave (Unused)"] });
    expect(lives.dcUsed).toEqual(["Cantina (Unused)"]);
    // Two systems built one after the other on a map, each from a fresh context: the second sees the first's counter in use.
    const spawn = buildSystem("spawn", { location: "Spawn 1", unit: "Zerg Zergling", players: "1" }, ctx);
    const income = buildSystem("income", {}, { ...ctx, usedDcUnits: spawn.dcUsed });
    expect(spawn.dcUsed).toEqual(["Cave (Unused)"]);
    expect(income.dcUsed).toEqual(["Cantina (Unused)"]);
    expect(() => buildSystem("lives", { lives: "1", goal: "Goal" }, { ...ctx, usedDcUnits: ctx.dcUnits })).toThrow(/2 already in use by the map's triggers/);
    const dc = new Counters({ ...ctx, usedSwitches: ["Switch 255", "switch 253"] });
    expect(dc.takeSwitch("a")).toBe("Switch 254");
    expect(dc.takeSwitch("b")).toBe("Switch 252");
  });

  it("says which missing locations a designed system waits for", () => {
    const missing = ["Goal", "Spawn 3", "Shop"];
    expect(waitingOn({ params: [{ key: "spawn", value: "Spawn {p}" }, { key: "goal", value: "Goal" }] }, missing)).toEqual(["Goal", "Spawn 3"]);
    expect(waitingOn({ params: [{ key: "location", value: "Arena" }] }, missing)).toEqual([]);
    expect(waitingOn({ params: [{ key: "location", value: "Anywhere" }] }, missing)).toEqual([]);
  });

  it("builds the RPG pieces: shop, heal, respawn, give, teleport, kill zone", () => {
    expect(buildSystem("shop", { location: "Shop", unit: "Terran Marine", price: "150", deliver: "Arena" }, ctx).text).toContain('Accumulate("Current Player", At least, 150, ore);\nActions:\n\tSet Resources("Current Player", Subtract, 150, ore);\n\tCreate Unit("Current Player", "Terran Marine", 1, "Arena");\n\tMove Unit("Current Player", "Any unit", All, "Shop", "Arena");');
    expect(buildSystem("heal", { location: "Shop" }, ctx).text).toContain('Modify Unit Hit Points("Current Player", "Any unit", 100, All, "Shop")');
    const r = buildSystem("respawn", { unit: "Jim Raynor (Marine)", location: "Arena", lives: "3" }, ctx);
    expect(r.text).toContain('Deaths("Current Player", "Cave (Unused)", At most, 2)');
    expect(r.text).toContain('Create Unit("Current Player", "Jim Raynor (Marine)", 1, "Arena")');
    expect(buildSystem("give", { location: "Shop", unit: "Terran Marine" }, ctx).text).toContain('Give Units to Player("Player 5", "Current Player", "Terran Marine", All, "Shop")');
    expect(buildSystem("kill-zone", { location: "Goal" }, ctx).text).toContain('Trigger("Player 1", "Player 2", "Player 5"){');
    expect(buildSystem("alliance", { with: "computer", status: "enemy" }, ctx).text).toContain('Set Alliance Status("Player 5", Enemy)');
    expect(buildSystem("auto-attack", { owner: "computer", from: "Anywhere", to: "Arena" }, ctx).text).toContain('Order("Player 5", "Any unit", "Anywhere", "Arena", attack)');
    expect(buildSystem("leaderboard", { kind: "control", unit: "Buildings" }, ctx).text).toContain('Leader Board Control("Units", "Buildings")');
    expect(buildSystem("objectives", { text: "Survive.\\nWin." }, ctx).text).toContain('Set Mission Objectives("Survive.\\nWin.")');
    expect(buildSystem("message", { text: "Go!", after: "5" }, ctx).text).toContain("Elapsed Time(At least, 5)");
  });

  it("converts wire params and picks death-counter units the map has", () => {
    expect(paramsOf([{ key: "a", value: "1" }, { key: "b", value: "x" }])).toEqual({ a: "1", b: "x" });
    expect(dcUnitsFrom(["Terran Marine", "cantina (unused)", "Cave (Unused)"])).toEqual(["Cave (Unused)", "Cantina (Unused)"]);
  });
});
