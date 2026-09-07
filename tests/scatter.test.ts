import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { scatterInRect } from "../ai/tools/objects";

/** A fake editor: water is the left half of a 32 × 16 map, and StarEdit's rule accepts a doodad only at even x. */
function fake() {
  const placed: { id: number; x: number; y: number }[] = [];
  const api = {
    document: { edit: (_label: string, body: (tx: unknown) => void) => { body({ placeDoodad: (id: number, x: number, y: number) => { placed.push({ id, x, y }); return placed.length - 1; } }); return {}; } },
  } as unknown as PluginApi;
  const fits = (d: { width: number; height: number }, x: number, y: number) => x % 2 === 0 && x + d.width <= 16 && y + d.height <= 16;
  return { api, placed, fits };
}

const cat = { name: "Water", doodads: [{ id: 7, width: 2, height: 2 }, { id: 8, width: 2, height: 1 }] };

describe("scatter_doodads", () => {
  it("places only where the editor's rule says the doodad fits, snapping to the parity it takes", () => {
    const { api, placed, fits } = fake();
    const r = scatterInRect(api, cat, { x0: 0, y0: 0, x1: 16, y1: 16 }, 12, fits);
    expect(r.placed).toBe(12);
    // A random spot can land on one already taken; that is the only refusal on water.
    expect(r.refused).toBeLessThan(12);
    expect(placed.every((p) => p.x % 2 === 0 && p.x < 16)).toBe(true);
  });

  it("refuses the spots on other ground and says how many", () => {
    const { api, placed, fits } = fake();
    // The right half is not water: everything landing there is refused, and nothing is placed off the water.
    const r = scatterInRect(api, cat, { x0: 16, y0: 0, x1: 32, y1: 16 }, 6, fits);
    expect(r.placed).toBe(0);
    expect(r.refused).toBe(6 * 8);
    expect(placed).toEqual([]);
  });

  it("never lets two of its own doodads overlap", () => {
    const { api, placed, fits } = fake();
    scatterInRect(api, cat, { x0: 0, y0: 0, x1: 4, y1: 4 }, 20, fits);
    const rects = placed.map((p) => ({ x0: p.x, y0: p.y, x1: p.x + 2, y1: p.y + (p.id === 7 ? 2 : 1) }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
    }
    expect(placed.length).toBeGreaterThan(0);
    // Two columns at even x, four rows: at most eight of the 2 × 1 kind.
    expect(placed.length).toBeLessThanOrEqual(8);
  });
});
