/**
 * What Make Scenario decides about a build before and after it runs, kept apart from the
 * dialog so that it can be tested: the tempo the design's timers are counted at, the unit
 * that keeps a computer's slot in the game, whether the map has the death counters and
 * switches the design's systems need, and what a finished build may call itself.
 */
import type { DesignSystem, UmsDesign } from "../protocol";
import { buildSystem, countedUnit, Counters, paramsOf, ToolkitError, type Tempo, type ToolkitContext } from "./ums";

/**
 * The trigger rate a design's toolkit systems are built for. It follows from the design
 * alone — its target, and whether it lists hyper triggers — not from what is on the map
 * at the moment a system is built, so the order of the build's steps does not matter: a
 * Remastered design's timers are right although its programs are written after them.
 */
export function designTempo(d: Pick<UmsDesign, "target" | "systems">): Tempo {
  if (d.target === "remastered") return "turbo";
  return d.systems.some((s) => s.kind === "hyper") ? "hyper" : "plain";
}

/** The systems the build runs: a Remastered design's hyper triggers are left out — every trigger already runs each frame, and their Waits would only hold up their owner's. */
export function systemsToBuild(d: Pick<UmsDesign, "target" | "systems">): { systems: DesignSystem[]; dropped: DesignSystem[] } {
  if (d.target !== "remastered") return { systems: d.systems, dropped: [] };
  return { systems: d.systems.filter((s) => s.kind !== "hyper"), dropped: d.systems.filter((s) => s.kind === "hyper") };
}

/** Fliers no scenario fights with, in the order tried: out of the way in a corner, never in a wave's path. */
export const KEEPERS = ["Zerg Overlord", "Protoss Observer", "Terran Science Vessel", "Protoss Shuttle", "Terran Dropship", "Zerg Queen"];

/**
 * The unit that keeps a computer's slot in the game (a player who owns nothing is defeated
 * at once, and its triggers never run): a flier that no system of the design names, so
 * that a system which counts or orders its own units — a wave's victory counts the wave's
 * types, a spawn's limit the spawned one — never counts the keeper. Null when the design
 * names them all.
 */
export function keeperFor(d: Pick<UmsDesign, "systems">): string | null {
  const named = new Set<string>();
  for (const s of d.systems) {
    for (const p of s.params) for (const v of p.value.split(/\s*[,;]\s*/)) named.add(v.trim().toLowerCase());
    // A custom system names its units in prose.
    if (s.kind === "custom") for (const k of KEEPERS) if (s.description.toLowerCase().includes(k.toLowerCase())) named.add(k.toLowerCase());
  }
  return KEEPERS.find((k) => !named.has(k.toLowerCase())) ?? null;
}

/**
 * The race of the buildings a design's `start-units` systems place on the map, from their
 * names ("Terran Barracks"), or null when it places none. The game drops the placed units
 * of a User Selectable player and hands out a melee start, so such a player is given this
 * race instead.
 */
export function placedBuildingsRace(systems: DesignSystem[], isBuilding?: (unit: string) => boolean): "terran" | "zerg" | "protoss" | null {
  for (const s of systems) {
    if (s.kind !== "start-units") continue;
    for (const v of (s.params.find((p) => p.key === "units")?.value ?? "").split(/\s*[,;]\s*/)) {
      const unit = countedUnit(v).unit;
      const race = /^(terran|zerg|protoss)\b/i.exec(unit)?.[1].toLowerCase();
      if (race && isBuilding?.(unit)) return race as "terran" | "zerg" | "protoss";
    }
  }
  return null;
}

export interface CounterBudget {
  /** Death-counter units the design's toolkit systems take. */
  counters: number;
  /** How many the map has free for them. */
  free: number;
  switches: number;
  /** The systems' share, largest first, for the message. */
  by: { name: string; counters: number }[];
  ok: boolean;
}

/**
 * Build every toolkit system of the design against a scratch allocation, before anything
 * is written: eighteen unused unit types is all a map has, a bound's every stretch takes
 * two, and running out at the ninth system leaves a map with half its mechanics. Locations
 * are not checked here (the terrain step has not made them yet) and a system that fails
 * for another reason is left for its own step to report.
 */
export function counterBudget(d: Pick<UmsDesign, "target" | "systems">, ctx: ToolkitContext): CounterBudget {
  const taken = new Set((ctx.usedDcUnits ?? []).map((u) => u.toLowerCase()));
  const free = ctx.dcUnits.filter((u) => !taken.has(u.toLowerCase())).length;
  // Room to go on counting past the end, so the answer is how many are needed and not only "too many".
  const roomy: ToolkitContext = { ...ctx, locations: [], dcUnits: [...ctx.dcUnits, ...Array.from({ length: 400 }, (_, i) => `(counter ${i + 1})`)] };
  const dc = new Counters(roomy);
  const by: { name: string; counters: number }[] = [];
  let switches = 0;
  const countSwitch = dc.takeSwitch.bind(dc);
  dc.takeSwitch = (what: string) => { switches++; return countSwitch(what); };
  for (const s of systemsToBuild(d).systems) {
    if (s.kind === "custom") continue;
    const before = dc.used.length;
    try { buildSystem(s.kind, paramsOf(s.params), roomy, dc); } catch (err) { if (!(err instanceof ToolkitError)) throw err; }
    if (dc.used.length > before) by.push({ name: s.name, counters: dc.used.length - before });
  }
  by.sort((a, b) => b.counters - a.counters);
  return { counters: dc.used.length, free, switches, by, ok: dc.used.length <= free };
}

/** The budget in a sentence: for the step's row when it fits, and for the failure when it does not. */
export function budgetText(b: CounterBudget): string {
  if (b.ok) return `${b.counters} of ${b.free} free death counters, ${b.switches} switch${b.switches === 1 ? "" : "es"}`;
  return `the design's systems need ${b.counters} death counters and the map has ${b.free} free (${b.by.slice(0, 4).map((x) => `${x.name}: ${x.counters}`).join(", ")}${b.by.length > 4 ? ", …" : ""}). Remove or merge systems in the design — several obstacle stretches on one beat, one spawn with {p} instead of one per player — and build again`;
}

export interface BuildCounts {
  failed: number;
  waiting: number;
  /** Steps never reached: the build was stopped, or a step everything depends on failed. */
  notRun: number;
  stopped: boolean;
}

/** What a finished build is: `built` only when every step ran and passed. */
export type BuildOutcome = "built" | "waiting" | "failed" | "stopped";

export function buildOutcome(c: BuildCounts): BuildOutcome {
  if (c.stopped) return "stopped";
  if (c.failed > 0 || c.notRun > 0) return "failed";
  return c.waiting > 0 ? "waiting" : "built";
}

/** The status line for a finished build, saying which of those it is. */
export function outcomeText(name: string, c: BuildCounts): string {
  const parts: string[] = [];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (c.notRun) parts.push(`${c.notRun} not run`);
  switch (buildOutcome(c)) {
    case "built": return `Built ${name}.`;
    case "waiting": return `Built ${name}, ${c.waiting} waiting for locations.`;
    case "stopped": return `Stopped building ${name}: ${parts.join(", ") || "nothing left out"}. What was built stays.`;
    case "failed": return `Built ${name} with ${parts.join(", ")}.`;
  }
}
