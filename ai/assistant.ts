/**
 * The AI Assistant: a conversation about the open map, in a panel floating over it (or
 * docked at the right, by AI Options). A message goes to the server's `agent` recipe with the tools in
 * `tools.ts`, the map's facts (what is selected, where the view is) and the per-map
 * reference block; every tool call the model makes runs here, all of a turn's calls
 * answered together, and the loop continues while the model keeps calling tools, up to
 * the rounds the settings allow.
 *
 * What the person sees while it works is the point of this file. The transcript reads as
 * you asked → it answered, with the turn's work in one *activity block* between: a step
 * per tool call, in words (what it did, then what came back), the model's words between
 * calls as dim notes, and one fold for its reasoning. While the turn runs the block is
 * open on its last few steps with a live line; when it ends the block folds to one line —
 * steps, edits, failures, seconds, cost, an Undo for that turn's edits — and the answer
 * sits under it. A *state strip* above names the phase — waiting, thinking, writing, the
 * step it is on — with the seconds and the cost; the status bar carries the same so the
 * panel can be closed; Escape stops. The map shows a call's footprint in teal while it
 * runs (an overlay) and flashes the result in gold (`api.view.flash`). The transcript
 * scrolls with the work only while it is at the bottom. The history is trimmed from the
 * front in chunks, keeping each tool call with its result — a chunk rather than one
 * message at a time, because every trim invalidates the server's cache of the conversation.
 */
import type { EditorLayer, FoldElement, OverlayHandle, PluginApi } from "@scm-js/plugin-api";
import type { AgentContent, AgentMessage, ImageInput } from "../protocol";
import { ScmjsError, describeError, formatUsd } from "../client";
import { executeCalls, MAP_CHANGED, type ExecuteHooks } from "./execute";
import { imageInput, mapFacts, selectionLines, shrinkImage } from "./facts";
import { followBox, footprintEmpty, footprintOf, type Footprint } from "./intent";
import { renderMarkdown } from "./markdown";
import { referenceFor } from "./reference";
import { describeCall, describeStep, plural, prettyName, reportStep, summarizeResult, tools, type Tool, type ToolResult } from "./tools";
import { append, h, recipeOptions, styled, type Ctx } from "./ui";

/** Past this many messages the history is trimmed… */
export const KEEP_MESSAGES = 60;
/** …down to this many, so the cache is rebuilt once per chunk rather than once per message. */
export const TRIM_TO = 40;
/** Pictures older than this many kept ones are dropped from the history (each is re-sent every round). */
export const KEEP_IMAGES = 2;

/**
 * Drop the oldest messages past the limit — down to `to`, whole exchanges from the front,
 * so a tool call is never parted from its results and an assistant turn keeps the thinking
 * blocks it came with. The kept history always starts on a plain user message. Older
 * pictures go with the trim: a screenshot the model took twenty rounds ago is a few
 * hundred kilobytes re-uploaded on every round for nothing, and the request body has a cap.
 */
export function trimHistory(messages: AgentMessage[], keep = KEEP_MESSAGES, to = TRIM_TO): AgentMessage[] {
  if (messages.length <= keep) return messages;
  const clean = (m: AgentMessage) => m.role === "user" && !m.content.some((c) => c.type === "tool_result");
  const from = Math.max(0, messages.length - Math.min(to, keep));
  let start = from;
  while (start < messages.length && !clean(messages[start])) start++;
  if (start < messages.length) return pruneImages(messages.slice(start), KEEP_IMAGES);
  // One instruction followed by a long run of tool rounds: no clean user message in the
  // tail. Keep the brief — it is what the person asked for — and the tail from an
  // assistant turn, so every tool call still has its results.
  if (!clean(messages[0])) return messages;
  let at = from;
  while (at < messages.length && messages[at].role !== "assistant") at++;
  return pruneImages([messages[0], ...messages.slice(at)], KEEP_IMAGES);
}

/** What a request's history may weigh: the server takes 1.5 MB by default, and the facts, the reference and the tools ride in the same body. */
export const MAX_HISTORY_BYTES = 1_100_000;
/**
 * …and what it is brought down to when it is over. Well under the cap, so that the next
 * several pictures fit without another cut: a cut rewrites the messages it touches, and
 * the server's cache of every message after them with it — cutting one picture per
 * round, as the fit once did, cost a whole re-write of the history on every round that
 * followed a screenshot.
 */
export const FIT_TO_BYTES = 600_000;

/**
 * The history cut to fit the request: the oldest pictures first, one by one until the
 * history is down to `to`, then whole exchanges from the front with the brief kept, as
 * `trimHistory` does. A screenshot-heavy turn used to fail with a body-too-large error
 * partway through.
 */
