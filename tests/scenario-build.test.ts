import { describe, expect, it } from "vitest";
import { budgetText, buildOutcome, counterBudget, designTempo, keeperFor, outcomeText, systemsToBuild } from "../ai/scenarioBuild";
import { DEFAULT_DC_UNITS, type ToolkitContext } from "../ai/ums";
import type { DesignSystem } from "../protocol";

const sys = (kind: string, params: Record<string, string> = {}, description = ""): DesignSystem => ({ name: `${kind} ${Object.values(params)[0] ?? ""}`.trim(), kind, params: Object.entries(params).map(([key, value]) => ({ key, value })), description });
const ctx: ToolkitContext = { humans: [1, 2], computers: [8], tempo: "hyper", dcUnits: DEFAULT_DC_UNITS, locations: [] };

describe("a design's tempo", () => {
  it("is the design's to say, before anything is on the map", () => {
    expect(designTempo({ systems: [sys("spawn")] })).toBe("plain");
    expect(designTempo({ target: "classic", systems: [sys("hyper"), sys("spawn")] })).toBe("hyper");
    expect(designTempo({ target: "remastered", systems: [sys("hyper"), sys("custom")] })).toBe("turbo");
  });

  it("a Remastered design is built without its hyper triggers", () => {
    const d = { target: "remastered" as const, systems: [sys("hyper"), sys("spawn"), sys("custom")] };
    expect(systemsToBuild(d).systems.map((s) => s.kind)).toEqual(["spawn", "custom"]);
    expect(systemsToBuild(d).dropped.map((s) => s.kind)).toEqual(["hyper"]);
    expect(systemsToBuild({ ...d, target: "classic" }).systems).toHaveLength(3);
  });
});

describe("the keeper", () => {
  it("is a flier no system names", () => {
    expect(keeperFor({ systems: [sys("waves", { units: "Zerg Zergling, Zerg Hydralisk" })] })).toBe("Zerg Overlord");
    expect(keeperFor({ systems: [sys("waves", { units: "Zerg Mutalisk, zerg overlord" })] })).toBe("Protoss Observer");
    expect(keeperFor({ systems: [sys("spawn", { unit: "Zerg Overlord" }), sys("custom", {}, "The boss is a Protoss Observer that cloaks the Terran Science Vessel beside it.")] })).toBe("Protoss Shuttle");
  });
});

describe("the counter budget", () => {
  const stretch = (n: number) => sys("obstacles", { spots: `Spot ${n}` });

  it("counts what the design's systems take before any is built, locations or not", () => {
    const b = counterBudget({ systems: [sys("hyper"), stretch(1), stretch(2), sys("checkpoints", { unit: "Zerg Zergling", start: "Start", checkpoints: "A, B", finish: "End", lives: "3" }), sys("custom")] }, ctx);
    expect(b).toMatchObject({ counters: 7, free: 18, switches: 2, ok: true });
    expect(budgetText(b)).toBe("7 of 18 free death counters, 2 switches");
  });

  it("nine stretches of obstacles are one counter too many beside anything else", () => {
    const nine = Array.from({ length: 9 }, (_, i) => stretch(i + 1));
    expect(counterBudget({ systems: nine }, ctx).ok).toBe(true);
    const b = counterBudget({ systems: [...nine, sys("income")] }, ctx);
    expect(b).toMatchObject({ counters: 19, free: 18, ok: false });
    expect(budgetText(b)).toMatch(/^the design's systems need 19 death counters and the map has 18 free \(obstacles Spot 1: 2, /);
  });

  it("passes over the counters the map's own triggers use", () => {
    const b = counterBudget({ systems: [stretch(1)] }, { ...ctx, usedDcUnits: DEFAULT_DC_UNITS.slice(0, 17) });
    expect(b).toMatchObject({ counters: 2, free: 1, ok: false });
  });
});

describe("what a build came to", () => {
  it("is built only when every step ran and passed", () => {
    const none = { failed: 0, waiting: 0, notRun: 0, stopped: false };
    expect(buildOutcome(none)).toBe("built");
    expect(outcomeText("Bound", none)).toBe("Built Bound.");
    expect(buildOutcome({ ...none, waiting: 3 })).toBe("waiting");
    expect(outcomeText("Bound", { ...none, waiting: 3 })).toBe("Built Bound, 3 waiting for locations.");
    expect(buildOutcome({ ...none, failed: 2, waiting: 1 })).toBe("failed");
    expect(outcomeText("Bound", { ...none, failed: 2, waiting: 1 })).toBe("Built Bound with 2 failed, 1 waiting.");
    expect(buildOutcome({ ...none, notRun: 9, failed: 1 })).toBe("failed");
    expect(outcomeText("Bound", { failed: 0, waiting: 0, notRun: 4, stopped: true })).toBe("Stopped building Bound: 4 not run. What was built stays.");
  });
});
