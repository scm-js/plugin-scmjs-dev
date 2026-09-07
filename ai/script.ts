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
