/** Terrain writes and the map-level transactions. */
import type { Diamond, PluginApi } from "@scm-js/plugin-api";
import { doodadSnapshot, liftedFindings, removedDoodads } from "../render";
import { capResult, fail, jsonOf, list, num, obj, plural, rectOf, rectSchema, rectText, str, type TileRect, type Tool } from "./common";

/**
 * The diamonds a tile rect paints. The editor's `diamondsIn` is inclusive of the rect's
 * far edges, and a diamond on the far edge straddles the first row (or column) beyond
 * it; a rect that stops at a river would otherwise paint the river's first row. So the
 * far edge is left out unless it is the map's own edge, where the last lattice row and
 * column have nothing beyond them.
 */
export function paintableDiamonds(api: PluginApi, rect: TileRect): Diamond[] {
  const info = api.document.info();
  const W = info?.width ?? 0, H = info?.height ?? 0;
  return api.terrain.diamondsIn(rect).filter((d) => (d.y < rect.y1 || rect.y1 >= H) && (d.x * 2 < rect.x1 || rect.x1 >= W));
}

export function terrainTools(): Tool[] {
  return [
    {
      def: { name: "paint_terrain", description: "Paint a tile rect with a terrain id using the isometric brush: cliffs and shores form on their own and the brush bleeds about three tiles (guide \"terrain\"). `keep` lists terrain ids left alone inside the rect. One undo step.", inputSchema: obj({ ...rectSchema, terrain: { type: "integer" }, keep: { type: "array", items: { type: "integer" } } }, ["x0", "y0", "x1", "y1", "terrain"]) },
      describe: (input, { api }) => `Paint ${api.terrain.types().find((t) => t.id === num(input.terrain))?.name ?? `terrain ${str(input.terrain)}`} over ${rectText(input)}`,
      report: (result) => { const r = jsonOf(result); if (!r) return ""; const parts = [r.changed ? plural(num(r.tiles), "tile") : "nothing changed"]; if (r.paintedOver && typeof r.paintedOver === "object") parts.push(`over ${Object.entries(r.paintedOver as Record<string, number>).map(([k, v]) => `${k} ×${v}`).join(", ")}`); if (Array.isArray(r.notes) && r.notes.length) parts.push(String(r.notes[0])); return parts.join("; "); },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const terrain = num(input.terrain);
        const type = api.terrain.types().find((t) => t.id === terrain) ?? api.terrain.types().find((t) => t.name.toLowerCase() === str(input.terrain).toLowerCase());
        if (!type) return `Terrain ${str(input.terrain)} is not one of this tileset's types; see the reference.`;
        const keep = new Set(list<unknown>(input.keep).map((k) => api.terrain.types().find((t) => t.id === k || (typeof k === "string" && t.name.toLowerCase() === k.toLowerCase()))?.id).filter((id): id is number => id !== undefined));
        const nameOf = (id: number) => api.terrain.types().find((t) => t.id === id)?.name ?? `terrain ${id}`;
        const replaced: Record<string, number> = {};
        let kept = 0;
        const before = doodadSnapshot(api);
        const r = api.document.edit(`AI: paint ${type.name}`, (tx) => {
          if (api.terrain.hasIsom() && api.tileset.isLoaded()) {
            let refused = 0;
            for (const d of paintableDiamonds(api, rect)) {
              const was = api.terrain.terrainAt(d.x * 2, d.y);
              if (was !== null && keep.has(was)) { kept++; continue; }
              if (was !== null && was !== type.id) replaced[nameOf(was)] = (replaced[nameOf(was)] ?? 0) + 1;
              if (!tx.paintIsom(d, type.id, 1)) refused++;
            }
            if (refused) tx.note(`${refused} diamonds refused`);
          } else tx.stampTerrain(rect, type.id);
        });
        const stranded = r.notes.some((n) => /stranded doodad/.test(n)) ? removedDoodads(before, doodadSnapshot(api), null) : [];
        const notes = [...r.notes.filter((n) => !(stranded.length && /stranded doodad/.test(n))), ...liftedFindings(api, stranded, rect)];
        return capResult({ changed: r.changed, tiles: r.tiles, isom: r.isom, ...(Object.keys(replaced).length ? { paintedOver: replaced } : {}), ...(kept ? { kept } : {}), notes });
      },
    },
    {
      def: { name: "resize_map", description: "Resize / crop the map to width × height; `anchor` 0–8 says where the content stays (4 centre). Drops objects outside and clears the undo history: ask first.", inputSchema: obj({ width: { type: "integer" }, height: { type: "integer" }, anchor: { type: "integer" }, terrain: { type: "integer" } }, ["width", "height"]) },
      describe: (input) => `Resize the map to ${num(input.width)} × ${num(input.height)}`,
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const r = api.document.resize({ width: Math.round(num(input.width)), height: Math.round(num(input.height)), anchor: Math.round(num(input.anchor, 4)), terrainId: input.terrain === undefined ? undefined : Math.round(num(input.terrain)) });
        if (!r) return fail("No map is open.");
        const info = api.document.info();
        return `Resized to ${info?.width} × ${info?.height}. Dropped ${r.unitsDropped} units, ${r.spritesDropped} sprites, ${r.doodadsDropped} doodads; clamped ${r.locationsClamped} locations${r.isomRebuilt ? "" : "; ISOM is the fill's lattice"}. The undo history was cleared.`;
      },
    },
  ];
}
