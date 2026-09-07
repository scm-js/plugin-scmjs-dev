import { describe, expect, it } from "vitest";
import { compactTriggers, describeDiagnostic, repairDiagnostic } from "../ai/script";

describe("what the model is sent for a TrigScript", () => {
  it("folds runs of identical trigger lines", () => {
    const text = ["Trigger(\"Player 1\"){", "Actions:", "Wait(0);", "Wait(0);", "Wait(0);", "Wait(0);", "Victory();", "}"].join("\n");
    expect(compactTriggers(text).split("\n")).toEqual(["Trigger(\"Player 1\"){", "Actions:", "Wait(0);", "// … the line above 4 times", "Victory();", "}"]);
    expect(compactTriggers("a\na\nb")).toBe("a\na\nb");
  });

  it("names the file of a diagnostic only when it is not main.ts", () => {
    const d = { file: "main.ts", line: 3, column: 5, endLine: 3, endColumn: 9, message: "no", source: "compiler" as const };
    expect(describeDiagnostic(d)).toBe("line 3:5 — no");
    expect(describeDiagnostic({ ...d, file: "waves.ts" })).toBe("waves.ts line 3:5 — no");
    expect(repairDiagnostic(d)).toEqual({ line: 3, column: 5, message: "no" });
    expect(repairDiagnostic({ ...d, file: "waves.ts" }).message).toBe("waves.ts: no");
  });
});
