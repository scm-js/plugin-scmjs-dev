import { describe, expect, it } from "vitest";
import { compactTriggers, describeDiagnostic, indexTriggers, repairDiagnostic, type TriggerRow } from "../ai/script";

describe("what the model is sent for a TrigScript", () => {
  it("folds runs of identical trigger lines", () => {
    const text = ["Trigger(\"Player 1\"){", "Actions:", "Wait(0);", "Wait(0);", "Wait(0);", "Wait(0);", "Victory();", "}"].join("\n");
    expect(compactTriggers(text).split("\n")).toEqual(["Trigger(\"Player 1\"){", "Actions:", "Wait(0);", "// … the line above 4 times", "Victory();", "}"]);
    expect(compactTriggers("a\na\nb")).toBe("a\na\nb");
  });

  it("indexes many triggers as one line per shape, actions folded, cut to the budget", () => {
    const row = (index: number, players: string, conditions: string, actions: string, comment: string | null = null): TriggerRow => ({ index, players, conditions, actions, comment });
    const rows: TriggerRow[] = [
      ...[0, 1, 2].map((i) => row(i, "All Players", "Always()", Array(62).fill("Wait(0)").join("; "))),
      row(3, "Player 1, Player 2", "", 'Set Mission Objectives("Hold; then win")', "Objectives"),
      ...[4, 5, 6, 7].map((i) => row(i, `Player ${i - 3}`, `Bring("Player ${i - 3}", "Terran Marine", "Goal", At least, 1)`, `Set Resources("Player ${i - 3}", Add, 50, gas); Display Text Message(Always Display, "Player ${i - 3} scored; well done")`)),
      // Two shapes interleaved, as a system that emits two triggers per stage does.
      row(8, "Player 5", 'Elapsed Time(At least, 50)', 'Create Unit("Player 5", "Zerg Zergling", 6, "Top")'),
      row(9, "Player 5", 'Elapsed Time(At least, 100)', 'Create Unit("Player 5", "Zerg Hydralisk", 8, "Top"); Display Text Message(Always Display, "Wave 2")'),
      row(10, "Player 5", 'Elapsed Time(At least, 150)', 'Create Unit("Player 5", "Zerg Zergling", 10, "Top")'),
      row(11, "Player 5", 'Elapsed Time(At least, 200)', 'Create Unit("Player 5", "Zerg Hydralisk", 12, "Top"); Display Text Message(Always Display, "Wave 4")'),
    ];
    const text = indexTriggers(rows);
    const lines = text.split("\n");
    expect(lines[0]).toBe("12 triggers in 5 shapes; a line is one shape — triggers that differ only by player or number — with the first one's text and the numbers of the rest:");
    expect(lines[1]).toBe("#0, 1, 2 (3 of this shape) [All Players] Always() -> Wait(0) ×62");
    expect(lines[2]).toBe('#3 "Objectives": [Player 1, Player 2] Always() -> Set Mission Objectives("Hold; then win")');
    expect(lines[3]).toBe('#4, 5, 6, 7 (4 of this shape) [Player 1] Bring("Player 1", "Terran Marine", "Goal", At least, 1) -> Set Resources("Player 1", Add, 50, gas); Display Text Message(Always Display, "Player 1 scored; well done")');
    // Different action names are a different shape, even for the same player; copies need not be neighbours.
    expect(lines[4]).toMatch(/^#8, 10 \(2 of this shape\) \[Player 5\]/);
    expect(lines[5]).toMatch(/^#9, 11 \(2 of this shape\) \[Player 5\]/);
    expect(lines).toHaveLength(6);
    // Past the budget the lines shorten, then the tail is cut with a count: every shape distinct here.
    const many = Array.from({ length: 300 }, (_, i) => row(i, `Player ${(i % 8) + 1}`, `Deaths("Player 1", "Zerg Zergling", At least, ${i})`, `Display Text Message(Always Display, "${"long text ".repeat(20)}")${"; Center View(\"Spawn\"); Minimap Ping(\"Spawn\")".repeat(i + 1)}`));
    const cut = indexTriggers(many, 4000);
    expect(cut.length).toBeLessThanOrEqual(4000);
    expect(cut).toMatch(/… and \d+ more triggers of \d+ other shapes not listed\.$/);
    expect(cut.split("\n")[1]).toMatch(/…$/);
  });

  it("names the file of a diagnostic only when it is not main.ts", () => {
    const d = { file: "main.ts", line: 3, column: 5, endLine: 3, endColumn: 9, message: "no", source: "compiler" as const };
    expect(describeDiagnostic(d)).toBe("line 3:5 — no");
    expect(describeDiagnostic({ ...d, file: "waves.ts" })).toBe("waves.ts line 3:5 — no");
    expect(repairDiagnostic(d)).toEqual({ line: 3, column: 5, message: "no" });
    expect(repairDiagnostic({ ...d, file: "waves.ts" }).message).toBe("waves.ts: no");
  });
});
