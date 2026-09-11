/**
 * Runs the evaluation task set (`docs/evaluation.md`, `scripts/evaluation-tasks.mjs`)
 * against a live editor and the real server, in a headless Chromium, and writes one
 * results row per task with the server's call-log rows for it.
 *
 *   npm run dev                       # scm-js, in another terminal (its build vendors the pinned plugin)
 *   npm i --no-save playwright        # here; npx playwright install chromium once
 *   SCMJS_SESSION=<session> AI_SERVER_ADMIN_TOKEN=<token> node scripts/evaluate.mjs \
 *       --maps ~/maps [--base http://localhost:5173] [--server https://api.scmjs.dev] \
 *       [--start cold|warm] [--only 1,2,R3] [--out docs/evaluation] [--timeout 20] [--browser <chrome>] [--list]
 *
 * The session is the admin account's, copied from the browser: DevTools ▸ Application ▸
 * Local Storage ▸ the editor's origin ▸ `scmjs.plugin.scmjs-dev.settings` ▸ `session`.
 * The device id stays the browser's too (`--device`), so no trial is started. The admin
 * token is the server's `AI_SERVER_ADMIN_TOKENS`; without it the row has no call columns.
 *
 * For each task: a fresh browser context signed in as that session, the map dropped on
 * the editor, the prompt typed where the task says, the wait for the assistant or the
 * dialog to finish, Check Map read, the map saved as `<out>/<id>-<start>.scx`, and the
 * server's calls since the task started pulled into `<out>/<id>-<start>.json` with the
 * transcript and the Check Map findings. `<out>/results.csv` gets the row. What the
 * script cannot judge — whether the change is the one asked for — is a column left for
 * the reader (`change_correct`), filled in after looking at the map.
 *
 * Nothing here is a test; a task that fails to drive (a dialog that did not open, a wait
 * that ran out) is written as a row with `notes` saying so and the run goes on.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TASKS } from "./evaluation-tasks.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
const BASE = opt("--base", "http://localhost:5173/").replace(/\/?$/, "/");
const SERVER = opt("--server", process.env.AI_SERVER_URL ?? "https://api.scmjs.dev").replace(/\/+$/, "");
const SESSION = opt("--session", process.env.SCMJS_SESSION ?? "");
const DEVICE = opt("--device", process.env.SCMJS_DEVICE ?? "evaluate-device");
const ADMIN = opt("--admin-token", process.env.AI_SERVER_ADMIN_TOKEN ?? "");
const MAPS = resolve(opt("--maps", process.env.SCMJS_MAPS ?? join(root, "maps")));
const OUT = resolve(root, opt("--out", "docs/evaluation"));
const START = opt("--start", "cold");
const ONLY = opt("--only", "")?.split(",").filter(Boolean) ?? [];
const TIMEOUT_MS = Number(opt("--timeout", "20")) * 60_000;
const BROWSER = opt("--browser", process.env.SCMJS_BROWSER ?? "");

if (args.includes("--list")) {
  for (const t of TASKS) console.log(`${t.id.padEnd(4)} ${t.title.padEnd(34)} ${t.manual ? "manual" : `${t.kind}${t.map ? ` on ${t.map}` : ""}`}`);
  process.exit(0);
}
if (!SESSION) { console.error("A session is needed: --session or SCMJS_SESSION (the admin account's, from the browser's localStorage)."); process.exit(2); }
if (!["cold", "warm"].includes(START)) { console.error("--start is cold or warm."); process.exit(2); }

const { chromium } = await loadPlaywright();

/** Playwright from here, or from a sibling scm-js checkout that has it (the guide screenshots need it too). */
async function loadPlaywright() {
  try { return await import("playwright"); } catch { /* not here */ }
  const sibling = resolve(root, "..", "scm-js", "node_modules", "playwright", "index.mjs");
  if (existsSync(sibling)) return await import(pathToFileURL(sibling).href);
  console.error("playwright is not installed: npm i --no-save playwright && npx playwright install chromium");
  process.exit(1);
}

