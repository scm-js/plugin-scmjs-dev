import { describe, expect, it } from "vitest";
import { BRIDGE_CHANNEL, channelEnds, compileShapes, insideCutRect, rampSite, RAMP_CUT, shapesToLayout, shiftShapes, type ShapeContext } from "../ai/shapes";
import { bridgeDoodads, bridgePair, fitRamp, rampDoodads, rampPairs } from "../ai/ramps";
import type { MapPlan, TerrainVocab } from "../protocol";

const terrains: TerrainVocab[] = [
  { id: 2, name: "Dirt", height: 0, buildable: true },
  { id: 3, name: "High Dirt", height: 1, buildable: true },
  { id: 5, name: "Water", height: 0, buildable: false },
  { id: 8, name: "Jungle", height: 0, buildable: true },
  { id: 10, name: "High Jungle", height: 1, buildable: true },
];
const ctx: ShapeContext = { width: 64, height: 64, terrains, rampPairs: [{ low: 2, high: 3 }] };
const at = (c: Int32Array, x: number, y: number) => c[y * 64 + x];

describe("the shape compiler", () => {
  it("paints in order, later over earlier, and skips what it cannot name", () => {
    const { cells, findings } = compileShapes([
      { op: "ground", terrain: 8 },
      { op: "rect", terrain: 5, x: 10, y: 10, w: 10, h: 6, cut: 0 },
      { op: "ellipse", terrain: 2, cx: 40, cy: 40, rx: 6, ry: 3 },
      { op: "rect", terrain: 99, x: 0, y: 0, w: 4, h: 4 },
    ], ctx);
    expect(at(cells, 0, 0)).toBe(8);
    expect(at(cells, 12, 12)).toBe(5);
    expect(at(cells, 40, 40)).toBe(2);
    expect(at(cells, 40, 44)).toBe(8);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("99");
  });

  it("cuts corners at the lattice's 2:1 slope", () => {
    const r = { x0: 0, y0: 0, x1: 20, y1: 10 };
    const cuts = { nw: 3, ne: 0, sw: 0, se: 0 };
    expect(insideCutRect(r, cuts, 0, 0)).toBe(false);
    expect(insideCutRect(r, cuts, 5, 0)).toBe(true);
    expect(insideCutRect(r, cuts, 0, 3)).toBe(true);
    expect(insideCutRect(r, cuts, 1, 1)).toBe(false);
    expect(insideCutRect(r, cuts, 19, 0)).toBe(true);
  });

  it("gives a plateau with a ramp a deep south-facing cut, the ramp pair either side of the site, and a ramp record", () => {
    const { cells, ramps, findings } = compileShapes([
      { op: "ground", terrain: 8 },
      { op: "plateau", terrain: 10, x: 10, y: 10, w: 30, h: 20, ramps: ["se"] },
    ], ctx);
    expect(findings).toEqual([]);
    expect(ramps).toHaveLength(1);
    const site = rampSite({ x0: 10, y0: 10, x1: 40, y1: 30 }, { nw: 2, ne: 2, sw: 2, se: RAMP_CUT }, "se");
    expect(ramps[0]).toMatchObject({ x: site.x, y: site.y, direction: "se", low: 2, high: 3 });
    // The south-east corner is gone (its foot is the pair's low ground); the north-east corner has only its small cut.
    expect(at(cells, 39, 29)).toBe(2);
    expect(at(cells, 25, 12)).toBe(10);
    expect(at(cells, 60, 60)).toBe(8);
    // High Dirt just inside the site, Dirt just outside, High Jungle elsewhere on top.
    expect(at(cells, site.x - 3, site.y - 2)).toBe(3);
    expect(at(cells, site.x + 2, site.y + 1)).toBe(2);
    expect(at(cells, 12, 12)).toBe(10);
  });

  it("says when a plateau's height has no ramp in this tileset", () => {
    const { ramps, findings } = compileShapes([{ op: "plateau", terrain: 10, x: 10, y: 10, w: 30, h: 20, ramps: ["sw"] }], { ...ctx, rampPairs: [] });
    expect(ramps).toEqual([]);
    expect(findings[0]).toContain("no ramp");
  });

  it("lays a lane as a continuous band with walls either side, wider than asked by what the shores eat", () => {
    const { cells } = compileShapes([
      { op: "ground", terrain: 8 },
      { op: "lane", terrain: 2, points: [[20, 5], [20, 50], [50, 50]], width: 4, wall: 5, wallWidth: 2 },
    ], ctx);
    for (let y = 5; y <= 50; y++) expect(at(cells, 20, y)).toBe(2);
    for (let x = 20; x <= 50; x++) expect(at(cells, x, 50)).toBe(2);
    // Band: 4 + 7 wide (x 14.5 … 25.5); water walls at least 4 beyond.
    expect(at(cells, 15, 20)).toBe(2);
    expect(at(cells, 12, 20)).toBe(5);
    expect(at(cells, 8, 20)).toBe(8);
    // Two lanes that converge: the second's wall does not cut the first's floor.
    const pair = compileShapes([
      { op: "ground", terrain: 8 },
      { op: "lane", terrain: 2, points: [[20, 5], [30, 60]], width: 4, wall: 5 },
      { op: "lane", terrain: 2, points: [[44, 5], [34, 60]], width: 4, wall: 5 },
    ], ctx).cells;
    expect(at(pair, 30, 59)).toBe(2);
    expect(at(pair, 34, 59)).toBe(2);
    // A cliff wall pads less and is at least six thick.
    const cliff = compileShapes([{ op: "ground", terrain: 8 }, { op: "lane", terrain: 2, points: [[20, 5], [20, 50]], width: 4, wall: 10, wallWidth: 2 }], ctx).cells;
    expect(at(cliff, 17, 20)).toBe(2);
    expect(at(cliff, 15, 20)).toBe(10);
    expect(at(cliff, 11, 20)).toBe(10);
    expect(at(cliff, 8, 20)).toBe(8);
  });

  it("paints a bridge's channel and banks, records the crossing with its ends, and says what it stamped", () => {
    const { cells, bridges, findings } = compileShapes([{ op: "ground", terrain: 10 }, { op: "bridge", x: 32, y: 32, along: "se" }], { ...ctx, bridgePair: { ground: 2, water: 5 } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("channel along se from 18,25 to 46,39");
    expect(findings[0]).toContain("water must reach both ends");
    expect(bridges).toEqual([{ x: 32, y: 32, along: "se", ends: channelEnds(32, 32, "se") }]);
    expect(at(cells, 32, 32)).toBe(5);
    expect(at(cells, 38, 35)).toBe(5);
    expect(at(cells, 32, 26)).toBe(2);
    expect(at(cells, 5, 5)).toBe(10);
    expect(compileShapes([{ op: "bridge", x: 3, y: 3 }], ctx).findings[0]).toContain("no bridges");
  });

  describe("a river with bridges", () => {
    const river = { ...ctx, width: 128, height: 128, bridgePair: { ground: 2, water: 5, channel: BRIDGE_CHANNEL } };
    const wide = (c: Int32Array, x: number, y: number) => c[y * 128 + x];
    // Along the diagonal's normal: how many tiles of water lie across the river at a point of the se diagonal (2:1), the normal being (1, -2).
    const across = (c: Int32Array, x: number, y: number) => { let n = 0; for (let k = -12; k <= 12; k++) { const px = Math.round(x + k / Math.sqrt(5)), py = Math.round(y - 2 * k / Math.sqrt(5)); if (wide(c, px, py) === 5) n++; } return n; };

    it("bends the river onto the diagonal through the site, narrows it to the channel and fits the bridge", () => {
      const { cells, bridges, findings } = compileShapes([
        { op: "ground", terrain: 8 },
        { op: "stroke", terrain: 5, width: 14, points: [[4, 4], [124, 124]], bridges: [[64, 64]] },
      ], river);
      expect(bridges).toEqual([{ x: 64, y: 64, along: "se", ends: channelEnds(64, 64, "se") }]);
      expect(findings).toEqual(["shape 2 (stroke): bridge at 64,64 along se; the river narrows to its 5-wide channel from 50,57 to 78,71"]);
      // The channel at the site is the channel's width, in water, with the bridge's ground either side.
      expect(across(cells, 64, 64)).toBeLessThanOrEqual(BRIDGE_CHANNEL + 1);
      expect(across(cells, 64, 64)).toBeGreaterThanOrEqual(BRIDGE_CHANNEL - 1);
      expect(wide(cells, 64, 64)).toBe(5);
      expect(wide(cells, 64, 58)).toBe(2);
      expect(wide(cells, 64, 70)).toBe(2);
      // Water runs without a break along the diagonal from where the river bends onto it, through the channel, to where it bends off.
      for (let k = -11; k <= 11; k++) expect(wide(cells, 64 + 2 * k, 64 + k)).toBe(5);
      // And the bend is local: the river's own line is still water beyond the taper.
      expect(wide(cells, 36, 36)).toBe(5);
      expect(wide(cells, 92, 92)).toBe(5);
      // The river is its full width away from the bridge.
      expect(wide(cells, 20, 20)).toBe(5);
      expect(wide(cells, 20, 26)).toBe(5);
      expect(wide(cells, 20, 14)).toBe(5);
      expect(wide(cells, 100, 100)).toBe(5);
    });

    it("picks the diagonal nearest the river's own direction, or takes the one named", () => {
      const auto = compileShapes([{ op: "stroke", terrain: 5, width: 10, points: [[120, 8], [8, 120]], bridges: [[64, 64]] }], river);
      expect(auto.bridges[0]).toMatchObject({ along: "sw" });
      const named = compileShapes([{ op: "stroke", terrain: 5, width: 10, points: [[64, 4], [64, 124]], bridges: [{ x: 64, y: 64, along: "se" }] }], river);
      expect(named.bridges[0]).toMatchObject({ along: "se" });
      // A north-south river bends onto the diagonal and back: water at the channel's ends and beyond them on the river's own line.
      expect(wide(named.cells, 50, 57)).toBe(5);
      expect(wide(named.cells, 78, 71)).toBe(5);
      expect(wide(named.cells, 64, 20)).toBe(5);
      expect(wide(named.cells, 64, 110)).toBe(5);
    });

    it("paints a bank that bends with the river, and the bridge's ground over the bank at the channel", () => {
      const { cells } = compileShapes([{ op: "ground", terrain: 8 }, { op: "stroke", terrain: 5, width: 10, points: [[64, 4], [64, 124]], bridges: [{ x: 64, y: 64, along: "se" }], bank: 3, bankWidth: 6 }], river);
      expect(wide(cells, 64, 20)).toBe(5);
      expect(wide(cells, 72, 20)).toBe(3);
      expect(wide(cells, 80, 20)).toBe(8);
      // Where the river has bent toward the diagonal, the bridge's ground goes with it, over the bank.
      expect(wide(cells, 45, 42)).toBe(5);
      expect(wide(cells, 40, 36)).toBe(2);
      expect(wide(cells, 64, 58)).toBe(2);
    });

    it("skips a second bridge closer than a channel is long, paints without bridges where the tileset has none, and shifts its sites", () => {
      const close = compileShapes([{ op: "stroke", terrain: 5, width: 10, points: [[4, 4], [124, 124]], bridges: [[40, 40], [50, 50]] }], river);
      expect(close.bridges).toHaveLength(1);
      expect(close.findings.some((f) => f.includes("50,50") && f.includes("skipped"))).toBe(true);
      const none = compileShapes([{ op: "stroke", terrain: 5, width: 10, points: [[4, 4], [124, 124]], bridges: [[64, 64]] }], { ...river, bridgePair: null });
      expect(none.bridges).toEqual([]);
      expect(none.findings[0]).toContain("no bridges");
      expect(wide(none.cells, 64, 64)).toBe(5);
      expect(shiftShapes([{ op: "stroke", terrain: 5, points: [[0, 0], [8, 8]], bridges: [[4, 4], { x: 6, y: 6, along: "sw" }] }], 10, 20)[0].bridges).toEqual([[14, 24], { x: 16, y: 26, along: "sw" }]);
    });
  });

  it("fills polygons and borders", () => {
    const { cells } = compileShapes([
      { op: "ground", terrain: 8 },
      { op: "polygon", terrain: 5, points: [[20, 20], [40, 20], [30, 40]] },
      { op: "border", terrain: 5, width: 2 },
    ], ctx);
    expect(at(cells, 30, 25)).toBe(5);
    expect(at(cells, 21, 38)).toBe(8);
    expect(at(cells, 0, 30)).toBe(5);
    expect(at(cells, 2, 30)).toBe(8);
  });

  it("turns a shape plan into a one-tile layout with a legend and doodad characters", () => {
    const plan: MapPlan = {
      name: "n", description: "", symmetry: "quad", cellSize: 4, columns: 0, rows: 0, legend: {}, grid: [],
      shapes: [{ op: "ground", terrain: 8 }, { op: "rect", terrain: 5, x: 0, y: 0, w: 8, h: 8, cut: 0 }],
      bases: [], ramps: [], doodads: [{ category: "Water", on: "", terrains: [5], density: 0.3 }], units: [], locations: [], notes: [],
    };
    const { plan: out } = shapesToLayout(plan, ctx);
    expect(out.cellSize).toBe(1);
    expect(out.columns).toBe(64);
    expect(out.grid).toHaveLength(64);
    expect(out.symmetry).toBe("none");
    const water = Object.entries(out.legend).find(([, id]) => id === 5)![0];
    expect(out.grid[0][0]).toBe(water);
    expect(out.doodads[0].on).toBe(water);
  });
});

describe("ramps from the tileset's data", () => {
  // Two 6×6 ramps the way Badlands files them: required groups of Dirt (2/3) and High Dirt (4/5) around cliff pieces (50+).
  const types = [{ id: 2, group: 2, height: 0 as const, name: "Dirt" }, { id: 3, group: 4, height: 1 as const, name: "High Dirt" }];
  const sw = { id: 77, name: "Cliff #77", category: "Cliff", width: 6, height: 6, ramp: true, required: [52, 53, 4, 5, 4, 5, 54, 55, 52, 53, 4, 5, 56, 57, 54, 55, 52, 53, 2, 3, 56, 57, 54, 55, 2, 3, 2, 3, 56, 57, 2, 3, 2, 3, 2, 3] };
  const se = { id: 78, name: "Cliff #78", category: "Cliff", width: 6, height: 6, ramp: true, required: [4, 5, 4, 5, 58, 59, 4, 5, 58, 59, 60, 61, 58, 59, 60, 61, 62, 63, 60, 61, 62, 63, 2, 3, 62, 63, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3] };
  const tree = { id: 7, name: "Trees #7", category: "Trees", width: 2, height: 1, ramp: false, required: [0, 0] };

  it("reads the pair and the side off the required groups", () => {
    const ramps = rampDoodads([sw, se, tree], types);
    expect(ramps).toHaveLength(2);
    expect(ramps[0]).toMatchObject({ id: 77, low: 2, high: 3, side: "sw" });
    expect(ramps[1]).toMatchObject({ id: 78, low: 2, high: 3, side: "se" });
    expect(rampPairs(ramps)).toEqual([{ low: 2, high: 3 }]);
    // Only what the brush's cliffs are known to take, by tileset: Badlands takes Dirt/High Dirt; Ice takes Snow/High Snow, so a Dirt pair is refused there.
    expect(rampPairs(ramps, "badlands", types)).toEqual([{ low: 2, high: 3 }]);
    expect(rampPairs(ramps, "ice", types)).toEqual([]);
  });

  it("names the other side when a ramp requires only one, and takes heights that skip a level", () => {
    // Ice's cliff ramps name only the snow below; Badlands calls High Dirt height 2 with nothing at 1.
    const ice = [{ id: 2, group: 2, height: 0 as const, name: "Snow" }, { id: 3, group: 4, height: 1 as const, name: "High Snow" }];
    const snowOnly = { id: 0, name: "Cliff #0", category: "Cliff", width: 8, height: 5, ramp: true, required: [238, 239, 50, 51, 52, 53, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 2, 3, 54, 55, 0, 0, 2, 3, 2, 3, 2, 3, 0, 0] };
    expect(rampDoodads([snowOnly], ice)[0]).toMatchObject({ low: 2, high: 3, side: "sw" });
    const platform = [{ id: 2, group: 2, height: 0 as const, name: "Space" }, { id: 3, group: 4, height: 1 as const, name: "Platform" }];
    const platformOnly = { id: 156, name: "Platform Wall #156", category: "Platform Wall", width: 4, height: 4, ramp: true, required: [0, 0, 238, 239, 240, 241, 4, 5, 242, 243, 4, 5, 4, 5, 4, 5] };
    expect(rampDoodads([platformOnly], platform)[0]).toMatchObject({ low: 2, high: 3, side: "sw" });
    const badlands = [{ id: 2, group: 2, height: 0 as const, name: "Dirt" }, { id: 3, group: 4, height: 2 as const, name: "High Dirt" }];
    expect(rampDoodads([sw], badlands)[0]).toMatchObject({ low: 2, high: 3, side: "sw" });
  });

  it("reads a bridge's bank and water off its requirements", () => {
    const jungle = [{ id: 2, group: 2, height: 0 as const, name: "Dirt", buildable: true }, { id: 5, group: 6, height: 0 as const, name: "Water", buildable: false }];
    const bridge = { id: 268, name: "Bridges #268", category: "Bridges", width: 14, height: 10, ramp: false, required: [0, 116, 117, 118, 119, 6, 7, 120, 121, 2, 3, 2, 3, 0] };
    const out = bridgeDoodads([bridge, tree], jungle);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 268, ground: 2, water: 5 });
    expect(bridgePair(out)).toEqual({ ground: 2, water: 5 });
    expect(bridgePair(out, "jungle", jungle)).toEqual({ ground: 2, water: 5, channel: 5 });
    expect(bridgePair(out, "badlands", jungle)).toBeNull();
    expect(bridgePair([])).toBeNull();
  });

  it("fits the nearest ramp of the right side that the editor allows", () => {
    const ramps = rampDoodads([sw, se], types);
    const allowed = new Set(["77:20,30", "77:22,31", "78:30,30"]);
    const fit = fitRamp({ x: 25, y: 34, direction: "sw", low: 2, high: 3 }, ramps, (id, tx, ty) => allowed.has(`${id}:${tx},${ty}`));
    expect(fit).toMatchObject({ doodadId: 77, tx: 22, ty: 31 });
    expect(fitRamp({ x: 25, y: 34, direction: "se" }, ramps, (id, tx, ty) => allowed.has(`${id}:${tx},${ty}`))).toMatchObject({ doodadId: 78, tx: 30, ty: 30 });
    expect(fitRamp({ x: 5, y: 5, direction: "sw" }, ramps, () => false)).toBeNull();
  });
});
