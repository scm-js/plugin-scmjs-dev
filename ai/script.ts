/**
 * The TrigScript plugin's commands, typed: what the editor's `api.script` used to be
 * before the scripting became a plugin of its own. Plugins activate in no fixed order
 * and the user may have it switched off, so every use goes through `scriptBridge` and
 * says `NO_SCRIPT_PLUGIN` when it answers null.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { TriggerRecord } from "@scm-js/plugin-api";

export const SCRIPT_PLUGIN = "trigscript";
export const NO_SCRIPT_PLUGIN = "The TrigScript plugin is off. Turn it on under Plugins ▸ Manage Plugins… to write, check or build trigger scripts.";

export interface ScriptDiagnostic {
  /** The script file (`main.ts` for a one-file script). */
  file: string;
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  /** TypeScript's checker, the program compiler, or the script itself throwing when it ran. */
  source: "typescript" | "compiler" | "script";
}

export interface TriggerSource {
  file: string;
  line: number;
}

export interface CompileResult {
  triggers: TriggerRecord[];
  /** Per trigger, where it came from; null for a hyper trigger. */
  sources: (TriggerSource | null)[];
  diagnostics: ScriptDiagnostic[];
  variables: { name: string; kind: "number" | "boolean"; storage: string }[];
  programs: { owner: number; start: number; count: number; source: TriggerSource }[];
  ok: boolean;
}

export interface ScriptBlock {
  start: number;
  count: number;
  sources: (TriggerSource | null)[];
}

export interface ScriptState {
  /** Every file of the script by path; null when the map has none. */
  files: Record<string, string> | null;
  /** The entry file's text (`main.ts`); null when there is none. */
  source: string | null;
  block: ScriptBlock | null;
  /** A build exists but its records were edited or removed. */
  stale: boolean;
  /** The source differs from what the block was built from (or was never built). */
  unbuilt: boolean;
}

export interface ScriptSimulation {
  cycles: number;
  events: { cycle: number; trigger: number; action: { type: number }; text?: string }[];
  switches: number[];
}

/** A script for a command: the entry file's text alone (the map's other files stay), or every file by path. */
export type ScriptInput = string | Record<string, string>;

export interface ScriptBridge {
  state(): ScriptState | null;
  /** The generated `.d.ts`; `compact` is the shorter variant meant for a model. */
  declarations(options?: { compact?: boolean }): string;
  compile(source: ScriptInput): Promise<CompileResult>;
  build(source: ScriptInput, options?: { takeOver?: boolean }): Promise<{ compiled: CompileResult; block: ScriptBlock | null }>;
  print(triggers: TriggerRecord[], options?: { imports?: boolean; header?: string }): string;
  simulate(triggers: TriggerRecord[], cycles: number, options?: { player?: number }): ScriptSimulation;
  triggerAt(file: string, line: number): number | null;
  /** Open the TrigScript editor, on a file and line. */
  open(file?: string, line?: number): void;
}

export function hasScriptPlugin(api: PluginApi): boolean {
  return api.commands.has(`${SCRIPT_PLUGIN}.compile`);
}

/** The bridge, or null while the TrigScript plugin is off. */
export function scriptBridge(api: PluginApi): ScriptBridge | null {
  if (!hasScriptPlugin(api)) return null;
  const run = (name: string, ...args: unknown[]) => api.commands.run(`${SCRIPT_PLUGIN}.${name}`, ...args);
  const async = async <T>(name: string, ...args: unknown[]): Promise<T> => {
    const r = run(name, ...args);
    if (r === undefined) throw new Error(NO_SCRIPT_PLUGIN);
    return (await r) as T;
  };
  return {
    state: () => (run("state") as ScriptState | null | undefined) ?? null,
    declarations: (options) => String(run("declarations", options ?? {}) ?? ""),
    compile: (source) => async("compile", source),
    build: (source, options) => async("build", source, options ?? {}),
    print: (triggers, options) => String(run("print", triggers, options ?? {}) ?? ""),
    simulate: (triggers, cycles, options) => (run("simulate", triggers, cycles, options ?? {}) as ScriptSimulation | undefined) ?? { cycles: 0, events: [], switches: [] },
    triggerAt: (file, line) => (run("triggerAt", file, line) as number | null | undefined) ?? null,
    open: (file, line) => { run("open", { file, line }); },
  };
}

/** "line 12" or "waves.ts line 12": where a diagnostic is, for a message or a repair round. */
export function describeDiagnostic(d: ScriptDiagnostic): string {
  return `${d.file && d.file !== "main.ts" ? `${d.file} ` : ""}line ${d.line}:${d.column} — ${d.message}`;
}

/** A diagnostic as the `triggers` recipe's repair round takes it: the file folded into the message when it is not the entry. */
export function repairDiagnostic(d: ScriptDiagnostic): { line: number; column: number; message: string } {
  return { line: d.line, column: d.column, message: d.file && d.file !== "main.ts" ? `${d.file}: ${d.message}` : d.message };
}


/** The hand-made triggers as the model is sent them: the folded text when it is this short, else the index. */
export const FULL_TRIGGERS_CHARS = 12_000;
/** What the hand-made triggers block may weigh in either form. */
export const TRIGGERS_BLOCK_CHARS = 30_000;