const log = (text) => console.log(`   ${new Date().toTimeString().slice(0, 8)}  ${text}`);
const COLUMNS = ["date", "task", "start", "conversation", "done_claimed", "change_correct", "check_map", "rounds", "continues", "tool_calls", "tool_failures", "retries", "cost_usd", "charged_usd", "seconds", "cache_write_1h_tokens", "cache_read_tokens", "uncached_input_tokens", "stop_reason", "notes"];

/* ── the browser ──────────────────────────────────────────────────────────────── */

/** The plugin on, signed in as the session, and no file pickers so Save As downloads. */
function seed(task) {
  return `localStorage.setItem("scmjs.plugins", ${JSON.stringify(JSON.stringify([{ spec: "github:scm-js/plugin-scmjs-dev", enabled: true }]))});
  localStorage.setItem("scmjs.plugin.scmjs-dev.settings", ${JSON.stringify(JSON.stringify({
    serverUrl: SERVER, session: SESSION, deviceId: DEVICE, statusItem: true,
    ai: true, quality: "standard", showThinking: true, maxRounds: task.maxRounds ?? 24, attachView: false, dockAssistant: false, followMap: true,
  }))});
  delete window.showSaveFilePicker; delete window.showOpenFilePicker;`;
}

const BUSY = /is-(waiting|thinking|writing|tools)/;

function driver(page) {
  const wait = (ms) => page.waitForTimeout(ms);
  const p = {
    page, wait,
    async goto() { await page.goto(`${BASE}?nosplash`); await wait(2500); },
    async drop(file) {
      const path = join(MAPS, file);
      if (!existsSync(path)) throw new Error(`map missing: ${path}`);
      const b64 = readFileSync(path).toString("base64");
      const dt = await page.evaluateHandle(({ b64, name }) => {
        const bin = atob(b64); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const dt = new DataTransfer(); dt.items.add(new File([arr], name)); return dt;
      }, { b64, name: file });
      await page.dispatchEvent(".app", "drop", { dataTransfer: dt });
      await wait(3000);
    },
    async menu(top, item) {
      await page.click(`.menubar button:has-text("${top}")`); await wait(200);
      await page.locator(".menu-item", { hasText: item }).first().click(); await wait(800);
    },
    async submenu(top, sub, item) {
      await page.click(`.menubar button:has-text("${top}")`); await wait(200);
      await page.locator(".menu-item", { hasText: sub }).hover(); await wait(500);
      await page.locator(".menu-content").last().locator(".menu-item", { hasText: item }).click(); await wait(800);
    },
    async esc() { await page.keyboard.press("Escape"); await wait(300); },
    /** Every dialog closed, stopping a request still running in one first. */
    async closeDialogs() {
      for (let i = 0; i < 4 && (await page.locator(".dlg").count()) > 0; i++) {
        const stop = page.locator(".dlg .status-line button:visible").last();
        if (await stop.isVisible().catch(() => false)) { await stop.click(); await wait(800); }
        await p.esc();
      }
    },
    dlg() { return page.locator(".dlg").last(); },
    /** The status line's text in the last dialog. */
    async status() { return (await p.dlg().locator(".status-line .grow").first().textContent().catch(() => "")) ?? ""; },
    /** Poll until `fn` is true, or the deadline passes. */
    async until(fn, timeout = TIMEOUT_MS, every = 500) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await fn()) return true; await wait(every); }
      return false;
    },
    /** Poll until the dialog's status text matches, or the deadline passes; the text is returned. */
    async statusMatches(re, timeout = TIMEOUT_MS) {
      let text = "";
      const ok = await p.until(async () => { text = await p.status(); return re.test(text); }, timeout);
      return { ok, text };
    },
    steps(scope) { return scope.locator(".steps .step"); },
    async stepSummary(scope) {
      const rows = await p.steps(scope).evaluateAll((els) => els.map((el) => ({ state: el.className.replace(/\bstep\b/, "").trim(), label: el.querySelector(".step-label")?.textContent ?? "", detail: el.querySelector(".step-detail")?.textContent ?? "" })));
      return rows;
    },

    /* ── the assistant ── */
    async openAssistant() {
      await page.keyboard.press("Control+Shift+A");
      await page.locator(".plugin-panel textarea").waitFor({ timeout: 30_000 }); await wait(500);
    },
    panel() { return page.locator(".plugin-panel", { has: page.locator(".ai-state") }).last(); },
    async phase() { return (await p.panel().locator(".ai-state").getAttribute("class").catch(() => "")) ?? ""; },
    async phaseDetail() { return (await p.panel().locator(".ai-phase-detail").textContent().catch(() => "")) ?? ""; },
    async ask(text) {
      const input = p.panel().locator("textarea");
      await input.fill(text); await input.press("Enter");
      await p.until(async () => BUSY.test(await p.phase()), 15_000, 100);
    },
    /** Until the panel is no longer busy; returns the phase class. */
    async settle() { await p.until(async () => !BUSY.test(await p.phase())); return await p.phase(); },
    async transcript() { return (await p.panel().locator(".ai-chat").innerText().catch(() => "")) ?? ""; },

    /* ── after ── */
    async checkMap() {
      await p.menu("Tools", /^Check Map/);
      await p.dlg().locator(".listbox").waitFor({ timeout: 30_000 }); await wait(1500);
      const issues = await p.dlg().locator(".issue").evaluateAll((els) => els.map((el) => ({ level: /\b(error|warn|info)\b/.exec(el.className)?.[1] ?? "", text: el.textContent?.trim() ?? "" })));
      await p.esc();
      return issues;
    },
    async saveAs(path) {
      await p.menu("File", /^Save As/);
      const dl = page.waitForEvent("download", { timeout: 60_000 });
      await p.dlg().locator("button", { hasText: /^Save$/ }).click();
      await (await dl).saveAs(path);
      await wait(1000);
      if (await p.dlg().isVisible().catch(() => false)) await p.esc();
    },
    async closeMap() {
      await p.menu("File", /^Close Map/);
      const dont = page.locator(".dlg button", { hasText: /^Don't Save$/ });
      if (await dont.isVisible().catch(() => false)) await dont.click();
      await wait(800);
    },
  };
  return p;
}

