import { describe, expect, it } from "vitest";
import { blockRects, floodFrom, nearestWalkable, reachTouches, type WalkMask } from "../ai/reach";
import { shiftShapes } from "../ai/shapes";

function mask(rows: string[]): WalkMask {
  const height = rows.length, width = rows[0].length;
  const walk = new Uint8Array(width * height);
  rows.forEach((r, y) => [...r].forEach((c, x) => { walk[y * width + x] = c === "." ? 1 : 0; }));
  return { width, height, walk };
}

describe("reachability", () => {
  const m = mask([
    "....#....",
    "....#....",
    "....#....",
    "#########",
    ".........",
  ]);
  it("floods through four neighbours and stops at walls", () => {
    const r = floodFrom(m, 0, 0);
    expect(r[0 * 9 + 3]).toBe(1);
    expect(r[0 * 9 + 5]).toBe(0);
    expect(r[4 * 9 + 0]).toBe(0);
    expect(floodFrom(m, 4, 0).reduce((a, b) => a + b, 0)).toBe(0);
    expect(floodFrom(m, 0, 4).reduce((a, b) => a + b, 0)).toBe(9);
  });
  it("blanks out the bridges when asked, so a river with one bridge holds without it", () => {
    const river = mask([
      ".........",
      "####.####",
      "####.####",
      ".........",
    ]);
    expect(floodFrom(river, 0, 0)[3 * 9 + 0]).toBe(1);
    blockRects(river, [{ x0: 4, y0: 1, x1: 5, y1: 3 }]);
    expect(floodFrom(river, 0, 0)[3 * 9 + 0]).toBe(0);
  });
  it("finds the nearest walkable tile and whether a rect is reached", () => {
    expect(nearestWalkable(m, 4, 1)).toEqual({ x: 3, y: 1 });
    expect(nearestWalkable(m, 4, 3, 0)).toBeNull();
    const r = floodFrom(m, 0, 0);
    expect(reachTouches(m, r, { x0: 2, y0: 0, x1: 6, y1: 2 })).toBe(true);
    expect(reachTouches(m, r, { x0: 5, y0: 0, x1: 9, y1: 3 })).toBe(false);
  });
});

describe("shifting shapes", () => {
  it("moves every coordinate an area-relative plan uses", () => {
    const out = shiftShapes([{ op: "rect", terrain: 1, x: 1, y: 2, w: 3, h: 4 }, { op: "diamond", terrain: 1, cx: 5, cy: 6, rx: 2, ry: 1 }, { op: "stroke", terrain: 1, points: [[0, 0], [1, 1]], width: 2 }], 10, 20);
    expect(out[0]).toMatchObject({ x: 11, y: 22, w: 3, h: 4 });
    expect(out[1]).toMatchObject({ cx: 15, cy: 26 });
    expect(out[2].points).toEqual([[10, 20], [11, 21]]);
    expect(shiftShapes([{ op: "ground", terrain: 1 }], 0, 0)).toEqual([{ op: "ground", terrain: 1 }]);
  });
});
