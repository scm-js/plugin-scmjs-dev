import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KO } from "../ko";

// Every literal the plugin shows through `t("…")`, `tc("…", "…")` or `msg("…")`, read from the source the way the editor's own extractor reads it.
const root = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", "tests", "scripts", "docs", ".git"]);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP.has(name) ? [] : walk(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") && name !== "ko.ts" && name !== "i18n.ts" ? [path] : [];
  });
}
const files = walk(root);
const sources = files.map((f) => readFileSync(f, "utf8"));
const unquote = (s: string) => JSON.parse(`"${s}"`) as string;
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const keys = new Set(sources.flatMap((source) => [
  ...[...source.matchAll(new RegExp(String.raw`\b(?:t|msg)\(\s*${STR}`, "g"))].map((m) => unquote(m[1]!)),
  ...[...source.matchAll(new RegExp(String.raw`\btc\(\s*${STR},\s*${STR}`, "g"))].map((m) => `${unquote(m[1]!)}\u0004${unquote(m[2]!)}`),
]));

/** The placeholders a string fills: `{name}`, `{n, plural, …}`, `{name|을}` — not the words inside a plural's branches. */
const names = (s: string) => new Set([...s.matchAll(/\{(\w+)(?=[},|])/g)].map((m) => m[1]));
/** The ones only English needs: the count a plural chooses its branch by. */
const counts = (s: string) => new Set([...s.matchAll(/\{(\w+), plural/g)].map((m) => m[1]));

describe("the Korean catalogue", () => {
  it("reads the source", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(keys.size).toBeGreaterThan(0);
  });

  it("never passes t() anything but a literal", () => {
    const offenders = files.flatMap((f, i) => [...sources[i]!.matchAll(/\b(?:t|msg|tc)\((?!\s*")/g)].map((m) => `${f}: ${sources[i]!.slice(m.index!, m.index! + 40)}`));
    expect(offenders).toEqual([]);
  });

  it("has every string the plugin shows", () => {
    expect([...keys].filter((k) => !(k in KO))).toEqual([]);
  });

  it("has nothing the plugin no longer shows", () => {
    expect(Object.keys(KO).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("keeps every placeholder, and adds none", () => {
    for (const [en, ko] of Object.entries(KO)) {
      const want = [...names(en)].filter((n) => !counts(en).has(n) || names(ko).has(n)).sort();
      expect([...names(ko)].sort(), en).toEqual(want);
    }
  });

  it("never hard-codes a particle after a placeholder", () => {
    const bad = Object.values(KO).filter((ko) => /\}(?:을|를|이|가|은|는|과|와|으로|로)(?![가-힣])|\}\((?:을|이|은|으로)\)/.test(ko));
    expect(bad).toEqual([]);
  });
});
