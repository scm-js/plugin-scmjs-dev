/**
 * Ramps, from the tileset's own data. A ramp is a doodad whose cells each require a
 * particular cliff tile group underneath, so it fits one cliff shape and nothing else;
 * every tileset has a handful, for one or two terrain pairs, and each goes down toward
 * the south-west or the south-east — the game has no other kind. Everything here is
 * read off `DoodadInfo.required`: which flat pair a ramp joins (the required groups
 * that are a terrain's own), and which way it faces (where the low side's cells lie).
 * `fitRamp` then asks the editor's placement check where, near a site, a ramp fits —
 * which is how a ramp ends up exactly on the cliff the brush drew, rather than where a
 * plan guessed the cliff would be.
 */
import type { PluginApi, DoodadInfo, TerrainType } from "@scm-js/plugin-api";
import type { BridgePair, RampPair, RampPlan, RampSide } from "../protocol";

export interface RampDoodad {
  id: number;
  name: string;
  width: number;
  height: number;
  /** Terrain ids (`TerrainType.id`) of the ground it joins. */
  low: number;
  high: number;
  side: RampSide;
}

type TypeInfo = Pick<TerrainType, "id" | "group" | "height"> & { name?: string };

/**
 * The ramps a tileset has, with what each joins and which way it goes down. Most ramps
 * require flat ground of both terrains somewhere in their footprint; some name only one
 * side (Ice's cliff ramps only the snow below, Platform's wall ramps only the platform
 * above), and for those the other side is the terrain named "High <that>" or the one
 * without the "High ", else the tileset's lowest ground. The side comes from where the
 * low ground's cells lie: left of the high ground's, the ramp descends south-west.
 */
export function rampDoodads(doodads: readonly DoodadInfo[], types: readonly TypeInfo[]): RampDoodad[] {
  const byGroup = new Map<number, TypeInfo>();
  for (const t of types) { byGroup.set(t.group, t); byGroup.set(t.group + 1, t); }
  const byName = new Map(types.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t]));
  const lowest = [...types].sort((a, b) => a.height - b.height || a.group - b.group)[0];
  const out: RampDoodad[] = [];
  for (const d of doodads) {
    if (!d.ramp || !d.required?.length) continue;
    const flats = new Map<number, { t: TypeInfo; sx: number; sy: number; n: number }>();
    d.required.forEach((g, i) => {
      const t = byGroup.get(g);
      if (!t) return;
      const e = flats.get(t.id) ?? { t, sx: 0, sy: 0, n: 0 };
      e.sx += i % d.width; e.sy += Math.floor(i / d.width); e.n++;
      flats.set(t.id, e);
    });
    const list = [...flats.values()].sort((a, b) => a.t.height - b.t.height || b.n - a.n);
    if (list.length === 0) continue;
    let lo = list[0], hi = list.find((e) => e.t.height > lo.t.height) ?? null;
    let side: RampSide;
    if (hi) {
      side = lo.sx / lo.n < hi.sx / hi.n ? "sw" : "se";
    } else {
      // One side named: the other by name, else the lowest ground; the side from where the named cells sit.
      const only = list[0];
      const centre = (d.width - 1) / 2;
      const stripped = only.t.height === 0 ? null : byName.get((only.t.name ?? "").replace(/^high\s+/i, "").toLowerCase());
      const other = only.t.height === 0
        ? byName.get(`high ${only.t.name?.toLowerCase() ?? ""}`) ?? null
        : stripped && stripped.id !== only.t.id ? stripped : lowest && lowest.id !== only.t.id ? lowest : null;
      if (!other) continue;
      if (only.t.height === 0) { lo = only; hi = { t: other, sx: 0, sy: 0, n: 1 }; side = only.sx / only.n < centre ? "sw" : "se"; }
      else { hi = only; lo = { t: other, sx: 0, sy: 0, n: 1 }; side = only.sx / only.n < centre ? "se" : "sw"; }
    }
    if (hi.t.height <= lo.t.height) continue;
    out.push({ id: d.id, name: d.name, width: d.width, height: d.height, low: lo.t.id, high: hi.t.id, side });
  }
  return out;
}

/**
 * Which ramps the isometric brush's cliffs can take, by tileset and terrain names —
 * measured (2026-09) by painting the plateau shape on every tileset with the editor's
 * own brush and asking its placement check, which since scm-js's fix checks only the
 * cells a doodad draws (StarEdit's rule, read off Blizzard's maps). A ramp not listed
 * here requires ground the brush never draws (Platform's Space walls, Ice's Outpost
 * walls), so offering it would only produce "no fit".
 */
