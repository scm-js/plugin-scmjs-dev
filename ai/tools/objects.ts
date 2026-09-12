/** Writes on objects: units, doodads, sprites, locations, fog. Each is one undo step. */
import type { PluginApi } from "@scm-js/plugin-api";
import { bag, bool, capResult, doodadByName, fail, fieldsGiven, indexList, ints, isAnyMineralName, list, num, obj, ownerName, ownerOf, placedReport, plural, rectOf, rectSchema, rectText, spriteByName, str, tally, TILE, unitIdByName, type Tool } from "./common";
import { mineralTypeAt } from "../layout";
import type { TileRect } from "../grid";

/**
 * The special-property tick each input key sets: the `stateFlags` bit and the
 * `validProperties` bit that says the game should read it. They are the same numbers, but
 * they are different fields, so the pair is spelled out rather than reused.
 */
const STATE_BITS = (c: PluginApi["consts"]) => [
  ["cloaked", c.unit.state.Cloaked, c.unit.valid.Cloak],
  ["burrowed", c.unit.state.Burrowed, c.unit.valid.Burrow],
  ["inTransit", c.unit.state.InTransit, c.unit.valid.InTransit],
  ["hallucinated", c.unit.state.Hallucinated, c.unit.valid.Hallucinated],
  ["invincible", c.unit.state.Invincible, c.unit.valid.Invincible],
] as const;

/** The elevations a location can exclude, by input key. A *set* bit excludes that height. */
const ELEVATION_BITS = (c: PluginApi["consts"]) => [
  ["excludeLowGround", c.location.elevation.LowGround],
  ["excludeMediumGround", c.location.elevation.MediumGround],
  ["excludeHighGround", c.location.elevation.HighGround],
  ["excludeLowAir", c.location.elevation.LowAir],
  ["excludeMediumAir", c.location.elevation.MediumAir],
  ["excludeHighAir", c.location.elevation.HighAir],
] as const;

/** A doodad the palette lists, as much of it as scattering needs. */
interface ScatterChoice { id: number; width: number; height: number }

/**
 * Scatter `want` doodads of `cat` over `rect`, each where `fits` says the editor would let
 * it stand. Flat ground alternates two CV5 groups by column and a doodad requires the exact
 * pair under it, so a spot on the right terrain still fits at one x parity only: a refused
 * spot is tried one tile to either side before it counts as refused. Footprints never
 * overlap within one scatter, whatever the check says. Random, one undo step.
 */
