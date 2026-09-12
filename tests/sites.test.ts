import { describe, expect, it } from "vitest";
import { clusterResources, compassOf, oppositeOf, scanSites, type ResourceUnit } from "../ai/sites";

describe("bases and sites", () => {
  it("clusters resources by nearness and reads the line's side of the hall", () => {
    const m = (index: number, tx: number, ty: number, kind: "mineral" | "geyser" = "mineral"): ResourceUnit => ({ index, kind, tx, ty, amount: kind === "mineral" ? 1500 : 5000 });
    // A line of eight patches along y 40 with a geyser at its end, and a far cluster of two.
    const units = [...Array.from({ length: 8 }, (_, i) => m(i, 121 + i * 2, 40)), m(8, 119, 42, "geyser"), m(9, 20, 100), m(10, 22, 101)];
    const clusters = clusterResources(units);
    expect(clusters).toHaveLength(2);
    const [near, far] = [clusters.find((c) => c.minerals.length === 8)!, clusters.find((c) => c.minerals.length === 2)!];
    expect(near.geysers).toHaveLength(1);
    expect(near.x0).toBe(119); expect(near.x1).toBe(136); expect(near.y0).toBe(40); expect(near.y1).toBe(43);
    expect(far.geysers).toHaveLength(0);
    // The hall sits south of the line: the line's side is north and the open side south.
    const side = compassOf(near.cx - 128, near.cy - 46);
    expect(side).toBe("n");
    expect(oppositeOf(side)).toBe("s");
    expect(compassOf(10, 10)).toBe("se");
    expect(oppositeOf("ne")).toBe("sw");
  });

  it("finds the nearest blocks of ok ground, a block apart, within the radius", () => {
    const width = 40, height = 30;
    const ok = new Uint8Array(width * height).fill(1);
    // A wall of bad ground down x = 20 and a bad patch near the centre.
    for (let y = 0; y < height; y++) ok[y * width + 20] = 0;
    for (let y = 12; y < 18; y++) for (let x = 14; x < 19; x++) ok[y * width + x] = 0;
    const sites = scanSites({ width, height, ok }, 4, 3, { x: 16, y: 15 }, 10, 5);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.length).toBeLessThanOrEqual(5);
    for (const s of sites) {
      for (let y = s.y; y < s.y + 3; y++) for (let x = s.x; x < s.x + 4; x++) expect(ok[y * width + x]).toBe(1);
      expect(s.distance).toBeLessThanOrEqual(10);
    }
    // Nearest first, and no two overlap.
    for (let i = 1; i < sites.length; i++) expect(sites[i].distance).toBeGreaterThanOrEqual(sites[i - 1].distance);
    for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) expect(Math.abs(sites[i].x - sites[j].x) >= 4 || Math.abs(sites[i].y - sites[j].y) >= 3).toBe(true);
    // The wall never sits inside a block; a block wider than the map is refused.
    expect(scanSites({ width, height, ok }, 4, 3, { x: 20, y: 5 }, 1)).toEqual([]);
    expect(scanSites({ width, height, ok }, 50, 3, { x: 0, y: 0 }, 100)).toEqual([]);
  });
});
