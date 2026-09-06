/**
 * A plan onto the map, as one `document.edit`: the terrain first (the isometric brush
 * per lattice diamond, lowest ground first, so cliffs and shores draw themselves;
 * the Rect brush when the map has no ISOM or a diamond is refused), then bases laid
 * out with the vendored Melee Wizard geometry, ramps, decoration, units by name, and
 * locations. Everything the map refused or the plan could not name is returned as a
 * finding, along with what Check Map says afterwards, so a refinement round can tell
 * the model what went wrong.
 */
import type { EditResult, EditTransaction, PluginApi } from "@scm-js/plugin-api";
import { unitIdByName } from "./facts";
import { DEFAULT_GAS, DEFAULT_MINERALS, MINERAL_FIELDS, NEUTRAL, START_LOCATION, TILE, VESPENE_GEYSER, centreOf } from "./layout";
import {
  baseFootprint, checkPlan, chooseRamp, enforceSymmetry, paintGroups, placeBases, scatterDoodads, unitRect, usableSymmetry,
  type DoodadChoice, type PlanContext,
} from "./plan";
import { bridgePairOf, bridgesOf, fitDoodad, fitRamp, rampPairsOf, rampsOf } from "./ramps";
import { shapesToLayout } from "./shapes";
import type { LayoutPlan, MapPlan, TerrainVocab } from "../protocol";
import type { TileRect } from "./grid";

/** Tiles of matching ground a scattered doodad must have around it. */
const DOODAD_MARGIN = 2;


export interface RenderOptions {
  /** Where the plan's cell (0, 0) lies. */
  originX: number;
  originY: number;
  /** The undo entry's label. */
  label: string;
  /** Clear units, sprites and doodads inside the plan's area first (a region redo). */
  clearArea?: boolean;
}

export interface Rendered {
  result: EditResult;
  /** Refusals, unknown names, mended plan fields, and Check Map's issues afterwards. */
  findings: string[];
  /** What was placed, for the summary line. */
  placed: { diamonds: number; tiles: number; starts: number; resources: number; ramps: number; bridges: number; doodads: number; units: number; locations: number };
}

/** The plan's area in tiles, clamped to the map. */
export function planRect(plan: LayoutPlan, originX: number, originY: number, width: number, height: number): TileRect {
  return {
    x0: Math.max(0, originX),
    y0: Math.max(0, originY),
    x1: Math.min(width, originX + plan.columns * plan.cellSize),
    y1: Math.min(height, originY + plan.rows * plan.cellSize),
  };
}

function doodadChoices(api: PluginApi): Map<string, DoodadChoice[]> {
  const out = new Map<string, DoodadChoice[]>();
  for (const c of api.palette.doodadCategories()) out.set(c.name, c.doodads.map((d) => ({ id: d.id, name: d.name, category: c.name, width: d.width, height: d.height })));
  return out;
}

/**
 * Apply a plan. A `MapPlan` has its symmetry enforced on the grid and its bases
 * mirrored; a `LayoutPlan` is rendered as it is. Returns null when no map is open.
 */
