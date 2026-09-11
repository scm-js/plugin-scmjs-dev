/**
 * Running the tool calls of one model round, apart from the panel that shows them: each
 * call in order, its result as the model will see it, a failure marked as one, a write
 * counted only when it happened. The guards live here too — Stop between calls answers
 * the rest as not run, and a call never runs against a map that came in front after the
 * turn began — so the panel supplies only what it draws (`ExecuteHooks`) and the rest
 * is tested without a DOM.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { AgentContent } from "../protocol";
import { isFailure, toContent, type Tool, type ToolResult } from "./tools/common";
import type { Ctx } from "./ui";

export type ToolCall = Extract<AgentContent, { type: "tool_use" }>;

export type CallOutcome =
  | { kind: "done"; result: ToolResult }
  | { kind: "failed"; message: string }
  | { kind: "skipped"; reason: string };

export interface ExecuteDeps {
  api: PluginApi;
  tools: Map<string, Tool>;
  ctx: Ctx;
  /** Stop: a call not yet started when this fires is answered as not run. */
  signal: AbortSignal;
  /** `api.document.id()` when the turn began; a call is refused once another map is in front. */
  turnDoc: number | null;
}

export interface ExecuteHooks {
  /** Before a call runs: its row, the outline of what it is about to touch, the glide there. */
  before?(call: ToolCall, tool: Tool | undefined): Promise<void> | void;
  /** After every call, however it ended. */
  after?(call: ToolCall, tool: Tool | undefined, outcome: CallOutcome): void;
}

export interface ExecuteOutcome {
  /** One tool_result per call, in order, ready to send back. */
  results: AgentContent[];
  /** The names of the writing tools that ran and did not fail. */
  edits: string[];
  /** The same for settings-style writes, which are not undoable. */
  settingsWrites: string[];
  stopped: boolean;
  mapChanged: boolean;
}

/** What a tool call answers when another map came in front during the turn. */
export const MAP_CHANGED = "the map in front changed while the assistant was working, so the turn stopped; ask again on the map it should work on";
export const STOPPED = "Not run: the turn was stopped.";

export async function executeCalls(calls: ToolCall[], deps: ExecuteDeps, hooks: ExecuteHooks = {}): Promise<ExecuteOutcome> {
  const out: ExecuteOutcome = { results: [], edits: [], settingsWrites: [], stopped: false, mapChanged: false };
  for (const call of calls) {
    const tool = deps.tools.get(call.name);
    const input = call.input ?? {};
    if (deps.signal.aborted) {
      out.stopped = true;
      out.results.push(toContent(call.id, STOPPED, true));
      hooks.after?.(call, tool, { kind: "skipped", reason: STOPPED });
      continue;
    }
    if (deps.api.document.id() !== deps.turnDoc) {
      out.mapChanged = true;
      out.results.push(toContent(call.id, `Error: ${MAP_CHANGED}`, true));
      hooks.after?.(call, tool, { kind: "failed", message: MAP_CHANGED });
      continue;
    }
    try {
      await hooks.before?.(call, tool);
      if (!tool) throw new Error(`no tool called ${call.name}`);
      const result = await tool.run(input, deps.ctx);
      // As the tool returned it: each tool caps its own output to what it is for.
      out.results.push(toContent(call.id, result));
      if (isFailure(result)) { hooks.after?.(call, tool, { kind: "failed", message: result.error }); continue; }
      if (tool.writes) (tool.settings ? out.settingsWrites : out.edits).push(call.name);
      hooks.after?.(call, tool, { kind: "done", result });
    } catch (err) {
      const message = (err as Error).message;
      out.results.push(toContent(call.id, `Error: ${message}`, true));
      hooks.after?.(call, tool, { kind: "failed", message });
    }
  }
  return out;
}
