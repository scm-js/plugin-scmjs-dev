/**
 * What every tool file shares: the `Tool` shape, the input coercions (the model's JSON
 * is loosely typed), tile rects, the result cap, and the name lookups — units, upgrades,
 * technologies, doodads and sprites by the names the editor shows, case-insensitively,
 * with the resource aliases people actually use.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { AgentContent, AgentTool, ImageInput } from "../../protocol";
import type { Ctx } from "../ui";

export const TILE = 32;
export const RESULT_CAP = 8_000;

export type ToolResult = string | { text?: string; image?: ImageInput };

export interface Tool {
  def: AgentTool;
  /** Whether it changes the map (shown differently in the transcript). */
  writes: boolean;
  /** A settings-style write: not in the undo model. */
  settings?: boolean;
  /**
   * The step's line in the transcript, from the input — "Placed 4 Marines near 12,7", in
   * the past tense, naming what the person would look for on the map. Without it the
   * name as words with the arguments that matter (`describeStep`).
   */
  describe?(input: Record<string, unknown>, ctx: Ctx): string;
  /**
   * What the step found or did, from its result, shown dim after the line — "3 chokes,
   * 2 dead ends". Without it, a summary of the result's shape (`reportStep`).
   */
  report?(result: ToolResult): string;
  run(input: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> | ToolResult;
}

export const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : typeof v === "string" && /^(true|yes|on)$/i.test(v) ? true : typeof v === "string" && /^(false|no|off)$/i.test(v) ? false : undefined);
export const list = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const ints = (v: unknown): number[] => list<unknown>(v).map((x) => Math.round(num(x, -1))).filter((x) => x >= 0);

export interface TileRect { x0: number; y0: number; x1: number; y1: number }

/** A tile rect from `x0,y0,x1,y1` clamped to the map; the whole map when nothing is given. */
export function rectOf(input: Record<string, unknown>, api: PluginApi): TileRect {
  const info = api.document.info();
  const W = info?.width ?? 0, H = info?.height ?? 0;
  const x0 = Math.max(0, Math.min(W, Math.round(num(input.x0)))), y0 = Math.max(0, Math.min(H, Math.round(num(input.y0))));
  const x1 = Math.max(x0, Math.min(W, Math.round(num(input.x1, W)))), y1 = Math.max(y0, Math.min(H, Math.round(num(input.y1, H))));
  return { x0, y0, x1, y1 };
}

export const hasRect = (input: Record<string, unknown>) => input.x0 !== undefined || input.x1 !== undefined || input.y0 !== undefined || input.y1 !== undefined;

export const rectSchema = { x0: { type: "integer", description: "left tile" }, y0: { type: "integer", description: "top tile" }, x1: { type: "integer", description: "right tile, exclusive" }, y1: { type: "integer", description: "bottom tile, exclusive" } };

export const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, ...(required.length ? { required } : {}) });

/** JSON for a tool result, cut to the cap with a note. */
export function capResult(value: unknown, cap = RESULT_CAP): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length <= cap ? s : `${s.slice(0, cap)}\n… cut: ${s.length - cap} more characters. Ask with a narrower filter.`;
}

/** The 1-based player number a tool uses for a 0-based owner. */
export function ownerName(o: number): string {
  return o < 8 ? `Player ${o + 1}` : o === 11 ? "Neutral" : `owner ${o + 1}`;
}

/** A tool's 1-based player (12 = neutral) as a 0-based owner; `d` when missing. */
export function ownerOf(v: unknown, d = 11): number {
  if (typeof v === "string" && /neutral/i.test(v)) return 11;
  const n = num(v, d + 1);
  if (n >= 12) return 11;
  return Math.max(0, Math.round(n) - 1);
}

/** The 1-based player as a 0-based slot 0–11, or "default" for the settings tables. */
export function slotOf(v: unknown): number | "default" | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && /^default$/i.test(v.trim())) return "default";
  const n = Math.round(num(v, -1));
  return n >= 1 && n <= 12 ? n - 1 : null;
}

/** Case-insensitive match of a name against a labelled list: exact first, then a unique prefix, then a substring. */
export function byName<T extends { label: string; value: number }>(items: T[], name: string): T | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const numeric = /^\d+$/.test(wanted) ? Number(wanted) : null;
  if (numeric !== null) return items.find((i) => i.value === numeric) ?? null;
  const exact = items.find((i) => i.label.toLowerCase() === wanted);
  if (exact) return exact;
  const starts = items.filter((i) => i.label.toLowerCase().startsWith(wanted));
  if (starts.length === 1) return starts[0];
  const within = items.filter((i) => i.label.toLowerCase().includes(wanted));
  return within.length >= 1 ? within[0] : null;
}

