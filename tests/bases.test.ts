import { describe, expect, it } from "vitest";
import { candidateDirections, fitBase, spreadOf } from "../ai/bases";
import { angleDiff, angleOf, chebGap, DEFAULT_SPEC, layoutBase, type TileRect } from "../ai/layout";

const hall: TileRect = { x: 20, y: 20, w: 4, h: 3 };
const W = Math.PI, S = Math.PI / 2, N = -Math.PI / 2;

describe("layoutBase with fits", () => {
  it("leaves refused positions off the ring and closes the line over them", () => {
    const refused = (r: TileRect) => r.y === 21; // one row of the west column
    const plain = layoutBase(hall, { ...DEFAULT_SPEC, direction: W });
    const fitted = layoutBase(hall, { ...DEFAULT_SPEC, direction: W, fits: (r) => !refused(r) });
    expect(plain.minerals.some(refused)).toBe(true);
    expect(fitted.minerals.some(refused)).toBe(false);
    expect(fitted.minerals).toHaveLength(8);
    expect(fitted.short).toEqual({ minerals: 0, geysers: 0 });
    for (const m of fitted.minerals) expect(chebGap(m, hall)).toBe(3);
    expect(fitted.geysers.some(refused)).toBe(false);
  });
  it("comes up short when the ring has too few places left", () => {
    const l = layoutBase(hall, { ...DEFAULT_SPEC, direction: W, fits: (r) => r.x >= hall.x + hall.w && r.y >= hall.y && r.y < hall.y + 2 });
    expect(l.minerals.length).toBeLessThan(8);
    expect(l.short.minerals).toBe(8 - l.minerals.length);
  });
});

describe("fitBase", () => {
  it("tries the asked direction first, then its neighbours outwards", () => {
    const c = candidateDirections(W);
    expect(c[0]).toBe(W);
    expect(c.slice(1, 3).map((a) => angleDiff(a, W))).toEqual([-Math.PI / 4, Math.PI / 4]);
    expect(Math.abs(angleDiff(c[c.length - 1], 0))).toBeLessThan(1e-9);
    expect(c).toHaveLength(8);
  });
  it("keeps the asked direction when the line fits there", () => {
    const f = fitBase(hall, { direction: W, fits: () => true });
    expect(f.turned).toBe(false);
    expect(f.direction).toBe(W);
    expect(f.layout.minerals).toHaveLength(8);
    expect(f.layout.geysers).toHaveLength(1);
    expect(spreadOf(f.layout, W)).toBeLessThan(Math.PI / 2);
  });
  it("turns the line when the asked side is blocked, to the nearest side with a whole line", () => {
    // Only the ground below the hall fits: the south side is the nearest whole line.
    const fits = (r: TileRect) => r.y >= hall.y + hall.h;
    const f = fitBase(hall, { direction: W, fits });
    expect(f.turned).toBe(true);
    expect(f.layout.short).toEqual({ minerals: 0, geysers: 0 });
    expect(f.layout.minerals.every(fits)).toBe(true);
    expect(Math.abs(angleDiff(f.direction, S))).toBeLessThan(1e-9);
    for (const m of f.layout.minerals) expect(Math.abs(angleDiff(angleOf(hall, m), S))).toBeLessThan(Math.PI / 2);
  });
  it("prefers a whole line on a neighbouring side to a broken one on the asked side", () => {
    // Most of the west column is gone; north is open.
    const fits = (r: TileRect) => !(r.x < hall.x && r.y >= hall.y - 2);
    const f = fitBase(hall, { direction: W, fits });
    expect(f.layout.short).toEqual({ minerals: 0, geysers: 0 });
    expect(f.layout.minerals.every(fits)).toBe(true);
    expect(spreadOf(f.layout, f.direction)).toBeLessThanOrEqual((5 * Math.PI) / 9);
  });
  it("returns the least short line when no side has a whole one", () => {
    const fits = (r: TileRect) => r.y < hall.y && r.x >= hall.x && r.x < hall.x + 2;
    const f = fitBase(hall, { direction: S, fits });
    expect(f.layout.minerals.length).toBeGreaterThan(0);
    expect(f.layout.minerals.length).toBeLessThan(8);
    expect(f.layout.minerals.every(fits)).toBe(true);
    expect(Math.abs(angleDiff(f.direction, N))).toBeLessThan(1e-9);
  });
});