/* ── the task kinds ──────────────────────────────────────────────────────────── */

async function runAssistant(p, task, ctx, r) {
  await p.openAssistant();
  await p.panel().locator("button", { hasText: /^Clear$/ }).click(); await p.wait(300);
  await p.ask(task.prompt);

  if (task.stopOn === "tools") {
    const seen = await p.until(async () => /is-tools/.test(await p.phase()), TIMEOUT_MS, 100);
    if (seen) { await p.wait(400); await p.panel().locator("button", { hasText: /^Stop$/ }).click(); r.notes.push("stopped during tools"); }
    else r.notes.push("never reached a tool call, so Stop was not pressed");
  }
  // The next request to the server is refused (the one in flight is left alone: cutting
  // the network under a stream just leaves the panel waiting for it).
  const refuse = "**/v1/recipes/**";
  if (task.refuseAfterSteps) {
    const seen = await p.until(async () => (await p.steps(p.panel()).locator(".done, .failed").count()) >= task.refuseAfterSteps, TIMEOUT_MS, 250);
    if (seen) { await ctx.route(refuse, (route) => route.abort("connectionfailed")); r.notes.push(`refused the next request after ${task.refuseAfterSteps} tool step(s)`); }
    else r.notes.push("no tool step completed, so no request was refused");
  }

  let phase = await p.settle();
  log(`assistant ${/is-(\w+)/.exec(phase)?.[1] ?? "settled"}: ${await p.phaseDetail()}`);
  if (task.refuseAfterSteps) await ctx.unroute(refuse);
  let continues = 0;
  while (task.continues && continues < task.continues && /is-stopped/.test(phase)) {
    const more = p.panel().locator("button", { hasText: /^Continue$/ });
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click(); continues++;
    await p.until(async () => BUSY.test(await p.phase()), 15_000, 100);
    phase = await p.settle();
  }
  if (task.followUp) { await p.ask(task.followUp); phase = await p.settle(); }

  r.continues = continues;
  r.phase = /is-(\w+)/.exec(phase)?.[1] ?? phase;
  r.phaseDetail = await p.phaseDetail();
  r.done_claimed = r.phase === "idle" ? "yes" : r.phase;
  const steps = await p.stepSummary(p.panel());
  r.tool_calls = steps.length;
  r.tool_failures = steps.filter((s) => /fail/.test(s.state)).length;
  r.steps = steps;
  r.transcript = await p.transcript();
}