/** Names that ask for a mineral field without saying which of the three looks: the caller is free to vary the type. */
const ANY_MINERAL = ["mineral field", "minerals", "mineral patch", "mineral"];

export function isAnyMineralName(name: string): boolean {
  return ANY_MINERAL.includes(name.trim().toLowerCase());
}

const UNIT_ALIASES: Record<string, string> = {
  ...Object.fromEntries(ANY_MINERAL.map((n) => [n, "Mineral Field (Type 1)"])),
  geyser: "Vespene Geyser", gas: "Vespene Geyser", start: "Start Location", "start location": "Start Location",
  marine: "Terran Marine", zergling: "Zerg Zergling", zealot: "Protoss Zealot", scv: "Terran SCV", drone: "Zerg Drone", probe: "Protoss Probe",
  "command center": "Terran Command Center", hatchery: "Zerg Hatchery", nexus: "Protoss Nexus",
};

/** A units.dat id by StarEdit name (or id), case-insensitively, with the common short names. */
export function unitIdByName(api: PluginApi, name: string): number | null {
  const alias = UNIT_ALIASES[name.trim().toLowerCase()];
  const items = api.names.units().filter((u) => u.value < 228);
  return byName(items, alias ?? name)?.value ?? null;
}

export function upgradeIdByName(api: PluginApi, name: string): number | null {
  return byName(api.names.upgrades(), name)?.value ?? null;
}

export function techIdByName(api: PluginApi, name: string): number | null {
  return byName(api.names.techs(), name)?.value ?? null;
}

/** A doodad of the open tileset by name (a category name picks any of its doodads) or by id. */
export function doodadByName(api: PluginApi, name: string): { id: number; name: string; category: string; width: number; height: number } | null {
  const wanted = name.trim().toLowerCase();
  const all = api.palette.doodadCategories().flatMap((c) => c.doodads);
  if (/^\d+$/.test(wanted)) return all.find((d) => d.id === Number(wanted)) ?? null;
  const exact = all.find((d) => d.name.toLowerCase() === wanted);
  if (exact) return exact;
  const within = all.filter((d) => d.name.toLowerCase().includes(wanted));
  if (within.length) return within[Math.floor(Math.random() * within.length)];
  const cat = api.palette.doodadCategories().find((c) => c.name.toLowerCase() === wanted || c.name.toLowerCase().includes(wanted));
  return cat && cat.doodads.length ? cat.doodads[Math.floor(Math.random() * cat.doodads.length)] : null;
}

/** A sprite by name (the palette's) or id, for the given kind; a unit name picks the unit sprite. */
export function spriteByName(api: PluginApi, kind: "pure" | "unit", name: string): number | null {
  const wanted = name.trim().toLowerCase();
  if (/^\d+$/.test(wanted)) return Number(wanted);
  if (kind === "unit") return unitIdByName(api, name);
  const ids = api.palette.spriteGroups().flatMap((g) => g.ids);
  const named = ids.map((id) => ({ value: id, label: api.palette.spriteName("pure", id) }));
  return byName(named, name)?.value ?? null;
}

/** COLR indices by the names the game uses for them. */
export const PLAYER_COLOR_NAMES = ["Red", "Blue", "Teal", "Purple", "Orange", "Brown", "White", "Yellow", "Green", "Pale Yellow", "Tan", "Dark Aqua", "Pale Green", "Bluish Grey", "Pale Yellow 2", "Cyan"];

export function colorIndexOf(v: unknown): number | null {
  if (typeof v === "number") return v >= 0 && v < 256 ? Math.round(v) : null;
  const s = str(v).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const i = PLAYER_COLOR_NAMES.findIndex((n) => n.toLowerCase() === s);
  return i >= 0 ? i : null;
}

/** A tool result as agent content. */
export function toContent(toolUseId: string, result: ToolResult, isError = false): AgentContent {
  if (typeof result === "string") return { type: "tool_result", toolUseId, content: result, isError };
  const parts: ({ type: "text"; text: string } | { type: "image"; source: ImageInput })[] = [];
  if (result.text) parts.push({ type: "text", text: result.text });
  if (result.image) parts.push({ type: "image", source: result.image });
  return { type: "tool_result", toolUseId, content: parts.length ? parts : "Done.", isError };
}

