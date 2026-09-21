import { describe, expect, it } from "vitest";
import { didWrite, mayWrite, fail, type Tool } from "../ai/tools/common";
import { firstProgramWarning } from "../ai/tools/script";
import { tools } from "../ai/tools";

const tool = (more: Partial<Tool> = {}): Tool => ({ def: { name: "t", description: "", inputSchema: {} } as Tool["def"], writes: true, run: () => "", ...more });

describe("what counts as an edit", () => {
  it("a writing tool's call that changed something", () => {
    expect(didWrite(tool(), {}, "Done.")).toBe(true);
    expect(didWrite(tool(), {}, JSON.stringify({ changed: 12 }))).toBe(true);
    expect(didWrite(tool({ writes: false }), {}, "Done.")).toBe(false);
    expect(didWrite(undefined, {}, "Done.")).toBe(false);
  });

  it("not one that failed, or says it changed nothing", () => {
    expect(didWrite(tool(), {}, fail("no"))).toBe(false);
    expect(didWrite(tool(), {}, JSON.stringify({ changed: 0, tiles: 0 }))).toBe(false);
    expect(didWrite(tool(), {}, JSON.stringify({ added: 0, triggers: 4 }))).toBe(false);
  });

  it("scenario_rules writes only when asked to fix, and only when it fixed something", () => {
    const rules = tools().find((t) => t.def.name === "scenario_rules")!;
    expect(mayWrite(rules, {})).toBe(false);
    expect(mayWrite(rules, { fix: true })).toBe(true);
    expect(didWrite(rules, {}, JSON.stringify({ problems: ["none"], fixed: [] }))).toBe(false);
    expect(didWrite(rules, { fix: true }, JSON.stringify({ problems: ["none"], fixed: [] }))).toBe(false);
    expect(didWrite(rules, { fix: true }, JSON.stringify({ problems: ["none"], fixed: ["Player 8 …"] }))).toBe(true);
  });
});

describe("a map's first program", () => {
  it("is warned of when other triggers are on the map, and only then", () => {
    expect(firstProgramWarning(false, 1, 12)).toBe(true);
    expect(firstProgramWarning(true, 2, 12)).toBe(false);
    expect(firstProgramWarning(false, 0, 12)).toBe(false);
    expect(firstProgramWarning(false, 1, 0)).toBe(false);
  });
});
