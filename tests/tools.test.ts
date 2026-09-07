import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { byName, capResult, colorIndexOf, describeCall, ownerName, ownerOf, slotOf, summarizeResult } from "../ai/tools/common";
import { readShapes, SHAPE_OPS } from "../ai/tools/layout";
import { paintableDiamonds } from "../ai/tools/terrain";

describe("tool helpers", () => {
  it("maps 1-based tool players to 0-based owners and back", () => {
    expect(ownerOf(1)).toBe(0);
    expect(ownerOf(8)).toBe(7);
    expect(ownerOf(12)).toBe(11);
    expect(ownerOf("neutral")).toBe(11);
    expect(ownerOf(undefined, 3)).toBe(3);
    expect(ownerName(0)).toBe("Player 1");
    expect(ownerName(11)).toBe("Neutral");
    expect(slotOf(1)).toBe(0);
    expect(slotOf("default")).toBe("default");
    expect(slotOf(13)).toBeNull();
    expect(slotOf(undefined)).toBeNull();
  });

  it("matches names loosely: exact, unique prefix, substring, or an id", () => {
    const items = [{ value: 0, label: "Terran Marine" }, { value: 1, label: "Terran Ghost" }, { value: 7, label: "Terran SCV" }, { value: 37, label: "Zerg Zergling" }];
    expect(byName(items, "terran marine")?.value).toBe(0);
    expect(byName(items, "Zerg Z")?.value).toBe(37);
    expect(byName(items, "ghost")?.value).toBe(1);
    expect(byName(items, "7")?.value).toBe(7);
    expect(byName(items, "Terran")?.value).toBe(0); // several: the first substring hit
    expect(byName(items, "")).toBeNull();
    expect(byName(items, "protoss")).toBeNull();
  });

  it("reads colours by name or index", () => {
    expect(colorIndexOf("Red")).toBe(0);
    expect(colorIndexOf("teal")).toBe(2);
    expect(colorIndexOf(5)).toBe(5);
    expect(colorIndexOf("9")).toBe(9);
    expect(colorIndexOf("mauve")).toBeNull();
  });

  it("caps results and describes calls for the transcript", () => {
    expect(capResult("short")).toBe("short");
    expect(capResult("x".repeat(20), 10)).toContain("… cut: 10 more characters");
    const call = describeCall("place_units", { units: [1, 2], name: "a very long name that goes on and on and on and on", n: 3, o: { a: 1 } });
    expect(call.startsWith('place_units(units=[2], name="a very long name')).toBe(true);
    expect(call.endsWith('…", n=3, o={…})')).toBe(true);
    expect(summarizeResult("Placed 3.\nmore")).toBe("Placed 3.");
    expect(summarizeResult({ image: { mediaType: "image/png", data: "AA" } })).toBe("(picture)");
  });
});

describe("paint_shapes input", () => {
  it("reads the op from op, or from the names a caller reaches for instead", () => {
    expect(readShapes([{ op: "rect", x: 1, y: 2, w: 3, h: 4, terrain: 5 }])).toEqual([{ op: "rect", x: 1, y: 2, w: 3, h: 4, terrain: 5 }]);
    expect(readShapes([{ type: "stroke", width: 8, terrain: 5 }])).toEqual([{ op: "stroke", type: "stroke", width: 8, terrain: 5 }]);
    expect(readShapes([{ kind: "bridge", x: 64, y: 63 }])).toMatchObject([{ op: "bridge" }]);
    expect(readShapes([{ shape: "ground", terrain: 2 }])).toMatchObject([{ op: "ground" }]);
  });

  it("says which shape lacks an op and what the ops are", () => {
    expect(readShapes([])).toBe("No shapes were given.");
    expect(readShapes(undefined)).toBe("No shapes were given.");
    const missing = readShapes([{ op: "rect", terrain: 1 }, { x: 1, y: 1, terrain: 1 }]);
    expect(missing).toContain("Shape 2 names no op");
    expect(missing).toContain(SHAPE_OPS.join(", "));
    expect(readShapes([{ op: "river", terrain: 5 }])).toContain('Shape 1 has an op "river"');
  });
});

describe("paint_terrain's diamonds", () => {
  // The editor's diamondsIn is inclusive of the far edges: what a 128 × 128 map answers for a rect.
  const api = {
    document: { info: () => ({ width: 128, height: 128 }) },
    terrain: {
      diamondsIn: (r: { x0: number; y0: number; x1: number; y1: number }) => {
        const out: { x: number; y: number }[] = [];
        for (let y = r.y0; y <= Math.min(128, r.y1); y++) for (let x = Math.ceil(r.x0 / 2); x <= Math.min(64, Math.floor(r.x1 / 2)); x++) if ((x + y) % 2 === 0) out.push({ x, y });
        return out;
      },
    },
  } as unknown as PluginApi;

  it("leaves out the far edge, so a rect that stops at a river does not paint the river's first row", () => {
    const grass = paintableDiamonds(api, { x0: 0, y0: 55, x1: 128, y1: 60 });
    expect(grass.every((d) => d.y < 60)).toBe(true);
    expect(grass.some((d) => d.y === 59)).toBe(true);
    // The lattice column at x = 128 / 2 is the far edge of the map, so it stays; a rect ending at 64 drops column 32.
    expect(grass.some((d) => d.x === 64)).toBe(true);
    expect(paintableDiamonds(api, { x0: 0, y0: 0, x1: 64, y1: 8 }).some((d) => d.x === 32)).toBe(false);
  });

  it("keeps the map's own edge, which has nothing beyond it", () => {
    const bottom = paintableDiamonds(api, { x0: 0, y0: 120, x1: 128, y1: 128 });
    expect(bottom.some((d) => d.y === 128)).toBe(true);
  });
});