export const VERIFIED_RAMPS: Record<string, [low: string, high: string][]> = {
  badlands: [["Dirt", "High Dirt"]],
  jungle: [["Dirt", "High Dirt"], ["Jungle", "Temple"], ["High Jungle", "High Temple"]],
  desert: [["Dirt", "High Dirt"], ["Sand Dunes", "Compound"], ["High Sand Dunes", "High Compound"]],
  twilight: [["Dirt", "High Dirt"], ["High Crushed Rock", "High Basilica"]],
  install: [["Substructure", "Floor"]],
  ashworld: [["Dirt", "High Dirt"]],
  platform: [["Low Platform", "Platform"]],
  ice: [["Snow", "High Snow"]],
};

/**
 * Which bridges the brush's shores can take, with the channel width (in tiles, the
 * band's width across the diagonal) that the bridge spans and the bank it stands on
 * — measured the same way, every width from one to ten on every bank. Jungle's big
 * bridges span a five-wide band (its small ones two), Platform's widest span five over
 * Low Platform banks, Desert's and Twilight's four, Ice's five. Badlands' bridges want
 * Asphalt-edge pieces beside the shore that no channel the brush draws produces, so
 * they are not offered; Installation and Ash World have no bridges.
 */
export const VERIFIED_BRIDGES: Record<string, { ground: string; water: string; channel: number } | undefined> = {
  jungle: { ground: "Dirt", water: "Water", channel: 5 },
  platform: { ground: "Low Platform", water: "Space", channel: 5 },
  desert: { ground: "Dirt", water: "Tar", channel: 4 },
  twilight: { ground: "Dirt", water: "Water", channel: 4 },
  ice: { ground: "Dirt", water: "Water", channel: 5 },
};

/** The distinct terrain pairs the ramps join, for the planner's request — those the brush's cliffs are known to take when `tileset` is given. */
export function rampPairs(ramps: readonly RampDoodad[], tileset?: string, types?: readonly TypeInfo[]): RampPair[] {
  const out: RampPair[] = [];
  for (const r of ramps) if (!out.some((p) => p.low === r.low && p.high === r.high)) out.push({ low: r.low, high: r.high });
  if (!tileset || !types) return out;
  const verified = VERIFIED_RAMPS[tileset];
  if (!verified) return out;
  const name = (id: number) => types.find((t) => t.id === id)?.name?.toLowerCase();
  return out.filter((p) => verified.some(([lo, hi]) => lo.toLowerCase() === name(p.low) && hi.toLowerCase() === name(p.high)));
}

/** The tileset's ramps, from the open map's palette and terrain types. */
export function rampsOf(api: PluginApi): RampDoodad[] {
  const doodads = api.palette.doodadCategories().flatMap((c) => c.doodads);
  return rampDoodads(doodads, api.terrain.types());
}

/** The ramp pairs the open map's tileset is known to take. */
export function rampPairsOf(api: PluginApi): RampPair[] {
  return rampPairs(rampsOf(api), api.document.info()?.tileset, api.terrain.types());
}

/* ── Bridges ────────────────────────────────────────────── */

export interface BridgeDoodad {
  id: number;
  name: string;
  width: number;
  height: number;
  /** Terrain ids of what it stands on and what it spans. */
  ground: number;
  water: number;
}

/**
 * The tileset's bridges: the doodads filed under a "Bridge" category, with the two
 * flat grounds they require — the bank they stand on and the water they span (the
 * one that is not buildable). Measured: a bridge fits a diagonal channel of water
 * exactly six tiles wide, on either diagonal, and no other water.
 */