export function fitHistory(messages: AgentMessage[], maxBytes = MAX_HISTORY_BYTES, to = Math.min(maxBytes, FIT_TO_BYTES)): AgentMessage[] {
  const size = (m: AgentMessage[]) => byteLength(JSON.stringify(m));
  let out = messages;
  if (size(out) <= maxBytes) return out;
  for (let keep = countImages(out) - 1; keep >= 0 && size(out) > to; keep--) out = pruneImages(out, keep);
  while (out.length > 1 && size(out) > to) {
    const cut = trimHistory(out, out.length - 1, Math.max(1, out.length - 2));
    if (cut.length >= out.length) break;
    out = cut;
  }
  return out;
}

const byteLength = (s: string) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length);

function countImages(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) for (const c of m.content) {
    if (c.type === "image") n++;
    else if (c.type === "tool_result" && Array.isArray(c.content)) for (const p of c.content) if (p.type === "image") n++;
  }
  return n;
}

/**
 * The history after a turn failed: a user message the model never answered goes, unless
 * it holds tool results — those record edits that were made, and the next request
 * continues from them.
 */
export function afterFailedTurn(messages: AgentMessage[]): AgentMessage[] {
  const last = messages[messages.length - 1];
  return last?.role === "user" && !last.content.some((c) => c.type === "tool_result") ? messages.slice(0, -1) : messages;
}

/** Whether the turn's undo button still undoes that turn: nothing was edited or undone since it finished. */
export function undoStillApplies(after: { undo: string | null; undoDepth: number }, now: { undo: string | null; undoDepth: number }): boolean {
  return now.undoDepth === after.undoDepth && now.undo === after.undo;
}

/** Replace every picture but the last `keepLast` with a note, copying only the messages that change. */
export function pruneImages(messages: AgentMessage[], keepLast: number): AgentMessage[] {
  let seen = 0;
  const out: AgentMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    let changed = false;
    const content = m.content.map((c): AgentContent => {
      if (c.type === "image") { seen++; if (seen > keepLast) { changed = true; return { type: "text", text: "(a picture that was here is no longer kept)" }; } return c; }
      if (c.type === "tool_result" && Array.isArray(c.content)) {
        let inner = false;
        const parts = c.content.map((p) => { if (p.type === "image") { seen++; if (seen > keepLast) { inner = true; return { type: "text" as const, text: "(picture no longer kept)" }; } } return p; });
        if (inner) { changed = true; return { ...c, content: parts }; }
      }
      return c;
    });
    out.unshift(changed ? { ...m, content } : m);
  }
  return out;
}

/** The prompts offered as chips above the input, by what the person is doing. */
export function chipsFor(layer: EditorLayer | string, selected: number, triggers: number): { label: string; text: string }[] {
  const chips: { label: string; text: string }[] = [
    { label: "Describe", text: "Describe this map: what kind of map it is, its layout, players and what the triggers do. Look at a screenshot first." },
    { label: "Check", text: "Check the map for problems: run the checker, look at the picture, the players and the triggers, and list what you would fix, most important first. Do not change anything yet." },
  ];
  if (selected > 0) chips.push({ label: "Selection", text: "Tell me about what I have selected." });
  switch (layer) {
    case "terrain": chips.push({ label: "Terrain", text: "Look at the terrain in view: heights, chokes, dead ends, and what you would change." }); break;
    case "units": chips.push(selected > 0 ? { label: "Balance", text: "Is this melee map fair? Compare every start location's resources, distances and chokes and say what is uneven." } : { label: "Bases", text: "List the bases: each start location with its mineral count, geysers and the nearest expansion." }); break;
    case "locations": chips.push({ label: "Locations", text: "List the locations and which triggers use each; point out any that nothing uses." }); break;
    case "fog": chips.push({ label: "Fog", text: "Which players start with which parts of the map explored? Is it even?" }); break;
    default: break;
  }
  if (triggers > 0) chips.push({ label: "Triggers", text: "Explain what the triggers do, in play order, briefly." });
  else chips.push({ label: "Scenario", text: "I want to turn this into a scenario. Read the guide for the genre I name, then propose the players, locations and systems before changing anything." });
  return chips;
}

/** The chips a fresh map on the terrain layer gets. */
export const QUICK_PROMPTS = chipsFor("terrain", 0, 0);

export interface AssistantState {
  messages: AgentMessage[];
  /** Text to put in the input when the panel opens next (a context-menu ask). */
  prefill?: string;
  /** What this panel has cost, across opens. */
  spent?: number;
  /**
   * An id for this conversation and how many requests it has made, sent with each one so
   * the server's call log can follow the chat; a new id when the chat is cleared.
   */
  conversation?: string;
  turn?: number;
}

