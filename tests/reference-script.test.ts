/**
 * The TrigScript the assistant is shown compiles with TrigScript's own compiler, from the
 * testing bundle of the release this repository depends on. It once taught `wait(2000)` in
 * a program for six releases of a language that had stopped taking it.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, defaultLib, scriptNames } from "scmjs-plugin-trigscript/testing";
import { SCRIPT_SHORT, SCRIPT_SHORT_LOCATIONS, SCRIPT_TEXT } from "../ai/reference";

describe("the assistant's TrigScript reference", () => {
  it("is a script the compiler takes: three triggers, one named program", () => {
    const names = scriptNames({ locations: SCRIPT_SHORT_LOCATIONS.map((name, index) => ({ index, name })) });
    const r = compileScript(ts, { "main.ts": SCRIPT_SHORT }, names, { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.programs).toHaveLength(1);
  }, 30_000);

  it("says what a program costs the map, and nothing the language no longer does", () => {
    expect(SCRIPT_TEXT).toMatch(/needs StarCraft: Remastered/);
    expect(SCRIPT_TEXT).toMatch(/every trigger on it then runs each frame/);
    expect(`${SCRIPT_TEXT}\n${SCRIPT_SHORT}`).not.toMatch(/death-counter state machine|one iteration per trigger cycle|\bwait\(\d/);
  });
});