export function renderPlan(api: PluginApi, input: LayoutPlan | MapPlan, options: RenderOptions): Rendered | null {
  const info = api.document.info();
  if (!info) return null;
  const terrains: TerrainVocab[] = api.terrain.types().map((t) => ({ id: t.id, name: t.name, height: t.height, buildable: t.buildable }));
  const ctx: PlanContext = { terrains, width: info.width, height: info.height, originX: options.originX, originY: options.originY };
  const tilesetRamps = rampsOf(api);
  const tilesetBridges = bridgesOf(api);
  const findings: string[] = [];
  // A shape plan is compiled to a one-tile grid first; from there on it is a plan like any other.
  if ("shapes" in input && input.shapes?.length) {
    const compiled = shapesToLayout(input as MapPlan, { width: info.width, height: info.height, terrains, rampPairs: rampPairsOf(api), bridgePair: bridgePairOf(api) });
    input = compiled.plan;
    findings.push(...compiled.findings);
  }
  const checked = checkPlan(input, ctx);
  findings.push(...checked.problems);
  let plan: LayoutPlan = checked.plan;
  const symmetry = "symmetry" in checked.plan ? usableSymmetry((checked.plan as MapPlan).symmetry, info.width, info.height) : "none";
  if ("symmetry" in checked.plan) {
    if ((checked.plan as MapPlan).symmetry !== symmetry) findings.push(`the ${(checked.plan as MapPlan).symmetry} symmetry needs a square map; laid out without one`);
    plan = enforceSymmetry({ ...(checked.plan as MapPlan), symmetry }, info.width, info.height);
  }
  const area = planRect(plan, options.originX, options.originY, info.width, info.height);
  const hasIsom = api.terrain.hasIsom();
  const hasTileset = api.tileset.isLoaded();
  const categories = doodadChoices(api);
  const ramps = [...categories.entries()].filter(([name]) => /ramp/i.test(name)).flatMap(([, list]) => list);
  const placed = { diamonds: 0, tiles: 0, starts: 0, resources: 0, ramps: 0, bridges: 0, doodads: 0, units: 0, locations: 0 };

  const result = api.document.edit(options.label, (tx) => {
    if (options.clearArea) clearArea(api, tx, area);

    // Terrain.
    if (!hasTileset) {
      findings.push("the tileset graphics are not loaded, so the terrain was not painted");
    } else if (hasIsom) {
      let refused = 0;
      for (const g of paintGroups(plan, ctx, api.terrain.diamondsIn(area))) {
        for (const d of g.diamonds) {
          if (tx.paintIsom(d, g.terrainId, 1)) placed.diamonds++;
          else refused++;
        }
      }
      if (refused > 0) findings.push(`${refused} diamond${refused === 1 ? "" : "s"} could not take the terrain the plan gave them (the brush found no piece that fits there)`);
    } else {
      findings.push("the map has no ISOM section, so the terrain was laid with the Rect brush and has no cliffs; Tools ▸ Repair Map can rebuild ISOM");
      const sampler = (tx0: number, ty0: number) => plan.legend[plan.grid[Math.floor((ty0 - ctx.originY) / plan.cellSize)]?.[Math.floor((tx0 - ctx.originX) / plan.cellSize)] ?? "?"];
      const byTerrain = new Map<number, number[]>();
      for (let y = area.y0; y < area.y1; y++) for (let x = area.x0; x < area.x1; x++) {
        const id = sampler(x, y);
        if (id === undefined) continue;
        let list = byTerrain.get(id);
        if (!list) { list = []; byTerrain.set(id, list); }
        list.push(y * info.width + x);
      }
      for (const [id, cells] of byTerrain) placed.tiles += tx.stampTerrain(cells, id);
    }

    // Bases.
    const occupied: TileRect[] = [];
    const bases = placeBases(plan.bases, symmetry, info.width, info.height);
    for (const b of bases) {
      occupied.push(baseFootprint(b));
      const c = centreOf(b.hall);
      if (b.player !== null) {
        if (tx.canPlaceUnit(START_LOCATION, c.x, c.y)) { tx.placeUnit(START_LOCATION, b.player - 1, c.x, c.y); placed.starts++; }
        else findings.push(`player ${b.player}'s start location at ${b.hall.x},${b.hall.y} is refused there (${describePlacement(api, START_LOCATION, c.x, c.y)})`);
      }
      let refusedHere = 0;
      b.layout.minerals.forEach((r, i) => {
        const rc = centreOf(r);
        const id = MINERAL_FIELDS[i % 3];
        if (!tx.canPlaceUnit(id, rc.x, rc.y)) { refusedHere++; return; }
        setResource(api, tx, tx.placeUnit(id, NEUTRAL, rc.x, rc.y), DEFAULT_MINERALS);
        placed.resources++;
      });
      for (const r of b.layout.geysers) {
        const rc = centreOf(r);
        if (!tx.canPlaceUnit(VESPENE_GEYSER, rc.x, rc.y)) { refusedHere++; continue; }
        setResource(api, tx, tx.placeUnit(VESPENE_GEYSER, NEUTRAL, rc.x, rc.y), DEFAULT_GAS);
        placed.resources++;
      }
      const short = b.layout.short.minerals + b.layout.short.geysers;
      if (refusedHere > 0 || short > 0) findings.push(`${b.kind} base at ${b.hall.x},${b.hall.y}${b.player ? ` (player ${b.player})` : ""}: ${refusedHere > 0 ? `${refusedHere} resource${refusedHere === 1 ? "" : "s"} refused by the terrain there` : ""}${refusedHere > 0 && short > 0 ? ", " : ""}${short > 0 ? `${short} did not fit on the ring` : ""}`);
    }

    // Ramps: where the editor's own check says one fits, near where the plan asked — the terrain is painted by now,
    // so the cliffs the brush drew are what is measured. Without the check (an older editor) the old guess by footprint.
    const canCheck = typeof api.query.doodadPlacement === "function" && tilesetRamps.length > 0;
    let guessed = 0;
    for (const r of plan.ramps) {
      if (canCheck) {
        const fit = fitRamp(r, tilesetRamps, (id, tx0, ty0) => api.query.doodadPlacement(id, tx0, ty0)?.ok === true);
        if (!fit) { findings.push(`ramp at ${r.x},${r.y} going ${r.direction}: no ramp of this tileset fits the cliff near there (a ramp needs a straight diagonal edge facing south-west or south-east, between ground it has a ramp for)`); continue; }
        const index = tx.placeDoodad(fit.doodadId, fit.tx, fit.ty);
        if (index < 0) findings.push(`ramp at ${r.x},${r.y} going ${r.direction}: ${fit.name} was refused at ${fit.tx},${fit.ty}`);
        else { placed.ramps++; occupied.push({ x0: fit.tx, y0: fit.ty, x1: fit.tx + fit.width, y1: fit.ty + fit.height }); }
        continue;
      }
      const choice = chooseRamp(r.direction, r.x, r.y, ramps);
      if (!choice) { findings.push(`ramp at ${r.x},${r.y} going ${r.direction}: this tileset has no ramp doodads, so it is left for you to place`); continue; }
      const index = tx.placeDoodad(choice.doodadId, choice.tx, choice.ty);
      if (index < 0) findings.push(`ramp at ${r.x},${r.y} going ${r.direction}: ${choice.name} does not fit there`);
      else { placed.ramps++; guessed++; occupied.push({ x0: choice.tx, y0: choice.ty, x1: choice.tx + choice.width, y1: choice.ty + choice.height }); }
    }
    if (guessed > 0) findings.push(`${guessed} ramp${guessed === 1 ? "" : "s"} placed by footprint; check their direction against the cliffs`);

    // Bridges, the same way: the tileset's bridges tried around the site, on the shores the brush drew.
    for (const b of plan.bridges ?? []) {
      if (!canCheck || tilesetBridges.length === 0) { findings.push(`bridge at ${b.x},${b.y}: ${tilesetBridges.length === 0 ? "this tileset has no bridges" : "the editor cannot check doodad placement"}; left for you to place`); continue; }
      const fit = fitDoodad(b, tilesetBridges, (id, tx0, ty0) => api.query.doodadPlacement(id, tx0, ty0)?.ok === true, { dx: 14, dy: 10 });
      if (!fit) { findings.push(`bridge at ${b.x},${b.y} along ${b.along}: no bridge of this tileset fits the water near there (a bridge spans a diagonal channel six tiles wide)`); continue; }
      const index = tx.placeDoodad(fit.doodadId, fit.tx, fit.ty);
      if (index < 0) findings.push(`bridge at ${b.x},${b.y}: ${fit.name} was refused at ${fit.tx},${fit.ty}`);
      else { placed.bridges++; occupied.push({ x0: fit.tx, y0: fit.ty, x1: fit.tx + fit.width, y1: fit.ty + fit.height }); }
    }

    // Units by name (before decoration, so it keeps clear of them).
    for (const u of plan.units) {
      const id = unitIdByName(api, u.unit);
      if (id === null) { findings.push(`no unit is called "${u.unit}"`); continue; }
      const size = api.palette.unitSize(id);
      const px = u.x * TILE + TILE / 2;
      const py = u.y * TILE + TILE / 2;
      const owner = u.player >= 12 ? NEUTRAL : u.player - 1;
      if (!tx.canPlaceUnit(id, px, py)) { findings.push(`${u.unit} at ${u.x},${u.y} is refused there (${describePlacement(api, id, px, py)})`); continue; }
      const index = tx.placeUnit(id, owner, px, py);
      if (u.amount !== undefined) setResource(api, tx, index, u.amount);
      placed.units++;
      const w = size ? Math.max(1, Math.round(size.width / TILE)) : 1;
      const hgt = size ? Math.max(1, Math.round(size.height / TILE)) : 1;
      occupied.push(unitRect(px, py, w, hgt));
    }

    // Decoration.
    const scattered = scatterDoodads(plan, ctx, categories, (r) => occupied.some((o) => o.x0 < r.x1 && r.x0 < o.x1 && o.y0 < r.y1 && r.y0 < o.y1), DOODAD_MARGIN);
    findings.push(...scattered.problems);
    // The plan says where a doodad may go; the ground as painted says whether it can: StarEdit's own rule for the
    // doodad (a water rock wants water under it), and flat ground of the asked-for terrain under the footprint and one
    // tile around it — the brush's shores and cliffs land where the lattice puts them, not where the plan's cells end.
    let refusedGround = 0;
    for (const d of scattered.placed) {
      if (canCheck && api.query.doodadPlacement(d.doodadId, d.tx, d.ty)?.ok === false) { refusedGround++; continue; }
      if (d.allowed?.length && !onFlatGround(api, tx, d, d.allowed)) { refusedGround++; continue; }
      if (tx.placeDoodad(d.doodadId, d.tx, d.ty) >= 0) placed.doodads++;
    }
    if (refusedGround > 0) findings.push(`${refusedGround} doodad${refusedGround === 1 ? "" : "s"} skipped: the ground the brush drew there was a shore, a cliff or another terrain`);

    // Locations.
    for (const l of plan.locations) {
      const index = tx.addLocation({ left: l.x0 * TILE, top: l.y0 * TILE, right: l.x1 * TILE, bottom: l.y1 * TILE }, l.name);
      if (index < 0) findings.push(`no free slot for location "${l.name}"`);
      else placed.locations++;
    }
  });

  findings.push(...result.notes.filter((n) => !findings.includes(n)));
  for (const issue of api.query.validate()) if (issue.level !== "info") findings.push(`Check Map: ${issue.text}${issue.where ? ` (${issue.where})` : ""}`);
  return { result, findings, placed };
}