function newConversationId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface AssistantHandle {
  close(): void;
  isOpen(): boolean;
  /** Put text in the input and focus it (or send it when `send` is true). */
  ask(text: string, send?: boolean): void;
}

/** One turn of a replayed transcript: what was asked, the work, and the answer. */
export interface ReplayTurn {
  user: string[];
  steps: ({ kind: "thinking"; text: string } | { kind: "narration"; text: string } | { kind: "call"; name: string; input: Record<string, unknown>; result?: string; image?: ImageInput; failed?: boolean })[];
  answer: string | null;
}

/**
 * The stored messages as turns, for the panel to replay. A plain user message starts a
 * turn; an assistant message's text is the answer unless it also calls tools, in which
 * case it is narration; each tool call takes its result from the user message after it.
 */
export function groupTurns(messages: AgentMessage[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  const calls = new Map<string, Extract<ReplayTurn["steps"][number], { kind: "call" }>>();
  let cur: ReplayTurn | null = null;
  for (const m of messages) {
    if (m.role === "user" && !m.content.some((c) => c.type === "tool_result")) {
      cur = { user: m.content.filter(isText).map((c) => c.text), steps: [], answer: null };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (m.role === "user") {
      for (const c of m.content) {
        if (c.type !== "tool_result") continue;
        const call = calls.get(c.toolUseId);
        if (!call) continue;
        if (typeof c.content === "string") call.result = c.content;
        else { call.result = c.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") || undefined; call.image = (c.content.find((p) => p.type === "image") as { source: ImageInput } | undefined)?.source; }
        call.failed = !!c.isError;
      }
      continue;
    }
    const usesTools = m.content.some((c) => c.type === "tool_use");
    for (const c of m.content) {
      if (c.type === "thinking") cur.steps.push({ kind: "thinking", text: c.thinking });
      else if (c.type === "text") { if (usesTools) cur.steps.push({ kind: "narration", text: c.text }); else cur.answer = cur.answer ? `${cur.answer}\n\n${c.text}` : c.text; }
      else if (c.type === "tool_use") { const step = { kind: "call" as const, name: c.name, input: c.input ?? {} }; calls.set(c.id, step); cur.steps.push(step); }
    }
  }
  return turns;
}

type Phase = "idle" | "waiting" | "thinking" | "writing" | "tools" | "stopped" | "failed";

const PHASE_LABELS: Record<Phase, string> = { idle: "Ready", waiting: "Waiting for the model", thinking: "Thinking", writing: "Writing", tools: "Working on the map", stopped: "Stopped", failed: "Failed" };

/** Whether a message content item is a turn's own text (not tool traffic). */
const isText = (c: AgentContent): c is Extract<AgentContent, { type: "text" }> => c.type === "text";

/** The teal outline of what the assistant is about to touch, drawn by an overlay while a tool runs. */
function intentOverlay(api: PluginApi): { handle: OverlayHandle; show(f: Footprint | null): void } {
  let footprint: Footprint | null = null;
  const handle = api.ui.overlay({
    name: "AI activity",
    above: "objects",
    visible: true,
    draw(ctx, view) {
      if (!footprint) return;
      const scn = api.document.scenario();
      const boxes: { l: number; t: number; r: number; b: number }[] = footprint.rects.map((r) => ({ l: r.x0 * 32, t: r.y0 * 32, r: r.x1 * 32, b: r.y1 * 32 }));
      if (scn) {
        for (const i of footprint.units) { const u = scn.units[i]; if (u) boxes.push({ l: u.x - 16, t: u.y - 16, r: u.x + 16, b: u.y + 16 }); }
        for (const i of footprint.locations) { const l = scn.locations[i]; if (l && i !== 63) boxes.push({ l: Math.min(l.left, l.right), t: Math.min(l.top, l.bottom), r: Math.max(l.left, l.right), b: Math.max(l.top, l.bottom) }); }
      }
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -((Date.now() / 40) % 10);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(79, 209, 197, 0.95)";
      ctx.fillStyle = "rgba(79, 209, 197, 0.10)";
      for (const b of boxes) {
        const x = view.x(b.l), y = view.y(b.t), w = (b.r - b.l) * view.zoom, hgt = (b.b - b.t) * view.zoom;
        ctx.fillRect(x, y, w, hgt);
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(hgt) - 1);
      }
      ctx.restore();
    },
  });
  return { handle, show: (f) => { footprint = f && !footprintEmpty(f) ? f : null; handle.redraw(); } };
}

export function openAssistant(ctx: Ctx, state: AssistantState): AssistantHandle {
  const { api } = ctx;
  const w = api.ui.widgets;
  const toolList = tools();
  const byName = new Map(toolList.map((t) => [t.def.name, t]));
  let running: AbortController | null = null;
  let askLater: ((text: string, send?: boolean) => void) | null = null;
  const dock = ctx.settings().dockAssistant;

  const handle = api.ui.panel({
    title: "AI Assistant",
    width: 440,
    dock: dock ? "right" : "float",
    grow: true,
    mount(body) {
      const root = styled(body);
      root.classList.add("ai-assistant");
      const intent = intentOverlay(api);

      /* ── the state strip ── */
      const phaseLabel = h("span", { className: "ai-phase" }, "Ready");
      const phaseDetail = h("span", { className: "ai-dim ai-grow ai-phase-detail" }, "");
      const clock = h("span", { className: "ai-dim ai-mono" }, "");
      const cost = h("span", { className: "ai-pill", title: "What this panel has cost · what the session has cost" }, "");
      const strip = h("div", { className: "ai-state is-idle" }, h("div", { className: "ai-state-line" }, phaseLabel, phaseDetail, clock, cost));
      let phase: Phase = "idle";
      let startedAt = 0;
      let clockTimer: number | null = null;
      const setCost = () => { cost.textContent = state.spent ? `${formatUsd(state.spent)} here · ${formatUsd(ctx.ledger.totals.costUsd)} session` : ctx.ledger.totals.calls ? `${formatUsd(ctx.ledger.totals.costUsd)} session` : ""; };
      const tickClock = () => { clock.textContent = startedAt ? `${Math.round((Date.now() - startedAt) / 1000)} s` : ""; };
      const setPhase = (next: Phase, detail = "") => {
        phase = next;
        strip.className = `ai-state is-${next}`;
        phaseLabel.textContent = PHASE_LABELS[next];
        phaseDetail.textContent = detail;
        const busy = next === "waiting" || next === "thinking" || next === "writing" || next === "tools";
        if (busy && clockTimer === null) { tickClock(); clockTimer = window.setInterval(tickClock, 1000); }
        if (!busy && clockTimer !== null) { window.clearInterval(clockTimer); clockTimer = null; clock.textContent = ""; }
        ctx.presence?.set({ text: busy ? `AI · ${PHASE_LABELS[next].toLowerCase()}${detail ? ` · ${detail}` : ""}` : state.spent ? `AI · ${formatUsd(state.spent)}` : "AI", busy, warn: next === "failed" });
        setCost();
      };
      setCost();

      /* ── the transcript ── */
      // Autoscroll follows only while the view is at the bottom; scrolling up to read stays
      // put, with a button back to the latest.
      const chat = h("div", { className: "ai-chat" });
      let pinned = true;
      const jump = w.button("Jump to latest", { ghost: true, onClick: () => { pinned = true; chat.scrollTop = chat.scrollHeight; jump.hidden = true; } });
      jump.classList.add("ai-jump");
      jump.hidden = true;
      chat.addEventListener("scroll", () => { pinned = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 24; jump.hidden = pinned; });
      const scroll = () => { if (pinned) chat.scrollTop = chat.scrollHeight; };
      const addUser = (text: string) => { chat.append(h("div", { className: "ai-msg is-user" }, text)); scroll(); };
      const addAssistant = (text: string) => { const el = h("div", { className: "ai-msg is-assistant" }, renderMarkdown(text)); chat.append(el); scroll(); return el; };

      /**
       * A turn's work as one block: the reasoning fold, then a step per tool call with what
       * it did and what came back, and the model's words between calls as dim notes. Open
       * while the turn runs, showing the last few steps and a live line; folded to one line
       * — steps, edits, failures, seconds, cost, an Undo — when the turn ends.
       */
      const activity = () => {
        const block = w.fold({ open: true, busy: true, text: "Working…" });
        block.classList.add("ai-act");
        const steps = w.steps({ tail: 3 });
        steps.running(true);
        block.body.append(steps);
        chat.append(block);
        scroll();
        let failed = 0;
        let think: FoldElement | null = null;
        const live = (text: string) => block.set(text);
        const step = (tool: Tool | undefined, name: string, input: Record<string, unknown> | null) => {
          const row = steps.add(input ? describeStep(tool, name, input, ctx) : `${prettyName(name)}…`, { icon: tool?.writes ? "✎" : "▸", title: input ? describeCall(name, input) : undefined, running: true });
          if (tool?.writes) row.element.classList.add("ai-write");
          const n = steps.count();
          const start = (input: Record<string, unknown>) => {
            const text = describeStep(tool, name, input, ctx);
            row.set(text, describeCall(name, input));
            live(`Step ${n} · ${text}`);
            return text;
          };
          live(`Step ${n} · ${row.element.querySelector(".step-label")?.textContent ?? ""}`);
          scroll();
          return {
            row, start,
            done(out: ToolResult) {
              const rep = reportStep(tool, out);
              row.done(rep ? `→ ${rep}` : "");
              row.element.title += `\n→ ${summarizeResult(out)}`;
              if (typeof out !== "string" && out.image) {
                const shot = h("button", { type: "button", className: "ai-act-shot", title: "Click to enlarge" }, h("img", { src: `data:${out.image.mediaType};base64,${out.image.data}`, alt: "screenshot" }));
                shot.addEventListener("click", () => shot.classList.toggle("is-open"));
                row.append(shot);
              }
              scroll();
            },
            fail(message: string) { failed++; row.fail(`✗ ${message}`); row.element.title += `\n✗ ${message}`; scroll(); },
            skip(reason = "not called") { row.skip(reason); row.element.title = reason === "not called" ? "The model named this tool but did not call it." : reason; },
          };
        };
        return {
          el: block, live, step,
          /** Rows and notes so far, to place a note before the rows a round adds. */
          size: () => steps.size(),
          /** Tool steps so far. */
          count: () => steps.count(),
          /** The model's words in a round that went on to call tools: narration, kept small. */
          note(text: string, at?: number) { steps.note(renderMarkdown(text), at); scroll(); },
          /** Reasoning, streamed into one fold for the whole turn (never its signature). */
          think(text: string) {
            if (!text || !ctx.settings().showThinking) return;
            if (!think) { think = w.fold({ text: "Reasoning" }); think.classList.add("ai-act-think"); block.body.insertBefore(think, steps); }
            think.body.append(document.createTextNode(text));
            scroll();
          },
          /** A blank line between one round's reasoning and the next. */
          thinkBreak() { if (think?.body.textContent) think.body.append(document.createTextNode("\n\n")); },
          finish(o: { secs?: number; cost?: number; edits?: number; settings?: number; undo?: HTMLElement | null; stopped?: boolean }) {
            steps.running(false);
            block.open = false;
            if (steps.size() === 0 && !think) { block.remove(); return; }
            const parts: (string | HTMLElement)[] = [];
            if (o.stopped) parts.push("Stopped");
            const count = steps.count();
            if (count) parts.push(plural(count, "step")); else if (think) parts.push("Thought");
            if (o.edits) parts.push(plural(o.edits, "edit"));
            if (o.settings) parts.push(`${plural(o.settings, "settings change")} (not undoable)`);
            if (failed) parts.push(h("span", { className: "error" }, `${failed} failed`));
            if (o.secs !== undefined) parts.push(`${o.secs} s`);
            if (o.cost) parts.push(formatUsd(o.cost));
            block.mark(failed ? "✗" : "✓", failed ? "error" : "ok");
            block.set(...parts.flatMap((p, i) => (i ? [" · ", p] : [p])));
            if (o.undo) block.action(o.undo);
            scroll();
          },
        };
      };
      type Activity = ReturnType<typeof activity>;

      /* ── what the model sees, and the chips ── */
      const context = h("div", { className: "ai-context" });
      const chipRow = h("div", { className: "ai-chips" });
      const input = h("textarea", { rows: 3, placeholder: "Ask about the map, or say what to change. Enter sends, Shift+Enter for a new line, Esc stops." });
      const refreshContext = () => {
        const open = api.document.isOpen();
        const lines = open ? selectionLines(api) : [];
        context.replaceChildren(h("span", { className: "ai-dim" }, lines.length ? `The model sees: ${lines.join(" · ")}` : "The model sees the map's state, your selection and the view with every message."));
        const selected = open ? api.selection.units().length + api.selection.locations().length + api.selection.sprites().length + api.selection.doodads().length + (api.selection.markedArea() ? 1 : 0) : 0;
        chipRow.replaceChildren(...chipsFor(open ? api.selection.layer() : "terrain", selected, open ? api.triggers.list().length : 0).map((q) => h("button", { type: "button", className: "ai-chip", title: q.text, onClick: () => { input.value = q.text; input.focus(); } }, q.label)));
      };
      refreshContext();
      // Following: the view glides to each call's spot while a turn runs, unless the user
      // moves it — a "view" event that is neither a reveal of ours nor a tool's own `go_to`
      // hands the view back to them until the next turn.
      let following = false, revealing = false, toolRunning = false;
      // Each turn's Undo button, with the history as the turn left it: a button whose
      // history has moved on (an edit, an undo) would undo the wrong thing, so it goes grey.
      const undoButtons: { button: HTMLButtonElement; after: ReturnType<PluginApi["document"]["history"]> }[] = [];
      const STALE_UNDO = "Other edits came after this turn's; undo them first, from the Edit menu.";
      const refreshUndo = () => {
        if (!api.document.isOpen()) return;
        const now = api.document.history();
        for (const u of undoButtons) if (!u.button.disabled && !undoStillApplies(u.after, now)) { u.button.disabled = true; u.button.title = STALE_UNDO; }
      };
      const offs = [api.events.on("selection", refreshContext), api.events.on("clipboard", refreshContext), api.events.on("document", () => { refreshContext(); refreshUndo(); }), api.events.on("layer", refreshContext), api.events.on("triggers", refreshContext),
        api.events.on("view", () => { if (following && !revealing && !toolRunning) following = false; })];

      /* ── buttons ── */
      const send = w.button("Send", { primary: true, onClick: () => void submit() });
      const stop = w.button("Stop", { ghost: true, onClick: () => running?.abort() });
      stop.hidden = true;
      const more = w.button("Continue", { onClick: () => void submit("Continue.") });
      more.hidden = true;
      const clearButton = w.button("Clear", { ghost: true, title: "Forget the conversation", onClick: () => { state.messages = []; state.conversation = undefined; state.turn = 0; chat.replaceChildren(); more.hidden = true; setPhase("idle"); } });
      const copyButton = w.button("Copy", { ghost: true, title: "Copy the transcript as text", onClick: () => { void navigator.clipboard?.writeText(transcript()).then(() => { phaseDetail.textContent = "Transcript copied."; }); } });
      const attach = w.checkbox("Picture", { value: ctx.settings().attachView, title: "Send a picture of the visible area with the message" });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
        if (e.key === "Escape" && running) { e.preventDefault(); running.abort(); }
      });
      root.addEventListener("keydown", (e) => { if (e.key === "Escape" && running && e.target !== input) { e.preventDefault(); running.abort(); } });

      const transcript = () => state.messages.map((m) => m.content.filter(isText).map((c) => `${m.role === "user" ? "You" : "Assistant"}: ${c.text}`).join("\n")).filter(Boolean).join("\n\n");

      // Replay what the panel already holds, a block per turn.
      for (const t of groupTurns(state.messages)) {
        for (const u of t.user) addUser(u);
        const act = activity();
        let edits = 0, settingsWrites = 0;
        for (const s of t.steps) {
          if (s.kind === "thinking") act.think(s.text);
          else if (s.kind === "narration") act.note(s.text);
          else {
            const tool = byName.get(s.name);
            const row = act.step(tool, s.name, s.input);
            if (s.failed) row.fail(s.result ?? "failed");
            else { row.done(s.image ? { text: s.result, image: s.image } : s.result ?? "Done."); if (tool?.writes) { if (tool.settings) settingsWrites++; else edits++; } }
          }
        }
        act.finish({ edits, settings: settingsWrites });
        if (t.answer) addAssistant(t.answer);
      }

      const viewPicture = async (): Promise<ImageInput | null> => {
        const v = api.view.visible();
        const info = api.document.info();
        if (!info) return null;
        const rect = { x0: Math.max(0, Math.floor(v.x0)), y0: Math.max(0, Math.floor(v.y0)), x1: Math.min(info.width, Math.ceil(v.x1)), y1: Math.min(info.height, Math.ceil(v.y1)) };
        let ppt = 8;
        while (ppt > 1 && (rect.x1 - rect.x0) * ppt * (rect.y1 - rect.y0) * ppt > 1_200_000) ppt = ppt > 8 ? ppt / 2 : ppt - 1;
        const blob = await api.graphics.renderRect(rect, { pixelsPerTile: ppt, units: true, sprites: true, locations: true, locationNames: true, startLocations: true, grid: 0 });
        return blob ? imageInput(await shrinkImage(blob)) : null;
      };

      /**
       * What the panel does around each call the executor runs: the row starts and ends,
       * the footprint is outlined while the call runs, the view glides there, and what a
       * write touched flashes after.
       */
      const hooksFor = (rows: Map<string, ReturnType<Activity["step"]>>, act: Activity): ExecuteHooks => {
        const footprints = new Map<string, Footprint>();
        const rowFor = (call: { id: string; name: string; input?: Record<string, unknown> }, tool: Tool | undefined) => {
          let row = rows.get(call.id);
          if (!row) { row = act.step(tool, call.name, call.input ?? {}); rows.set(call.id, row); }
          return row;
        };
        return {
          async before(call, tool) {
            const what = rowFor(call, tool).start(call.input ?? {});
            setPhase("tools", what);
            const footprint = footprintOf(api, call.name, call.input ?? {});
            footprints.set(call.id, footprint);
            intent.show(footprint);
            const box = following ? followBox(api, footprint) : null;
            if (box) {
              revealing = true;
              try { if (!(await api.view.reveal(box, { fit: true }))) following = false; } finally { revealing = false; }
            }
            toolRunning = true;
          },
          after(call, tool, outcome) {
            toolRunning = false;
            intent.show(null);
            const row = rowFor(call, tool);
            if (outcome.kind === "done") {
              row.done(outcome.result);
              const footprint = footprints.get(call.id);
              if (footprint && !footprintEmpty(footprint)) {
                const kind = tool?.writes ? "change" : "attention";
                for (const r of footprint.rects) api.view.flash({ rect: r, kind, ms: tool?.writes ? 700 : 400 });
                if (footprint.units.length) api.view.flash({ units: footprint.units, kind });
                if (footprint.locations.length) api.view.flash({ locations: footprint.locations, kind });
              }
            } else if (outcome.kind === "failed") row.fail(outcome.message);
            else row.skip(outcome.reason);
          },
        };
      };

      const submit = async (preset?: string) => {
        const text = (preset ?? input.value).trim();
        if (!text || running) return;
        if (!api.document.isOpen()) { setPhase("failed", "Open a map first."); return; }
        if (!preset) input.value = "";
        more.hidden = true;
        pinned = true;
        addUser(text);
        const content: AgentContent[] = [{ type: "text", text }];
        if (attach.input.checked) {
          const picture = await viewPicture();
          if (picture) {
            content.unshift({ type: "image", source: picture });
            const v = api.view.visible();
            content[1] = { type: "text", text: `${text}\n\n(The picture is the visible area, tiles ${Math.floor(v.x0)},${Math.floor(v.y0)} to ${Math.ceil(v.x1)},${Math.ceil(v.y1)}.)` };
          }
        }
        state.messages.push({ role: "user", content });
        running = new AbortController();
        // The map this turn is about: a tool never runs against a map that came in front later.
        const turnDoc = api.document.id();
        following = ctx.settings().followMap && api.document.isOpen();
        send.setBusy(true);
        stop.hidden = false;
        startedAt = Date.now();
        const historyBefore = api.document.history().undoDepth;
        const edits: string[] = [];
        const settingsWrites: string[] = [];
        const maxRounds = Math.max(1, ctx.settings().maxRounds || 24);
        let stoppedAtLimit = false;
        let turnCost = 0;
        const act = activity();
        const finishActivity = (stopped: boolean) => {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          const after = api.document.history();
          const undoSteps = Math.max(0, after.undoDepth - historyBefore);
          const undo = undoSteps > 0 ? w.button(`Undo ${undoSteps === 1 ? "it" : `these ${undoSteps}`}`, { ghost: true, title: "Undo the edits this turn made, newest first", onClick: (e) => {
            const button = e.currentTarget as HTMLButtonElement;
            if (!undoStillApplies(after, api.document.history())) { button.disabled = true; button.title = STALE_UNDO; phaseDetail.textContent = STALE_UNDO; return; }
            let count = 0;
            for (let i = 0; i < undoSteps; i++) { const label = api.document.history().undo; if (!label || !label.startsWith("AI:")) break; if (!api.document.undo()) break; count++; }
            button.disabled = true;
            phaseDetail.textContent = `Undid ${count} edit${count === 1 ? "" : "s"}.`;
            refreshUndo();
          } }) : null;
          refreshUndo();
          if (undo) undoButtons.push({ button: undo as HTMLButtonElement, after });
          act.finish({ secs, cost: turnCost, edits: edits.length, settings: settingsWrites.length, undo, stopped });
        };
        try {
          for (let round = 0; round < maxRounds; round++) {
            setPhase("waiting", round === 0 ? "" : `round ${round + 1}`);
            if (round > 0) act.live(`${plural(act.count(), "step")} so far · waiting for the model`);
            // What streams in: the words into a message that grows, the reasoning into the
            // turn's fold, tool starts into pending steps. The words are the answer until the
            // round turns out to call tools, when they become a note in the block instead.
            let streamed = "";
            const stream: { el: HTMLElement | null } = { el: null };
            let renderQueued = false;
            const roundStart = act.size();
            act.thinkBreak();
            const pendingRows = new Map<string, ReturnType<Activity["step"]>>();
            const paint = () => { renderQueued = false; if (stream.el) { stream.el.replaceChildren(renderMarkdown(streamed), h("span", { className: "ai-caret" })); scroll(); } };
            state.messages = fitHistory(trimHistory(state.messages));
            state.conversation ??= newConversationId();
            const turn = state.turn ?? 0;
            state.turn = turn + 1;
            const r = await ctx.client.run("agent", {
              messages: state.messages,
              tools: toolList.map((t) => t.def),
              facts: mapFacts(api, { triggers: false, assistant: true }),
              reference: referenceFor(api),
            }, {
              signal: running.signal,
              onThinking: (t) => { if (phase === "waiting") setPhase("thinking"); act.think(t); },
              onDelta: (t) => {
                if (phase !== "writing") setPhase("writing");
                streamed += t;
                if (!stream.el) { stream.el = h("div", { className: "ai-msg is-assistant" }); chat.append(stream.el); }
                if (!renderQueued) { renderQueued = true; requestAnimationFrame(paint); }
              },
              onToolUse: (id, name) => { setPhase("tools", `${prettyName(name)}…`); pendingRows.set(id, act.step(byName.get(name), name, null)); },
              onProgress: () => { if (phase === "waiting" || phase === "thinking") tickClock(); },
            }, { ...recipeOptions(ctx.settings()), conversation: state.conversation, turn });
            const charged = r.usage.chargedUsd ?? r.usage.costUsd;
            state.spent = (state.spent ?? 0) + charged;
            turnCost += charged;
            setCost();
            // Kept exactly as returned — thinking blocks included — and sent back unchanged next
            // turn, since the model refuses to continue a tool-using turn without them.
            const answer = r.output.content;
            state.messages.push({ role: "assistant", content: answer });
            const finalText = answer.filter(isText).map((c) => c.text).join("\n\n").trim();
            const calls = answer.filter((c): c is Extract<AgentContent, { type: "tool_use" }> => c.type === "tool_use");
            const continues = calls.length > 0 && r.output.stopReason === "tool_use";
            if (continues) { stream.el?.remove(); if (finalText) act.note(finalText, roundStart); }
            else if (stream.el) { if (finalText) stream.el.replaceChildren(renderMarkdown(finalText)); else stream.el.remove(); }
            else if (finalText) addAssistant(finalText);
            if (r.output.stopReason === "refusal") { setPhase("failed", "The model declined."); break; }
            if (!continues) break;
            // Stop between calls stops the calls: what is left is answered as not run, and
            // the turn ends once the model has been told so. The same for a map switch.
            const batch = await executeCalls(calls, { api, tools: byName, ctx, signal: running.signal, turnDoc }, hooksFor(pendingRows, act));
            const called = new Set(calls.map((c) => c.id));
            for (const [id, row] of pendingRows) if (!called.has(id)) row.skip();
            edits.push(...batch.edits);
            settingsWrites.push(...batch.settingsWrites);
            state.messages.push({ role: "user", content: batch.results });
            if (batch.stopped) throw new ScmjsError("aborted", "Stopped.");
            if (batch.mapChanged) throw new Error(MAP_CHANGED);
            if (round === maxRounds - 1) stoppedAtLimit = true;
          }
          const secs = Math.round((Date.now() - startedAt) / 1000);
          if (stoppedAtLimit) { setPhase("stopped", `after ${maxRounds} rounds of tool calls; AI Options sets the limit`); more.hidden = false; }
          else if (phase !== "failed") setPhase("idle", `Done in ${secs} s`);
          finishActivity(stoppedAtLimit);
        } catch (err) {
          const aborted = err instanceof ScmjsError && err.code === "aborted";
          setPhase(aborted ? "stopped" : "failed", aborted ? "" : describeError(err));
          state.messages = afterFailedTurn(state.messages);
          finishActivity(true);
          if (!aborted) chat.append(h("div", { className: "ai-msg is-assistant ai-bad" }, describeError(err)));
        } finally {
          running = null;
          following = false;
          startedAt = 0;
          send.setBusy(false);
          stop.hidden = true;
          intent.show(null);
          input.focus();
        }
      };

      append(root, [
        strip,
        h("div", { className: "ai-chat-wrap" }, chat, jump),
        context,
        chipRow,
        input,
        h("div", { className: "ai-btns" }, send, stop, more, attach, h("span", { style: "flex: 1" }), copyButton, clearButton),
      ]);
      askLater = (text, sendNow) => { input.value = text; input.focus(); if (sendNow) void submit(); };
      if (state.prefill) { const t = state.prefill; state.prefill = undefined; askLater(t); }
      else input.focus();
      return () => {
        running?.abort();
        for (const o of offs) o.dispose();
        intent.handle.remove();
        if (clockTimer !== null) window.clearInterval(clockTimer);
        ctx.presence?.set({ text: state.spent ? `AI · ${formatUsd(state.spent)}` : "AI", busy: false, warn: false });
        askLater = null;
      };
    },
  });
  return {
    close: () => handle.close(),
    isOpen: () => handle.isOpen(),
    ask: (text, sendNow) => { if (askLater) askLater(text, sendNow); else state.prefill = text; },
  };
}
