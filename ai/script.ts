/**
 * The Trigger Script plugin's commands, typed: what the editor's `api.script` used to be
 * before the Script Editor became a plugin of its own. Plugins activate in no fixed
 * order and the user may have it switched off, so every use goes through `scriptBridge`
 * and says `NO_SCRIPT_PLUGIN` when it answers null.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { TriggerRecord } from "@scm-js/plugin-api";

export const SCRIPT_PLUGIN = "trigger-script";
export const NO_SCRIPT_PLUGIN = "The Trigger Script plugin is off. Turn it on under Plugins ▸ Manage Plugins… to write, compile or build trigger scripts.";

export interface ScriptDiagnostic {
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  source: "typescript" | "compiler";
}

export interface CompileResult {
  triggers: TriggerRecord[];
  /** Per trigger, the 1-based line of its `trigger(` call or of the statement it came from. */
  lines: number[];
  diagnostics: ScriptDiagnostic[];
  variables: { name: string; kind: "number" | "boolean"; storage: string }[];
  program: { owner: number; start: number; count: number; hyperTriggers: boolean } | null;
  ok: boolean;
}

export interface ScriptBlock {
  start: number;
  count: number;
  lines: number[];
}

export interface ScriptState {
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

export interface ScriptBridge {
  state(): ScriptState | null;
  declarations(): string;
  compile(source: string): Promise<CompileResult>;
  build(source: string, options?: { takeOver?: boolean }): Promise<{ compiled: CompileResult; block: ScriptBlock | null }>;
  print(triggers: TriggerRecord[]): string;
  simulate(triggers: TriggerRecord[], cycles: number, options?: { player?: number }): ScriptSimulation;
  triggerAtLine(line: number): number | null;
  /** Open the Script Editor, on a line. */
  open(line?: number): void;
}

export function hasScriptPlugin(api: PluginApi): boolean {
  return api.commands.has(`${SCRIPT_PLUGIN}.compile`);
}

/** The bridge, or null while the Trigger Script plugin is off. */
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
    declarations: () => String(run("declarations") ?? ""),
    compile: (source) => async("compile", source),
    build: (source, options) => async("build", source, options ?? {}),
    print: (triggers) => String(run("print", triggers) ?? ""),
    simulate: (triggers, cycles, options) => (run("simulate", triggers, cycles, options ?? {}) as ScriptSimulation | undefined) ?? { cycles: 0, events: [], switches: [] },
    triggerAtLine: (line) => (run("triggerAtLine", line) as number | null | undefined) ?? null,
    open: (line) => { run("open", line ? { line } : {}); },
  };
}

/**
 * The declarations as the model needs them, not as the compiler does. The generated file
 * lists every name twice (a camel-case constant and the StarEdit name in quotes), all 256
 * switches and every AI script — 72k characters, of which the model reads a few. The
 * compiler still checks the script against the whole file, so a name trimmed here that
 * the model uses anyway still compiles. Units keep their camel-case constants (the quoted
 * form is a rule, stated once); switches keep the first sixteen and every named one; AI
 * scripts become an index signature.
 */
export function trimDeclarations(text: string): string {
  let out = text;
  // Units: drop the quoted twins.
  out = out.replace(/(declare const Units: \{\n)([\s\S]*?)(\n\};)/, (_m, head: string, body: string, tail: string) => {
    const kept = body.split("\n").filter((line) => !/^\s*readonly "/.test(line));
    return `${head}  // Every unit is also indexable by its StarEdit name: Units["Terran Marine"].\n${kept.join("\n")}${tail}`;
  });
  // Switches: the first sixteen numbered ones and every named one.
  out = out.replace(/(declare const Switches: \{\n)([\s\S]*?)(\n\};)/, (_m, head: string, body: string, tail: string) => {
    const kept = body.split("\n").filter((line) => {
      const m = /^\s*readonly (?:"?)(Switch ?(\d+))"?:/.exec(line);
      if (!m) return true;
      return Number(m[2]) <= 16 && !line.includes('"');
    });
    return `${head}  // Switch1 … Switch256 exist; the first sixteen are listed. A switch given a name in the map is listed by that name.\n${kept.join("\n")}${tail}`;
  });
  // AI scripts: any name goes; the list is long and rarely wanted.
  out = out.replace(/declare const AiScripts: \{\n[\s\S]*?\n\};/, "declare const AiScripts: { readonly [name: string]: AiScriptId<number> }; // every StarEdit AI script by its name (\"Terran Custom Level\") or four-letter code");
  return out;
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