async function runTriggers(p, task, r) {
  await p.submenu("Tools", /^AI$/, /^Write Triggers/);
  const dlg = p.dlg();
  await dlg.locator("textarea").first().fill(task.prompt);
  if (task.extend) {
    const box = dlg.locator("label", { hasText: /Extend the map/ }).locator("input[type=checkbox]");
    if (await box.isEnabled().catch(() => false)) { if (!(await box.isChecked())) await box.check(); }
    else r.notes.push("the map has no script to extend");
  }
  await dlg.locator("button", { hasText: /^Write$/ }).click();
  // Written when Build appears; then let a repair round, if one is running, finish.
  const written = await p.until(async () => await dlg.locator("button", { hasText: /^Build$/ }).isVisible().catch(() => false));
  if (!written) { r.notes.push("Write did not finish in time"); r.done_claimed = "timeout"; return; }
  log("script written, building");
  let last = "", same = 0;
  await p.until(async () => { const s = await p.status(); if (/asking for a repair/.test(s)) { same = 0; return false; } same = s === last ? same + 1 : 0; last = s; return same >= 4; }, TIMEOUT_MS, 500);
  r.repairs = (await dlg.locator(".ai-runner").innerText().catch(() => "")).match(/repair \(\d of \d\)/g)?.length ?? 0;
  r.script = await dlg.locator("textarea").nth(1).inputValue().catch(() => "");
  const stillBad = /still has errors/.test(last);
  await dlg.locator("button", { hasText: /^Build$/ }).click();
  const built = await p.statusMatches(/^Built |^Not built/, 120_000);
  r.done_claimed = built.ok && /^Built/.test(built.text) ? "yes" : stillBad ? "script has errors" : "build failed";
  r.phaseDetail = built.text;
  await p.esc();
}

async function runScenario(p, task, r) {
  await p.submenu("Tools", /^AI$/, /^Make Scenario/);
  const dlg = p.dlg();
  const selects = dlg.locator("select");
  await selects.nth(0).selectOption(String(task.size[0]));
  await selects.nth(1).selectOption(String(task.size[1]));
  await selects.nth(2).selectOption(task.tileset);
  await selects.nth(3).selectOption(String(task.players));
  await selects.nth(4).selectOption("new");
  await dlg.locator("textarea").first().fill(task.prompt);
  await dlg.locator("button", { hasText: /^Design$/ }).click();
  const designed = await p.until(async () => await dlg.locator("button", { hasText: /^Build$/ }).isVisible().catch(() => false));
  if (!designed) { r.notes.push("Design did not finish in time"); r.done_claimed = "timeout"; return; }
  log("designed, building");
  r.design = await dlg.locator(".ai-design, .dlg-body").first().innerText().catch(() => "");
  await dlg.locator("button", { hasText: /^Build$/ }).click();
  const built = await p.statusMatches(/^Built |failed step|^Kept the open map/);
  log(built.text || "build timed out");
  r.steps = await p.stepSummary(dlg);
  r.tool_calls = r.steps.length;
  r.tool_failures = r.steps.filter((s) => /fail/.test(s.state)).length;
  const waiting = r.steps.filter((s) => /skipped/.test(s.state));
  if (waiting.length) r.notes.push(`${waiting.length} system(s) waiting: ${waiting.map((s) => s.detail).join("; ")}`);
  r.done_claimed = !built.ok ? "timeout" : /^Built/.test(built.text) && !r.tool_failures ? "yes" : built.text;
  r.phaseDetail = built.text;
  await p.esc();
  if (task.then?.kind === "triggers" && r.done_claimed === "yes") {
    const sub = { notes: [] };
    await runTriggers(p, task.then, sub);
    r.then = sub;
    if (sub.done_claimed !== "yes") r.notes.push(`script: ${sub.done_claimed}`);
  }
}

