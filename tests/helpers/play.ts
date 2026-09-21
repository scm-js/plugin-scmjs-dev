/**
 * Runs the toolkit's trigger text instead of reading it. The text goes through the editor's
 * own parser and TrigScript's trigger interpreter — both from TrigScript's testing bundle —
 * so a test says what a system *does*: who wins, what a counter holds after so many cycles.
 *
 * It is the interpreter's world, not the game: units are made, moved, given, killed and
 * counted, and never walk or fight. Players are 1-based here, as they are in the toolkit;
 * locations are laid out in a row of boxes that do not touch, in the order they are listed.
 */
import {
  ActionType, parseTriggers, Simulation, UNIT_NAMES,
  type ConditionRecord, type SimBounds, type SimulationEvent, type TriggerNames, type TriggerRecord,
} from "scmjs-plugin-trigscript/testing";

export { ActionType, ConditionType } from "scmjs-plugin-trigscript/testing";

export interface PlayUnit {
  /** The unit's name, as the toolkit writes it. */
  type: string;
  /** 1-based. */
  owner: number;
  /** The location it stands in the middle of; outside every location when left out. */
  at?: string;
}

export interface PlayWorld {
  /** The players in the game, 1-based. */
  players: number[];
  /** The map's locations by name, in the order of their numbers. */
  locations: string[];
  units?: PlayUnit[];
  /** Death counters to start from: `[player, unit name, value]`. */
  deaths?: [number, string, number][];
  /** Answers for conditions the interpreter does not model, or a test wants to decide; undefined leaves it to the interpreter. */
  condition?: (c: ConditionRecord) => boolean | undefined;
}

export interface Played {
  sim: Simulation;
  triggers: TriggerRecord[];
  events: SimulationEvent[];
  /** A death counter's value; player 1-based, unit by name. */
  death(player: number, unit: string): number;
  /** Whether a switch is set; by its number as the text names it ("Switch 12" is 12). */
  switch(n: number): boolean;
  /** Who was given a result, in the order it happened; players 1-based. */
  results(): { player: number; result: "victory" | "defeat"; cycle: number }[];
  /** How many units a player has alive, of one type when named. */
  units(player: number, type?: string): number;
  /** The units die that a fight would have killed: every one a player has, of one type when named. */
  kill(player: number, type?: string): void;
  /** Run further cycles. */
  run(cycles: number): void;
}

const BOX = 50;
const STRIDE = 100;
/** Where units stand that are in no location. */
const NOWHERE = { x: 5, y: 5000 };

export const unitId = (name: string): number => {
  const id = UNIT_NAMES.indexOf(name);
  if (id < 0) throw new Error(`No unit called "${name}".`);
  return id;
};

export function boxOf(locations: string[], name: string): SimBounds {
  const i = locations.indexOf(name);
  if (i < 0) throw new Error(`No location called "${name}".`);
  return { left: i * STRIDE, top: 0, right: i * STRIDE + BOX, bottom: BOX };
}

export function namesFor(locations: string[]): TriggerNames {
  return {
    string: () => null,
    intern: () => 1,
    location: (i) => locations[i - 1] ?? `Location ${i}`,
    locationByName: (s) => (s.toLowerCase() === "anywhere" ? 64 : locations.indexOf(s) + 1 || undefined),
    unit: (i) => UNIT_NAMES[i] ?? String(i),
    unitByName: (s) => { const i = UNIT_NAMES.indexOf(s); return i < 0 ? undefined : i; },
    switch: (i) => `Switch ${i + 1}`,
    switchByName: (s) => { const n = /^Switch (\d+)$/.exec(s); return n ? Number(n[1]) - 1 : undefined; },
  };
}

/** The toolkit's text as trigger records; throws what the editor would say of text it refuses. */
export function parse(text: string, locations: string[]): TriggerRecord[] {
  return parseTriggers(text, namesFor(locations)).map((t) => t.trigger);
}

/** Parse the text, run it for `cycles` trigger cycles in `world`, and answer questions about what happened. */
export function play(text: string | TriggerRecord[], world: PlayWorld, cycles: number): Played {
  const triggers = typeof text === "string" ? parse(text, world.locations) : text;
  const locations: Record<number, SimBounds> = {};
  world.locations.forEach((name, i) => { locations[i + 1] = boxOf(world.locations, name); });
  const sim = new Simulation(triggers, {
    players: world.players.map((p) => p - 1),
    locations,
    units: (world.units ?? []).map((u) => {
      const box = u.at === undefined ? null : boxOf(world.locations, u.at);
      return { type: unitId(u.type), owner: u.owner - 1, x: box ? box.left + BOX / 2 : NOWHERE.x, y: box ? box.top + BOX / 2 : NOWHERE.y };
    }),
    condition: world.condition ? (c) => world.condition!(c) : undefined,
  });
  for (const [p, unit, value] of world.deaths ?? []) sim.setDeath(p - 1, unitId(unit), value);
  sim.run(cycles);
  const living = (p: number, type?: string) => sim.game.living().filter((u) => u.owner === p - 1 && (type === undefined || u.type === unitId(type)));
  return {
    sim, triggers, events: sim.events,
    death: (p, unit) => sim.death(p - 1, unitId(unit)),
    switch: (n) => sim.switches[n - 1] !== 0,
    results: () => sim.events
      .filter((e) => e.action.type === ActionType.Victory || e.action.type === ActionType.Defeat)
      .map((e) => ({ player: e.player + 1, result: e.action.type === ActionType.Victory ? "victory" as const : "defeat" as const, cycle: e.cycle })),
    units: (p, type) => living(p, type).length,
    kill: (p, type) => { for (const u of living(p, type)) sim.game.gone(u, true); },
    run: (n) => sim.run(n),
  };
}
