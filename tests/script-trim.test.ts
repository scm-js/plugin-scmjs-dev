import { describe, expect, it } from "vitest";
import { compactTriggers, trimDeclarations } from "../ai/script";

describe("what the model is sent for a trigger script", () => {
  it("trims the declarations: units keep their constants, switches the first sixteen and named ones, AI scripts an index", () => {
    const decl = [
      "declare const Units: {", '  readonly TerranMarine: UnitId<0>;', '  readonly "Terran Marine": UnitId<0>;', '  readonly TerranGhost: UnitId<1>;', '  readonly "Terran Ghost": UnitId<1>;', "};",
      "declare const Locations: {", '  readonly Anywhere: LocationId<64>;', '  readonly "Spawn 1": LocationId<1>;', "};",
      "declare const Switches: {", ...Array.from({ length: 40 }, (_, i) => [`  readonly Switch${i + 1}: SwitchId<${i}>;`, `  readonly "Switch ${i + 1}": SwitchId<${i}>;`]).flat(), '  readonly BossDown: SwitchId<3>;', '  readonly "Boss down": SwitchId<3>;', "};",
      "declare const AiScripts: {", '  readonly TerranCustomLevel: AiScriptId<1>;', '  readonly "Terran Custom Level": AiScriptId<1>;', "};",
      "declare function Victory(): Action;",
    ].join("\n");
    const out = trimDeclarations(decl);
    expect(out).toContain("readonly TerranMarine");
    expect(out).not.toContain('readonly "Terran Marine"');
    expect(out).toContain('Units["Terran Marine"]');
    expect(out).toContain('"Spawn 1"');
    expect(out).toContain("readonly Switch16:");
    expect(out).not.toContain("readonly Switch17:");
    expect(out).not.toContain('"Switch 3"');
    expect(out).toContain("readonly BossDown");
    expect(out).toContain('"Boss down"');
    expect(out).toContain("[name: string]: AiScriptId<number>");
    expect(out).not.toContain("TerranCustomLevel");
    expect(out).toContain("declare function Victory");
    expect(out.length).toBeLessThan(decl.length / 2);
  });

  it("folds runs of identical lines in trigger text", () => {
    const text = ["Trigger(\"All Players\"){", "Actions:", ...Array(62).fill("\tWait(0);"), "\tPreserve Trigger();", "}"].join("\n");
    const out = compactTriggers(text);
    expect(out.split("\n")).toHaveLength(6);
    expect(out).toContain("// … the line above 62 times");
    expect(compactTriggers("a\nb\nb\nc")).toBe("a\nb\nb\nc");
  });
});
