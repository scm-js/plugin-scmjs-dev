import { describe, expect, it } from "vitest";
import { removedDoodads, type DoodadSnap } from "../ai/render";

const snap = (doodadId: number, tx: number, ty: number, name = `Bridges #${doodadId}`): DoodadSnap => ({ doodadId, x: (tx + 7) * 32, y: (ty + 5) * 32, tx, ty, width: 14, height: 10, name });

describe("naming the doodads an edit removed", () => {
  it("lists what was there before and is gone after, but not what the cleared area took on purpose", () => {
    const bridge = snap(189, 48, 59), tree = snap(12, 3, 3, "Trees #12"), kept = snap(189, 90, 20);
    const gone = removedDoodads([bridge, tree, kept], [kept], { x0: 0, y0: 0, x1: 20, y1: 20 });
    expect(gone).toEqual([bridge]);
    expect(removedDoodads([bridge, kept], [kept, bridge], null)).toEqual([]);
    // Two of the same doodad at the same place: one gone is one named.
    expect(removedDoodads([bridge, bridge], [bridge], null)).toHaveLength(1);
  });
});