/** The map's triggers outside the script's block, with their positions in the map's list. */
export function handTriggers(api: PluginApi, block: { start: number; count: number } | null | undefined): { index: number; trigger: TriggerRecord }[] {
  return api.triggers.list().map((trigger, index) => ({ index, trigger })).filter(({ index }) => !(block && index >= block.start && index < block.start + block.count));
}

/**
 * The hand-made triggers for the triggers recipe: the folded text when it is short (every
 * argument as written), else one line per run of triggers of the same shape — a Make
 * Scenario map has a hundred and more, mostly per-player copies, and the text of them all
 * ran past the block's budget and was cut mid-trigger. The model needs to know what is
 * there so as not to write it again; the index says that for every trigger.
 */
export function existingTriggersFor(api: PluginApi, hand: { index: number; trigger: TriggerRecord }[]): string | undefined {
  if (hand.length === 0) return undefined;
  const full = compactTriggers(api.triggers.text.print(hand.map((h) => h.trigger)));
  if (full.length <= FULL_TRIGGERS_CHARS) return full;
  return indexTriggers(hand.map(({ index, trigger }) => ({ index, comment: api.triggers.comment(trigger), ...api.triggers.summarize(trigger) })));
}

export interface TriggerRow { index: number; players: string; conditions: string; actions: string; comment: string | null }

/**
 * One line per shape of trigger (the same conditions and actions by name, for the same
 * players with their numbers blurred), in order of first appearance, giving the first
 * trigger's text and where the others are; runs of one action folded (\`Wait(0) ×62\`).
 * The copies need not be neighbours: a system that emits two triggers per stage per
 * player interleaves its shapes. Cut to the budget from the end, saying how many shapes
 * are left out.
 */
export function indexTriggers(rows: TriggerRow[], budget = TRIGGERS_BLOCK_CHARS): string {
  const shapes = new Map<string, { first: TriggerRow; at: number[] }>();
  for (const r of rows) {
    const key = shapeOf(r);
    const s = shapes.get(key);
    if (s) s.at.push(r.index);
    else shapes.set(key, { first: r, at: [r.index] });
  }
  const groups = [...shapes.values()];
  const line = (g: { first: TriggerRow; at: number[] }, width: number) => {
    const r = g.first;
    const where = g.at.length === 1 ? `#${r.index}` : `#${g.at.slice(0, 6).join(", ")}${g.at.length > 6 ? ", …" : ""} (${g.at.length} of this shape)`;
    const body = `${r.comment ? `"${r.comment}": ` : ""}[${r.players}] ${r.conditions || "Always()"} -> ${foldItems(r.actions)}`;
    return `${where} ${body.length > width ? `${body.slice(0, width - 1)}…` : body}`;
  };
  const head = `${rows.length} triggers in ${groups.length} shapes; a line is one shape — triggers that differ only by player or number — with the first one's text and the numbers of the rest:`;
  for (const width of [400, 240, 160]) {
    const lines = groups.map((g) => line(g, width));
    const out = [head, ...lines].join("\n");
    if (out.length <= budget) return out;
    if (width === 160) {
      const kept: string[] = [head];
      let size = head.length;
      let i = 0;
      for (; i < lines.length; i++) { if (size + lines[i].length + 60 > budget) break; kept.push(lines[i]); size += lines[i].length + 1; }
      const left = groups.slice(i).reduce((n, g) => n + g.at.length, 0);
      kept.push(`… and ${left} more triggers of ${groups.length - i} other shapes not listed.`);
      return kept.join("\n");
    }
  }
  return head;
}

/** What a trigger shares with its per-player copies: its owners with numbers blurred, and the names of its conditions and actions. */
function shapeOf(r: TriggerRow): string {
  const names = (s: string) => [...s.matchAll(/(?:^|&& |; )([A-Z][A-Za-z ]+)\(/g)].map((m) => m[1]).join(",");
  return `${r.players.replace(/\d+/g, "N")}|${names(r.conditions)}|${names(r.actions)}`;
}

/** \`a; a; a; b\` → \`a ×3; b\`, on the items of a summary line (a \`; \` inside a quoted string does not split). */
function foldItems(actions: string): string {
  const items: string[] = [];
  for (const part of actions.split("; ")) {
    const last = items[items.length - 1];
    if (last !== undefined && (last.split('"').length - 1) % 2 === 1) items[items.length - 1] = `${last}; ${part}`;
    else items.push(part);
  }
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    let j = i;
    while (j + 1 < items.length && items[j + 1] === items[i]) j++;
    const n = j - i + 1;
    if (n >= 3) { out.push(`${items[i]} ×${n}`); i = j; }
    else out.push(items[i]);
  }
  return out.join("; ");
}

/** Trigger text with runs of identical lines folded — three hyper triggers are 186 lines of Wait(0). */
export function compactTriggers(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
    const n = j - i + 1;
    if (n >= 3) { out.push(lines[i], `${/^\s*/.exec(lines[i])![0]}// … the line above ${n} times`); i = j; }
    else out.push(lines[i]);
  }
  return out.join("\n");
}