/** One line describing a call, for the transcript. */
export function describeCall(name: string, input: Record<string, unknown>): string {
  const args = Object.entries(input).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : Array.isArray(v) ? `[${v.length}]` : typeof v === "object" && v ? "{…}" : String(v)}`).join(", ");
  return `${name}(${args})`;
}

/** A tool name as words: `place_units` → "Place units". */
export function prettyName(name: string): string {
  const s = words(name);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A key as words: `deadEnds`, `cell_size` → "dead ends", "cell size". */
const words = (key: string) => key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

const RECT_KEYS = new Set(["x0", "y0", "x1", "y1"]);

/**
 * The step's line: the tool's own phrasing when it has one, else the name as words and
 * the arguments worth a glance — a rect as `x0,y0–x1,y1`, then up to two short scalars.
 */
export function describeStep(tool: { describe?(input: Record<string, unknown>, ctx: Ctx): string } | undefined, name: string, input: Record<string, unknown>, ctx: Ctx): string {
  if (tool?.describe) { try { const s = tool.describe(input, ctx); if (s) return s; } catch { /* the fallback */ } }
  const parts: string[] = [];
  if (RECT_KEYS.size && [...RECT_KEYS].every((k) => typeof input[k] === "number")) parts.push(`${input.x0},${input.y0}–${input.x1},${input.y1}`);
  for (const [k, v] of Object.entries(input)) {
    if (parts.length >= 2 || RECT_KEYS.has(k)) continue;
    if (typeof v === "string" && v.trim() && v.length <= 32) parts.push(v);
    else if (typeof v === "number") parts.push(`${words(k)} ${v}`);
    else if (typeof v === "boolean") parts.push(v ? words(k) : `not ${words(k)}`);
  }
  return parts.length ? `${prettyName(name)}: ${parts.join(", ")}` : prettyName(name);
}

/**
 * What came back, in a few words: the tool's own report when it has one; else, for a
 * JSON result, its shape — "3 chokes, 2 dead ends", "12 items" — and for prose its
 * first line, cut short.
 */
export function reportStep(tool: { report?(result: ToolResult): string } | undefined, result: ToolResult): string {
  if (tool?.report) { try { const s = tool.report(result); if (s) return s; } catch { /* the fallback */ } }
  if (typeof result !== "string") return result.text ? cut(result.text.split("\n")[0], 80) : result.image ? "picture" : "";
  const text = result.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const v = JSON.parse(text.replace(/\n… cut: \d+ more characters\..*$/s, (m) => (text.endsWith(m) ? "" : m))) as unknown;
      const shape = describeShape(v);
      if (shape) return shape;
    } catch { /* not whole JSON: the first line */ }
  }
  return cut(text.split("\n")[0], 80);
}

function describeShape(v: unknown): string {
  if (Array.isArray(v)) return plural(v.length, "item");
  if (!v || typeof v !== "object") return "";
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (parts.length >= 3) break;
    const key = words(k);
    if (Array.isArray(val)) parts.push(`${val.length} ${key}`);
    else if (typeof val === "number") parts.push(`${key} ${val}`);
    else if (typeof val === "string" && val.length <= 24 && parts.length === 0) parts.push(val);
  }
  return parts.join(", ");
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The first line of a result, for the transcript row's tooltip. */
export function summarizeResult(result: ToolResult): string {
  const text = typeof result === "string" ? result : result.text ?? (result.image ? "(picture)" : "Done.");
  const line = text.split("\n")[0];
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ── Phrasing for the transcript's step lines ── */

/** The JSON of a result, when it is one (a cut result parses no further than its cut). */
export function jsonOf(result: ToolResult): Record<string, unknown> | null {
  const text = typeof result === "string" ? result : result.text ?? "";
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}

/** Names tallied: `Terran Marine ×4, Terran Siege Tank ×1`, the rest counted. */
export function tally(names: string[], max = 3): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts].map(([n, c]) => (c === 1 ? n : `${n} ×${c}`));
  return parts.length > max ? `${parts.slice(0, max).join(", ")} and ${parts.length - max} more` : parts.join(", ");
}

/** `#3, #7, #9` — the first few of a list of indices. */
export function indexList(indices: number[], max = 3): string {
  const shown = indices.slice(0, max).map((i) => `#${i}`).join(", ");
  return indices.length > max ? `${shown} +${indices.length - max}` : shown;
}

/** `10,10–30,20` from the rect keys present. */
export const rectText = (input: Record<string, unknown>) => `${num(input.x0)},${num(input.y0)}–${num(input.x1)},${num(input.y1)}`;

/** The keys of `input` among `keys`, as words: `hit points, armor`. */
export function fieldsGiven(input: Record<string, unknown>, keys: string[]): string {
  return keys.filter((k) => input[k] !== undefined).map((k) => k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()).join(", ");
}

/** `2 placed`, `2 placed, 1 refused`, or the first refusal when nothing went in. */
export function placedReport(result: ToolResult): string {
  const r = jsonOf(result);
  if (!r) return "";
  const placed = Array.isArray(r.placed) ? r.placed.length : 0;
  const refused = Array.isArray(r.refused) ? (r.refused as string[]) : [];
  if (!placed && refused.length) return `nothing placed: ${refused[0]}`;
  return refused.length ? `${placed} placed, ${refused.length} refused` : `${placed} placed`;
}
