/**
 * A base laid out on ground the editor accepts. `layoutBase` knows the ring a hall
 * mines fastest from; this knows that the ring runs over cliffs, water, the map's edge
 * and units already there, and that a line asked for on such a side is better turned
 * than broken. The asked direction is tried first with the refused positions left out,
 * then its neighbours by 45°, each way, out to the opposite side; the first direction
 * whose line is whole, centred on it and not wrapped far round the hall wins, and when
 * none does, the one that lost the least.
 */
import { angleDiff, angleOf, DEFAULT_SPEC, layoutBase, type BaseLayout, type BaseSpec, type TileRect } from "./layout";

export interface FittedBase {
  layout: BaseLayout;
  /** The direction the line was laid in — the asked one, or the nearest that had room. */
  direction: number;
  /** Whether the line had to leave the asked direction. */
  turned: boolean;
}

/** The angle a patch may stray from the line's direction before the line reads as wrapped round the wrong side; a whole line with two geysers spreads 78°. */
const SPREAD = (5 * Math.PI) / 9;
/** How far off-centre a line may sit from its direction before it reads as lying on another side. */
const BALANCE = Math.PI / 8;

/** The directions to try, from the asked one outwards: 0, ±45°, ±90°, ±135°, 180°. */
export function candidateDirections(direction: number): number[] {
  const step = Math.PI / 4;
  const out = [direction];
  for (let k = 1; k <= 3; k++) out.push(direction - k * step, direction + k * step);
  out.push(direction + Math.PI);
  return out;
}

/** How far the line strays from the direction it was laid in: the widest angle any patch or geyser makes with it. */
export function spreadOf(layout: BaseLayout, direction: number): number {
  let widest = 0;
  for (const r of [...layout.minerals, ...layout.geysers]) widest = Math.max(widest, Math.abs(angleDiff(angleOf(layout.hall, r), direction)));
  return widest;
}

/** How far the line sits off its direction: the mean angle its patches and geysers make with it, signed. */
export function balanceOf(layout: BaseLayout, direction: number): number {
  const all = [...layout.minerals, ...layout.geysers];
  if (!all.length) return 0;
  return all.reduce((sum, r) => sum + angleDiff(angleOf(layout.hall, r), direction), 0) / all.length;
}

/**
 * Lay a base round `hall` in the direction `spec` asks, on the positions `fits` accepts,
 * turning the line to a neighbouring direction when the asked one has no whole line.
 */
export function fitBase(hall: TileRect, spec: Partial<BaseSpec> & { fits: (rect: TileRect) => boolean }): FittedBase {
  const full: BaseSpec = { ...DEFAULT_SPEC, ...spec };
  let best: FittedBase | null = null;
  let bestShort = Infinity;
  let bestSpread = Infinity;
  for (const direction of candidateDirections(full.direction)) {
    const layout = layoutBase(hall, { ...full, direction });
    const short = layout.short.minerals + layout.short.geysers;
    const spread = spreadOf(layout, direction);
    const candidate = { layout, direction, turned: direction !== full.direction };
    if (short === 0 && spread <= SPREAD && Math.abs(balanceOf(layout, direction)) <= BALANCE) return candidate;
    if (short < bestShort || (short === bestShort && spread < bestSpread)) { best = candidate; bestShort = short; bestSpread = spread; }
  }
  return best!;
}