/** Whether every tile of a doodad's footprint, and one tile around it, is flat ground of one of the terrains — read from the map as painted. */
function onFlatGround(api: PluginApi, tx: EditTransaction, d: { tx: number; ty: number; width: number; height: number }, allowed: readonly number[]): boolean {
  for (let y = d.ty - 1; y <= d.ty + d.height; y++) {
    for (let x = d.tx - 1; x <= d.tx + d.width; x++) {
      if (x < 0 || y < 0 || x >= tx.width || y >= tx.height) continue;
      const info = api.terrain.tileInfo(tx.groundAt(x, y));
      if (!info || info.kind !== "terrain") return false;
      const id = api.terrain.terrainAt(x, y);
      if (id === null || !allowed.includes(id)) return false;
    }
  }
  return true;
}

function setResource(api: PluginApi, tx: EditTransaction, index: number, amount: number) {
  if (index < 0) return;
  tx.updateUnits([index], (u) => ({ resourceAmount: amount, validStates: u.validStates | api.consts.unit.used.Resources }));
}

function describePlacement(api: PluginApi, unitId: number, px: number, py: number): string {
  const v = api.query.placement(unitId, px, py);
  return v?.reason ?? v?.problem ?? "unknown reason";
}

/** Remove the units, sprites and doodads inside an area (a region redo starts clean). */
export function clearArea(api: PluginApi, tx: EditTransaction, area: TileRect) {
  const rect = { x0: area.x0, y0: area.y0, x1: area.x1, y1: area.y1 };
  const units = api.query.unitsIn(rect);
  if (units.length) tx.removeUnits(units);
  const sprites = api.query.spritesIn(rect);
  if (sprites.length) tx.removeSprites(sprites);
  const doodads: number[] = [];
  const seen = new Set<number>();
  for (let y = area.y0; y < area.y1; y++) for (let x = area.x0; x < area.x1; x++) {
    const d = api.query.doodadAt(x, y);
    if (d >= 0 && !seen.has(d)) { seen.add(d); doodads.push(d); }
  }
  if (doodads.length) tx.removeDoodads(doodads);
}

/** One line for the status bar and the dialog. */
export function summarizeRender(r: Rendered): string {
  const p = r.placed;
  const parts: string[] = [];
  if (p.diamonds) parts.push(`${p.diamonds} diamonds painted`);
  if (p.tiles) parts.push(`${p.tiles} tiles laid`);
  if (p.starts) parts.push(`${p.starts} start location${p.starts === 1 ? "" : "s"}`);
  if (p.resources) parts.push(`${p.resources} resources`);
  if (p.ramps) parts.push(`${p.ramps} ramp${p.ramps === 1 ? "" : "s"}`);
  if (p.bridges) parts.push(`${p.bridges} bridge${p.bridges === 1 ? "" : "s"}`);
  if (p.doodads) parts.push(`${p.doodads} doodads`);
  if (p.units) parts.push(`${p.units} unit${p.units === 1 ? "" : "s"}`);
  if (p.locations) parts.push(`${p.locations} location${p.locations === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "nothing was placed";
}