export function scatterInRect(api: PluginApi, cat: { name: string; doodads: readonly ScatterChoice[] }, rect: TileRect, want: number, fits: (d: ScatterChoice, x: number, y: number) => boolean, random: () => number = Math.random): { placed: number; refused: number } {
  let placed = 0, refused = 0;
  if (want <= 0) return { placed, refused };
  const taken: TileRect[] = [];
  const overlaps = (a: TileRect, b: TileRect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  api.document.edit(`AI: scatter ${cat.name}`, (tx) => {
    for (let attempt = 0; attempt < want * 8 && placed < want; attempt++) {
      const d = cat.doodads[Math.floor(random() * cat.doodads.length)];
      const x0 = rect.x0 + Math.floor(random() * Math.max(1, rect.x1 - rect.x0 - d.width + 1));
      const y0 = rect.y0 + Math.floor(random() * Math.max(1, rect.y1 - rect.y0 - d.height + 1));
      const open = (x: number) => x >= rect.x0 && x + d.width <= rect.x1 && !taken.some((t) => overlaps(t, { x0: x, y0, x1: x + d.width, y1: y0 + d.height })) && fits(d, x, y0);
      const x = open(x0) ? x0 : open(x0 + 1) ? x0 + 1 : open(x0 - 1) ? x0 - 1 : -1;
      if (x < 0) { refused++; continue; }
      if (tx.placeDoodad(d.id, x, y0) < 0) { refused++; continue; }
      taken.push({ x0: x, y0, x1: x + d.width, y1: y0 + d.height });
      placed++;
    }
  });
  return { placed, refused };
}

export function objectTools(): Tool[] {
  return [
    {
      def: { name: "place_units", description: "Place units by name at tile centres for a 1-based player (12 neutral); `amount` sets a resource. Refused positions are reported, not forced. One undo step.", inputSchema: obj({ units: { type: "array", items: obj({ unit: { type: "string" }, player: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" }, amount: { type: "integer" } }, ["unit", "player", "x", "y"]) } }, ["units"]) },
      describe: (input) => { const u = list(input.units); return u.length ? `Place ${tally(u.map((x) => str(x.unit)))} for ${ownerName(ownerOf(u[0].player, 0))} near ${num(u[0].x)},${num(u[0].y)}` : "Place units"; },
      report: placedReport,
      writes: true,
      run: (input, { api }) => {
        const wanted = list(input.units);
        const placed: unknown[] = [];
        const refused: string[] = [];
        api.document.edit("AI: place units", (tx) => {
          for (const u of wanted) {
            const named = unitIdByName(api, str(u.unit));
            if (named === null) { refused.push(`no unit called "${str(u.unit)}"`); continue; }
            // "minerals" names no particular one of the three looks, so the tile picks it and a scattering of patches is mixed.
            const id = isAnyMineralName(str(u.unit)) ? mineralTypeAt(num(u.x), num(u.y)) : named;
            const px = num(u.x) * TILE + TILE / 2, py = num(u.y) * TILE + TILE / 2;
            const owner = ownerOf(u.player, 0);
            if (!tx.canPlaceUnit(id, px, py)) { refused.push(`${api.names.unit(id)} at ${num(u.x)},${num(u.y)}: ${api.query.placement(id, px, py)?.reason ?? "refused"}`); continue; }
            const index = tx.placeUnit(id, owner, px, py);
            if (u.amount !== undefined) tx.updateUnits([index], (rec) => ({ resourceAmount: num(u.amount), validStates: rec.validStates | api.consts.unit.used.Resources }));
            placed.push({ index, unit: api.names.unit(id), x: num(u.x), y: num(u.y) });
          }
        });
        return capResult({ placed, refused });
      },
    },
    {
      def: { name: "remove_units", description: "Remove units by index (from list_units). One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      describe: (input) => `Remove ${plural(ints(input.indices).length, "unit")} ${indexList(ints(input.indices))}`,
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove units", (tx) => { tx.removeUnits(ints(input.indices)); }); return `Removed ${plural(r.units, "unit")}.`; },
    },
    {
      def: { name: "move_units", description: "Move units by index to new tile centres. One undo step.", inputSchema: obj({ moves: { type: "array", items: obj({ index: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" } }, ["index", "x", "y"]) } }, ["moves"]) },
      describe: (input) => `Move ${plural(list(input.moves).length, "unit")}`,
      writes: true,
      run: (input, { api }) => {
        let n = 0;
        api.document.edit("AI: move units", (tx) => {
          for (const m of list(input.moves)) {
            const index = num(m.index, -1);
            if (index < 0 || index >= tx.scenario.units.length) continue;
            n += tx.updateUnits([index], () => ({ x: num(m.x) * TILE + TILE / 2, y: num(m.y) * TILE + TILE / 2 }));
          }
        });
        return `Moved ${plural(n, "unit")}.`;
      },
    },
    {
      def: { name: "update_units", description: "Change fields of units by index: owner, hitPoints / shields / energy (%), resources, hangar, and the flags cloaked, burrowed, inTransit, hallucinated, invincible. Only the fields given change. One undo step.", inputSchema: bag({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      describe: (input) => `Set ${fieldsGiven(input, ["owner", "hitPoints", "shields", "energy", "resources", "hangar", "cloaked", "burrowed", "inTransit", "hallucinated", "invincible"]) || "properties"} on ${plural(ints(input.indices).length, "unit")}`,
      writes: true,
      run: (input, { api }) => {
        const indices = ints(input.indices);
        const used0 = api.consts.unit.used;
        const pct = (v: unknown) => Math.max(0, Math.min(100, Math.round(num(v))));
        let n = 0;
        api.document.edit("AI: unit properties", (tx) => {
          n = tx.updateUnits(indices, (rec) => {
            const patch: Record<string, number> = {};
            let used = rec.validStates;
            let flags = rec.stateFlags;
            let valid = rec.validProperties;
            if (input.owner !== undefined) { patch.owner = ownerOf(input.owner, rec.owner); used |= used0.Owner; }
            if (input.hitPoints !== undefined) { patch.hitPointsPercent = pct(input.hitPoints); used |= used0.HitPoints; }
            if (input.shields !== undefined) { patch.shieldPercent = pct(input.shields); used |= used0.Shields; }
            if (input.energy !== undefined) { patch.energyPercent = pct(input.energy); used |= used0.Energy; }
            if (input.resources !== undefined) { patch.resourceAmount = Math.max(0, Math.round(num(input.resources))); used |= used0.Resources; }
            if (input.hangar !== undefined) { patch.hangarUnits = Math.max(0, Math.round(num(input.hangar))); used |= used0.Hangar; }
            for (const [key, stateBit, validBit] of STATE_BITS(api.consts)) {
              const v = bool(input[key]);
              if (v === undefined) continue;
              flags = v ? flags | stateBit : flags & ~stateBit;
              valid |= validBit;
              used |= used0.State;
            }
            return { ...patch, validStates: used, stateFlags: flags, validProperties: valid };
          });
        });
        return `Updated ${plural(n, "unit")}.`;
      },
    },
    {
      def: { name: "place_doodads", description: "Place doodads by name, id or category name with the top-left at a tile; one that does not fit is refused. One undo step.", inputSchema: obj({ doodads: { type: "array", items: obj({ doodad: { type: "string" }, x: { type: "integer" }, y: { type: "integer" } }, ["doodad", "x", "y"]) } }, ["doodads"]) },
      describe: (input) => { const d = list(input.doodads); return d.length ? `Place ${tally(d.map((x) => str(x.doodad)))} near ${num(d[0].x)},${num(d[0].y)}` : "Place doodads"; },
      report: placedReport,
      writes: true,
      run: (input, { api }) => {
        const placed: unknown[] = [];
        const refused: string[] = [];
        api.document.edit("AI: place doodads", (tx) => {
          for (const d of list(input.doodads)) {
            const def = doodadByName(api, str(d.doodad));
            if (!def) { refused.push(`no doodad called "${str(d.doodad)}"`); continue; }
            const index = tx.placeDoodad(def.id, Math.round(num(d.x)), Math.round(num(d.y)));
            if (index < 0) refused.push(`${def.name} at ${num(d.x)},${num(d.y)} does not fit`);
            else placed.push({ index, name: def.name, x: num(d.x), y: num(d.y), width: def.width, height: def.height });
          }
        });
        return capResult({ placed, refused });
      },
    },
    {
      def: { name: "remove_doodads", description: "Remove doodads by index; the ground under them is restored. One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      describe: (input) => `Remove ${plural(ints(input.indices).length, "doodad")} ${indexList(ints(input.indices))}`,
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove doodads", (tx) => { tx.removeDoodads(ints(input.indices)); }); return `Removed ${plural(r.doodads, "doodad")}.`; },
    },
    {
      def: { name: "convert_doodads", description: "Turn doodads (by index) into plain terrain tiles, an overlay into a sprite — for touching a ramp or cliff piece up tile by tile. One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      describe: (input) => `Convert ${plural(ints(input.indices).length, "doodad")} to terrain`,
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: convert doodads to terrain", (tx) => { tx.convertDoodads(ints(input.indices)); }); return `Converted ${plural(r.doodads, "doodad")} to terrain.`; },
    },
    {
      def: { name: "scatter_doodads", description: "Scatter a category's doodads over a rect at density 0–1 where the editor's rule lets them stand (a category on its own ground: Water on water); refusals are counted. One undo step.", inputSchema: obj({ category: { type: "string" }, ...rectSchema, density: { type: "number" } }, ["category", "x0", "y0", "x1", "y1"]) },
      describe: (input) => `Scatter ${str(input.category)} over ${rectText(input)}`,
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const cat = api.palette.doodadCategories().find((c) => c.name.toLowerCase() === str(input.category).toLowerCase()) ?? api.palette.doodadCategories().find((c) => c.name.toLowerCase().includes(str(input.category).toLowerCase()));
        if (!cat || cat.doodads.length === 0) return fail(`No doodad category called "${str(input.category)}"; call list_doodad_categories.`);
        const density = Math.max(0, Math.min(1, num(input.density, 0.3)));
        const want = Math.round(density * ((rect.x1 - rect.x0) * (rect.y1 - rect.y0)) / 12);
        const { placed, refused } = scatterInRect(api, cat, rect, want, (d, x, y) => api.query.doodadPlacement(d.id, x, y)?.ok === true);
        if (placed === want) return `Placed ${placed} of ${want} wanted.`;
        return `Placed ${placed} of ${want} wanted; ${plural(refused, "spot")} refused because the ground there is not what ${cat.name} doodads stand on (or another doodad is there). To place more, scatter over the ${cat.name} ground itself.`;
      },
    },
    {
      def: { name: "place_sprites", description: "Place sprites at tile centres: kind pure (a sprites.dat image by name or id) or unit (a unit drawn as a sprite); each may add player (1-based), flipped, disabled. One undo step.", inputSchema: obj({ sprites: { type: "array", items: bag({ kind: { type: "string", enum: ["pure", "unit"] }, sprite: { type: "string" }, x: { type: "integer" }, y: { type: "integer" } }, ["kind", "sprite", "x", "y"]) } }, ["sprites"]) },
      describe: (input) => { const sp = list(input.sprites); return sp.length ? `Place sprites: ${tally(sp.map((x) => str(x.sprite)))} near ${num(sp[0].x)},${num(sp[0].y)}` : "Place sprites"; },
      report: placedReport,
      writes: true,
      run: (input, { api }) => {
        const placed: unknown[] = [];
        const refused: string[] = [];
        api.document.edit("AI: place sprites", (tx) => {
          for (const s of list(input.sprites)) {
            const kind = str(s.kind) === "unit" ? "unit" : "pure";
            const id = spriteByName(api, kind, str(s.sprite));
            if (id === null) { refused.push(`no ${kind} sprite called "${str(s.sprite)}"`); continue; }
            const index = tx.placeSprite(kind, id, ownerOf(s.player, 0), num(s.x) * TILE + TILE / 2, num(s.y) * TILE + TILE / 2, { flipped: bool(s.flipped) ?? false, disabled: bool(s.disabled) ?? (kind === "unit") });
            placed.push({ index, kind, name: api.palette.spriteName(kind, id), x: num(s.x), y: num(s.y) });
          }
        });
        return capResult({ placed, refused });
      },
    },
    {
      def: { name: "remove_sprites", description: "Remove sprites by index (from list_sprites). One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      describe: (input) => `Remove ${plural(ints(input.indices).length, "sprite")}`,
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove sprites", (tx) => { tx.removeSprites(ints(input.indices)); }); return `Removed ${plural(r.sprites, "sprite")}.`; },
    },
    {
      def: { name: "add_location", description: "Add a named location over a tile rect. One undo step.", inputSchema: obj({ name: { type: "string" }, ...rectSchema }, ["name", "x0", "y0", "x1", "y1"]) },
      describe: (input) => `Add location "${str(input.name, "Location")}" at ${rectText(input)}`,
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        let index = -1;
        api.document.edit(`AI: location ${str(input.name)}`, (tx) => { index = tx.addLocation({ left: rect.x0 * TILE, top: rect.y0 * TILE, right: rect.x1 * TILE, bottom: rect.y1 * TILE }, str(input.name, "Location")); });
        return index < 0 ? "No free location slot." : `Added location ${index} "${str(input.name)}".`;
      },
    },
    {
      def: { name: "edit_location", description: "Edit a location by slot `index`: name, x0 / y0 / x1 / y1 (a tile rect), excludeLowGround / excludeMediumGround / excludeHighGround / excludeLowAir / excludeMediumAir / excludeHighAir. Only the fields given change. One undo step.", inputSchema: bag({ index: { type: "integer" } }, ["index"]) },
      describe: (input) => `Edit location #${num(input.index)}: ${[input.name !== undefined && "name", input.x0 !== undefined && "area", Object.keys(input).some((k) => k.startsWith("exclude")) && "heights"].filter(Boolean).join(", ") || "nothing"}`,
      writes: true,
      run: (input, { api }) => {
        const index = Math.round(num(input.index, -1));
        const scn = api.document.scenario();
        if (!scn || index < 0 || index >= scn.locations.length || index === api.consts.location.anywhere) return fail("No such location (slot 63 is Anywhere).");
        const patch: Record<string, unknown> = {};
        if (typeof input.name === "string") patch.name = input.name;
        if (input.x0 !== undefined && input.x1 !== undefined) { const r = rectOf(input, api); Object.assign(patch, { left: r.x0 * TILE, top: r.y0 * TILE, right: r.x1 * TILE, bottom: r.y1 * TILE }); }
        const bits = ELEVATION_BITS(api.consts);
        if (bits.some(([k]) => input[k] !== undefined)) {
          let flags = scn.locations[index].elevationFlags;
          for (const [k, bit] of bits) { const v = bool(input[k]); if (v !== undefined) flags = v ? flags | bit : flags & ~bit; }
          patch.elevationFlags = flags;
        }
        let ok = false;
        api.document.edit(`AI: edit location ${api.names.location(index)}`, (tx) => { ok = tx.editLocation(index, patch); });
        return ok ? `Edited location ${index}.` : "Nothing changed.";
      },
    },
    {
      def: { name: "remove_locations", description: "Remove locations by slot index. One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      describe: (input) => `Remove ${plural(ints(input.indices).length, "location")} ${indexList(ints(input.indices))}`,
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove locations", (tx) => { tx.removeLocations(ints(input.indices).filter((i) => i !== api.consts.location.anywhere)); }); return `Removed ${plural(r.locations, "location")}.`; },
    },
    {
      def: { name: "set_fog", description: "Fog of war over a rect for 1-based players: mode fog (starts unexplored) or clear. One undo step.", inputSchema: obj({ ...rectSchema, players: { type: "array", items: { type: "integer" } }, mode: { type: "string", enum: ["fog", "clear"] } }, ["x0", "y0", "x1", "y1", "players", "mode"]) },
      describe: (input) => `${str(input.mode) === "clear" ? "Clear" : "Fog"} ${rectText(input)} for player${ints(input.players).length === 1 ? "" : "s"} ${ints(input.players).join(", ")}`,
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const players = ints(input.players).filter((p) => p >= 1 && p <= 8);
        const mask = players.reduce((m, p) => m | (1 << (p - 1)), 0);
        const r = api.document.edit("AI: fog of war", (tx) => { tx.setFog(rect, mask, str(input.mode) === "clear" ? "clear" : "fog"); });
        return `Changed ${plural(r.fog, "tile")}.`;
      },
    },
  ];
}