export function bridgeDoodads(doodads: readonly DoodadInfo[], types: readonly (TypeInfo & { buildable?: boolean })[]): BridgeDoodad[] {
  const byGroup = new Map<number, TypeInfo & { buildable?: boolean }>();
  for (const t of types) { byGroup.set(t.group, t); byGroup.set(t.group + 1, t); }
  const out: BridgeDoodad[] = [];
  for (const d of doodads) {
    if (!/bridge/i.test(d.category) || !d.required?.length) continue;
    const flats = new Map<number, { t: TypeInfo & { buildable?: boolean }; n: number }>();
    for (const g of d.required) { const t = byGroup.get(g); if (t) { const e = flats.get(t.id) ?? { t, n: 0 }; e.n++; flats.set(t.id, e); } }
    const list = [...flats.values()];
    const water = list.find((e) => e.t.buildable === false || /water|lava|tar|ice/i.test(e.t.name ?? "")) ?? null;
    // Jungle's bridges require only the water: they stand on whatever ground, and the tileset's plain buildable ground is what a plan will use.
    const plain = [...types].filter((t) => t.height === 0 && t.buildable !== false).sort((a, b) => a.group - b.group)[0] ?? null;
    const ground = list.filter((e) => e !== water).sort((a, b) => b.n - a.n)[0] ?? (plain ? { t: plain, n: 0 } : null);
    if (!water || !ground) continue;
    out.push({ id: d.id, name: d.name, width: d.width, height: d.height, ground: ground.t.id, water: water.t.id });
  }
  return out;
}

/**
 * The pair the tileset's bridges use, for the planner's request; null without bridges.
 * With a tileset name, only what the brush's shores are known to take (`VERIFIED_BRIDGES`),
 * with the bank and channel width measured for it.
 */
export function bridgePair(bridges: readonly BridgeDoodad[], tileset?: string, types?: readonly TypeInfo[]): BridgePair | null {
  if (!bridges.length) return null;
  if (tileset && types) {
    const v = VERIFIED_BRIDGES[tileset];
    if (!v) return null;
    const ground = types.find((t) => t.name?.toLowerCase() === v.ground.toLowerCase()), water = types.find((t) => t.name?.toLowerCase() === v.water.toLowerCase());
    return ground && water ? { ground: ground.id, water: water.id, channel: v.channel } : null;
  }
  return { ground: bridges[0].ground, water: bridges[0].water };
}

/** The tileset's bridges, from the open map's palette and terrain types. */
export function bridgesOf(api: PluginApi): BridgeDoodad[] {
  const doodads = api.palette.doodadCategories().flatMap((c) => c.doodads);
  return bridgeDoodads(doodads, api.terrain.types());
}

/** The bridge pair the open map's tileset is known to take. */
export function bridgePairOf(api: PluginApi): BridgePair | null {
  return bridgePair(bridgesOf(api), api.document.info()?.tileset, api.terrain.types());
}

/* ── Fitting ────────────────────────────────────────────── */

export interface FittedDoodad {
  doodadId: number;
  tx: number;
  ty: number;
  name: string;
  width: number;
  height: number;
}
export type FittedRamp = FittedDoodad;

/**
 * Where, near a site, one of the candidate doodads fits: each tried at every top-left
 * tile within a window around the site, the fit whose centre is nearest the site
 * winning. `fits` is the editor's `query.doodadPlacement`, read after the terrain is
 * painted — so what is measured is the cliff or the shore the brush actually drew.
 */
export function fitDoodad(site: { x: number; y: number }, candidates: readonly { id: number; name: string; width: number; height: number }[], fits: (doodadId: number, tx: number, ty: number) => boolean, window = { dx: 12, dy: 8 }): FittedDoodad | null {
  let best: FittedDoodad | null = null;
  let bestD = Infinity;
  for (const r of candidates) {
    for (let ty = Math.round(site.y - r.height / 2) - window.dy; ty <= Math.round(site.y - r.height / 2) + window.dy; ty++) {
      for (let tx = Math.round(site.x - r.width / 2) - window.dx; tx <= Math.round(site.x - r.width / 2) + window.dx; tx++) {
        if (tx < 0 || ty < 0) continue;
        const cx = tx + r.width / 2, cy = ty + r.height / 2;
        const d = (cx - site.x) ** 2 + (cy - site.y) ** 2;
        if (d >= bestD) continue;
        if (!fits(r.id, tx, ty)) continue;
        best = { doodadId: r.id, tx, ty, name: r.name, width: r.width, height: r.height };
        bestD = d;
      }
    }
  }
  return best;
}

/** A ramp near a plan's ramp site: the tileset's ramps going that way (and joining its pair, when it names one). */
export function fitRamp(site: RampPlan, ramps: readonly RampDoodad[], fits: (doodadId: number, tx: number, ty: number) => boolean, window = { dx: 12, dy: 8 }): FittedRamp | null {
  const side: RampSide = site.direction === "se" ? "se" : "sw";
  return fitDoodad(site, ramps.filter((r) => r.side === side && (site.low === undefined || site.high === undefined || (r.low === site.low && r.high === site.high))), fits, window);
}