/* ── the server's rows ───────────────────────────────────────────────────────── */

async function callsSince(since) {
  if (!ADMIN) return null;
  const res = await fetch(`${SERVER}/v1/admin/calls?since=${encodeURIComponent(since.toISOString())}&limit=500&prompt=1`, { headers: { authorization: `Bearer ${ADMIN}` } });
  if (!res.ok) throw new Error(`${res.status} from /v1/admin/calls: ${(await res.text()).slice(0, 200)}`);
  const { calls } = await res.json();
  return calls.filter((c) => Date.parse(c.at) >= since.getTime() - 5000 && c.recipe !== "warmup").map(withBlocks);
}

/**
 * The kept prompt (admin callers only) reduced to what the cost questions need: each
 * block of the request with its first line, its size and whether it sits under a cache
 * breakpoint, and the tool list's size. The full prompt is not kept in the record.
 */
function withBlocks(call) {
  const { prompt, ...rest } = call;
  const req = prompt?.request;
  if (!req) return rest;
  const head = (text) => (text ?? "").split("\n")[0].slice(0, 60);
  const blocks = [];
  for (const b of Array.isArray(req.system) ? req.system : []) blocks.push({ where: "system", head: head(b.text), chars: b.text?.length ?? 0, cached: !!b.cache_control });
  for (const [i, m] of (req.messages ?? []).entries()) {
    const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    for (const b of content) {
      const chars = b.type === "text" ? b.text?.length ?? 0 : b.type === "tool_result" ? JSON.stringify(b.content ?? "").length : b.type === "image" ? b.source?.bytes ?? 0 : JSON.stringify(b.input ?? "").length;
      if (i < (req.messages.length - 6) && b.type !== "text") continue; // only the tail's tool traffic, block by block
      blocks.push({ where: `${m.role}#${i}`, type: b.type, head: b.type === "text" ? head(b.text) : b.name ?? b.type, chars, cached: !!b.cache_control });
    }
  }
  const tools = req.tools ?? [];
  return { ...rest, blocks, toolsChars: JSON.stringify(tools).length, toolNames: tools.length };
}

function summarize(calls, r) {
  if (!calls) return;
  r.calls = calls;
  const convs = [...new Set(calls.map((c) => c.conversation).filter(Boolean))];
  r.conversation = convs.join("+");
  r.rounds = calls.length;
  r.cost_usd = calls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  r.charged_usd = calls.reduce((s, c) => s + (c.chargedUsd ?? c.costUsd ?? 0), 0);
  r.cache_write_1h_tokens = calls.reduce((s, c) => s + (c.cacheWrite1hTokens ?? 0), 0);
  r.cache_read_tokens = calls.reduce((s, c) => s + (c.cacheReadTokens ?? 0), 0);
  r.uncached_input_tokens = calls.reduce((s, c) => s + (c.inputTokens ?? 0), 0);
  r.stop_reason = [...new Set(calls.map((c) => c.error ? `error:${c.error.slice(0, 40)}` : c.stopReason).filter(Boolean))].join("|");
  const uses = calls.flatMap((c) => c.toolUses ?? []);
  if (uses.length && r.tool_calls === undefined) r.tool_calls = uses.length;
  // A retry: the same tool called again right after a failed step. Counted from the panel's rows.
  if (r.steps) {
    let retries = 0;
    for (let i = 1; i < r.steps.length; i++) if (/fail/.test(r.steps[i - 1].state) && r.steps[i].label === r.steps[i - 1].label) retries++;
    r.retries = retries;
  }
}

/* ── the run ─────────────────────────────────────────────────────────────────── */

const csv = (v) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function writeRow(r) {
  const file = join(OUT, "results.csv");
  if (!existsSync(file)) writeFileSync(file, COLUMNS.join(",") + "\n");
  appendFileSync(file, COLUMNS.map((c) => csv(c === "cost_usd" || c === "charged_usd" ? (r[c] === undefined ? "" : r[c].toFixed(4)) : c === "notes" ? r.notes.join("; ") : r[c])).join(",") + "\n");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ ...(BROWSER ? { executablePath: BROWSER } : {}), args: ["--no-sandbox"] });
  try {
    for (const task of TASKS) {
      if (ONLY.length && !ONLY.includes(task.id)) continue;
      const stamp = new Date();
      const r = { date: stamp.toISOString().slice(0, 16).replace("T", " "), task: task.id, start: START, change_correct: "", notes: [] };
      if (task.manual) { console.log(`${task.id} ${task.title}: manual — ${task.manual}`); continue; }
      if (task.map && !existsSync(join(MAPS, task.map))) { console.log(`${task.id} ${task.title}: skipped, ${task.map} is not in ${MAPS}`); continue; }
      console.log(`${task.id} ${task.title} (${START})…`);
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
      await ctx.addInitScript(seed(task));
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const p = driver(page);
      const t0 = Date.now();
      try {
        await p.goto();
        if (task.map) await p.drop(task.map);
        if (task.kind === "assistant") await runAssistant(p, task, ctx, r);
        else if (task.kind === "triggers") await runTriggers(p, task, r);
        else if (task.kind === "scenario") await runScenario(p, task, r);
        r.seconds = Math.round((Date.now() - t0) / 1000);
        await p.closeDialogs();
        log("checking and saving");
        try {
          const issues = await p.checkMap();
          r.issues = issues;
          const e = issues.filter((i) => i.level === "error").length, w = issues.filter((i) => i.level === "warn").length;
          r.check_map = e ? `${e} error${e === 1 ? "" : "s"}` : w ? `${w} warning${w === 1 ? "" : "s"}` : "pass";
        } catch (err) { r.notes.push(`Check Map: ${err.message.split("\n")[0]}`); }
        const mapOut = join(task.saveAs ? MAPS : OUT, task.saveAs ?? `${task.id}-${START}.scx`);
        try { await p.saveAs(mapOut); r.saved = mapOut; } catch (err) { r.notes.push(`save: ${err.message.split("\n")[0]}`); }
      } catch (err) {
        r.seconds = Math.round((Date.now() - t0) / 1000);
        r.notes.push(`driver: ${err.message.split("\n")[0]}`);
        r.done_claimed ??= "not run";
        await page.screenshot({ path: join(OUT, `${task.id}-${START}-failed.png`) }).catch(() => {});
      }
      if (errors.length) r.notes.push(`page errors: ${errors.length}`);
      try { summarize(await callsSince(stamp), r); } catch (err) { r.notes.push(`calls: ${err.message}`); }
      const { notes, ...rest } = r;
      writeFileSync(join(OUT, `${task.id}-${START}.json`), JSON.stringify({ ...rest, notes, pageErrors: errors, task }, null, 2));
      if (task.scored !== false) writeRow(r);
      console.log(`   ${r.done_claimed ?? "?"} · ${r.check_map ?? "no check"} · ${r.rounds ?? "?"} calls · ${r.cost_usd === undefined ? "no cost" : `$${r.cost_usd.toFixed(3)}`} · ${r.seconds}s${notes.length ? ` · ${notes.join("; ")}` : ""}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

await main();
