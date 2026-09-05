/**
 * The typed client for scmjs.dev's server (an ai-server, https://github.com/scm-js/ai-server):
 * the account routes, the map storage routes, and the AI *recipes*. Every call is one
 * `fetch` under the server address with the session as a bearer; a failure is a
 * `ScmjsError` carrying the server's error code (or `network`, `aborted`, `protocol` for
 * what never reached one). A recipe runs over `POST /v1/recipes/<name>` with
 * `Accept: text/event-stream` and an SSE parser that copes with frames split across
 * chunks; the `Ledger` is what the session has cost. `fetch` is injected so the tests run
 * without a network, and nothing is sent until a method is called.
 */
import type {
  AccountResponse, Allowance, AuthStartResponse, CheckoutResponse, ErrorBody, ErrorCode, InfoResponse, MapListResponse, MapMeta, MapPatch, MapResponse,
  RecipeEvent, RecipeInputs, RecipeName, RecipeOptions, RecipeOutputs, RecipeRequest, RecipeResponse, RevisionPatch, StorageResponse, TrialResponse, Usage,
} from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";

export interface Credentials {
  serverUrl: string;
  /** The session the server issued (a trial's or a signed-in account's); empty for a guest. */
  session: string;
}

export class ScmjsError extends Error {
  readonly code: ErrorCode | "network" | "aborted" | "protocol";
  readonly retryAfterSec?: number;
  readonly status?: number;
  constructor(code: ScmjsError["code"], message: string, extra: { retryAfterSec?: number; status?: number } = {}) {
    super(message);
    this.name = "ScmjsError";
    this.code = code;
    this.retryAfterSec = extra.retryAfterSec;
    this.status = extra.status;
  }
}

/** The sentence a dialog shows for a failure, with what to do about it. */
export function describeError(err: unknown): string {
  if (err instanceof ScmjsError) {
    const retry = err.retryAfterSec ? ` Try again in ${err.retryAfterSec >= 90 ? `${Math.ceil(err.retryAfterSec / 60)} minutes` : `${err.retryAfterSec} seconds`}.` : "";
    switch (err.code) {
      case "unauthorized": return `The session has ended: ${err.message} Sign in again from the Account menu.`;
      case "forbidden": return `The server refused: ${err.message}`;
      case "rate_limited": return `Too many requests for now.${retry}`;
      case "too_busy": return `The server is busy.${retry || " Try again in a moment."}`;
      case "budget_exceeded": return `The balance is used up: ${err.message}`;
      case "storage_full": return err.message;
      case "not_found": return err.message;
      case "recipe_disabled": return "This feature is turned off on the server for now.";
      case "model_not_allowed": return `The server does not allow that model: ${err.message}`;
      case "refused": return `The model declined this request. ${err.message}`.trim();
      case "invalid_input": return `The server rejected the request: ${err.message}`;
      case "upstream": return `The model service failed: ${err.message}`;
      case "network": return `scmjs.dev could not be reached: ${err.message} Check your connection and try again.`;
      case "aborted": return "Stopped.";
      case "protocol": return `The server answered in a form this plugin does not understand: ${err.message}`;
      default: return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function toNetworkError(err: unknown): ScmjsError {
  if (err instanceof ScmjsError) return err;
  if (err instanceof DOMException && err.name === "AbortError") return new ScmjsError("aborted", "stopped.");
  const message = (err instanceof Error ? err.message : String(err)).replace(/^TypeError: /, "") || "no answer";
  return new ScmjsError("network", message.endsWith(".") ? message : `${message}.`);
}

async function errorOf(res: Response): Promise<ScmjsError> {
  let body: ErrorBody | null = null;
  try { body = (await res.json()) as ErrorBody; } catch { /* not JSON */ }
  const retry = Number(res.headers.get("retry-after") ?? "") || undefined;
  if (body && body.error && typeof body.error.code === "string") {
    return new ScmjsError(body.error.code, body.error.message, { retryAfterSec: body.error.retryAfterSec ?? retry, status: res.status });
  }
  if (res.status === 401) return new ScmjsError("unauthorized", `HTTP ${res.status}.`, { status: res.status });
  if (res.status === 429) return new ScmjsError("rate_limited", `HTTP ${res.status}.`, { status: res.status, retryAfterSec: retry });
  return new ScmjsError("protocol", `HTTP ${res.status} with no error body.`, { status: res.status });
}

/* ── Formatting ─────────────────────────────────────────── */

export function formatUsd(v: number): string {
  if (v < 0.005) return v === 0 ? "$0.00" : "<$0.01";
  return `$${v.toFixed(2)}`;
}

/** What a sign-in gets, worded from the server's offer: a one-time credit, a weekly allowance, both or neither. */
export function signInGives(offers: { signupUsd: number; weeklyUsd: number }): string {
  const gets = [offers.signupUsd > 0 ? `${formatUsd(offers.signupUsd)} of credit to start` : "", offers.weeklyUsd > 0 ? `${formatUsd(offers.weeklyUsd)} a week, refilled every Monday` : ""].filter(Boolean);
  return gets.length ? `gives ${gets.join(" and ")}` : "keeps your balance across browsers";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** `$0.18 · 14 s · 6.2k in / 1.1k out`. */
export function formatUsage(u: Usage): string {
  const secs = u.durationMs >= 1000 ? `${Math.round(u.durationMs / 1000)} s` : `${u.durationMs} ms`;
  const inTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `${formatUsd(u.costUsd)} · ${secs} · ${formatTokens(inTokens)} in / ${formatTokens(u.outputTokens)} out`;
}

/* ── SSE ────────────────────────────────────────────────── */

/**
 * A server-sent-events parser fed chunk by chunk: frames are separated by a blank
 * line, a frame's `data:` lines are joined with newlines, and a frame with no data is
 * ignored (a comment line `:` is what a heartbeat looks like). Bytes of a frame that
 * has not ended yet wait for the next chunk.
 */
export class SseParser {
  private buffer = "";

  feed(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const out: string[] = [];
    let at: number;
    while ((at = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
      if (data.length > 0) out.push(data.join("\n"));
    }
    return out;
  }

  /** Whatever is left when the stream ends: a last frame with no trailing blank line. */
  end(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const data = rest.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    return data.length > 0 ? [data.join("\n")] : [];
  }
}

/* ── Ledger ─────────────────────────────────────────────── */

export interface LedgerTotals {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** What the session has spent on AI so far, shown at the foot of every AI dialog. */
export class Ledger {
  readonly totals: LedgerTotals = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  private readonly listeners = new Set<() => void>();

  add(usage: Usage) {
    this.totals.calls++;
    this.totals.costUsd += usage.costUsd;
    this.totals.inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    this.totals.outputTokens += usage.outputTokens;
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  summary(): string {
    const t = this.totals;
    if (t.calls === 0) return "Nothing spent this session.";
    return `Session: ${formatUsd(t.costUsd)} over ${t.calls} call${t.calls === 1 ? "" : "s"}`;
  }
}

/* ── Recipes ────────────────────────────────────────────── */

export interface RunHooks {
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  onProgress?: (elapsedMs: number) => void;
  onStart?: (model: string) => void;
  /** The assistant committed to a tool call (`agent`): its name now, its arguments with the result. */
  onToolUse?: (id: string, name: string) => void;
  signal?: AbortSignal;
}

export interface RunResult<N extends RecipeName> {
  output: RecipeOutputs[N];
  usage: Usage;
  remaining?: RecipeResponse["remaining"];
}

/* ── Maps ───────────────────────────────────────────────── */

export interface UploadFields {
  fileName: string;
  name?: string;
  description?: string;
  note?: string;
  meta?: MapMeta;
}

/* ── Client ─────────────────────────────────────────────── */

export class ScmjsClient {
  readonly ledger = new Ledger();
  /** Runs before every recipe call — the account manager uses it to obtain a trial session first. */
  prepare: (() => Promise<void>) | null = null;
  /** Hears the allowance that came back with a recipe result. */
  onRemaining: ((remaining: Allowance) => void) | null = null;
  private readonly credentials: () => Credentials;
  private readonly fetchImpl: typeof fetch;

  constructor(credentials: () => Credentials, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
  }

  base(): string {
    const url = this.credentials().serverUrl.trim().replace(/\/+$/, "");
    if (!url) throw new ScmjsError("network", "no server address is set.");
    return url;
  }

  headers(): Record<string, string> {
    const session = this.credentials().session.trim();
    return session ? { Authorization: `Bearer ${session}` } : {};
  }

  private async request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init;
    const headers: Record<string, string> = { Accept: "application/json", ...this.headers(), ...(rest.headers as Record<string, string> | undefined) };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}${path}`, { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await errorOf(res);
    try { return (await res.json()) as T; } catch (err) { throw new ScmjsError("protocol", (err as Error).message); }
  }

  /* ── Accounts ─────────────────────────────────────────── */

  /** `GET /v1/info`: what the server offers and what the caller has left; refuses a server speaking another protocol. */
  async info(signal?: AbortSignal): Promise<InfoResponse> {
    const info = await this.request<InfoResponse>("/v1/info", { signal });
    if (info.protocol !== undefined && info.protocol !== PROTOCOL_VERSION) throw new ScmjsError("protocol", `it speaks protocol ${info.protocol}, this plugin speaks ${PROTOCOL_VERSION}.`);
    return info;
  }

  /** `POST /v1/trial`: a session with the free trial on it, once per device id. */
  trial(deviceId: string): Promise<TrialResponse> {
    return this.request<TrialResponse>("/v1/trial", { method: "POST", json: { deviceId } });
  }

  /** `POST /v1/auth/start`: where to send the popup; the callback posts the session back to `returnOrigin`. */
  authStart(provider: string, returnOrigin: string): Promise<AuthStartResponse> {
    return this.request<AuthStartResponse>("/v1/auth/start", { method: "POST", json: { provider, returnOrigin } });
  }

  logout(): Promise<unknown> {
    return this.request("/v1/auth/logout", { method: "POST", json: {} });
  }

  /** `GET /v1/account`: the balance, the ledger and the storage line behind the session. */
  account(signal?: AbortSignal): Promise<AccountResponse> {
    return this.request<AccountResponse>("/v1/account", { signal });
  }

  checkout(pack: string): Promise<CheckoutResponse> {
    return this.request<CheckoutResponse>("/v1/billing/checkout", { method: "POST", json: { pack } });
  }

  /* ── Maps ─────────────────────────────────────────────── */

  storage(): Promise<StorageResponse> {
    return this.request<StorageResponse>("/v1/storage");
  }

  listMaps(signal?: AbortSignal): Promise<MapListResponse> {
    return this.request<MapListResponse>("/v1/maps", { signal });
  }

  map(id: string, signal?: AbortSignal): Promise<MapResponse> {
    return this.request<MapResponse>(`/v1/maps/${encodeURIComponent(id)}`, { signal });
  }

  private form(bytes: Uint8Array | Blob, fields: UploadFields): FormData {
    const fd = new FormData();
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: "application/octet-stream" });
    fd.append("file", blob, fields.fileName);
    fd.append("fileName", fields.fileName);
    if (fields.name !== undefined) fd.append("name", fields.name);
    if (fields.description !== undefined) fd.append("description", fields.description);
    if (fields.note !== undefined) fd.append("note", fields.note);
    if (fields.meta) fd.append("meta", JSON.stringify(fields.meta));
    return fd;
  }

  /** `POST /v1/maps`: a new map whose first revision is this file. */
  createMap(bytes: Uint8Array | Blob, fields: UploadFields, signal?: AbortSignal): Promise<MapResponse> {
    return this.request<MapResponse>("/v1/maps", { method: "POST", body: this.form(bytes, fields), signal });
  }

  /** `POST /v1/maps/:id/revisions`: one more revision on a map. */
  uploadRevision(id: string, bytes: Uint8Array | Blob, fields: UploadFields, signal?: AbortSignal): Promise<MapResponse> {
    return this.request<MapResponse>(`/v1/maps/${encodeURIComponent(id)}/revisions`, { method: "POST", body: this.form(bytes, fields), signal });
  }

  patchMap(id: string, patch: MapPatch): Promise<MapResponse> {
    return this.request<MapResponse>(`/v1/maps/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
  }

  deleteMap(id: string): Promise<StorageResponse> {
    return this.request<StorageResponse>(`/v1/maps/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  patchRevision(id: string, number: number, patch: RevisionPatch): Promise<MapResponse> {
    return this.request<MapResponse>(`/v1/maps/${encodeURIComponent(id)}/revisions/${number}`, { method: "PATCH", json: patch });
  }

  deleteRevision(id: string, number: number): Promise<MapResponse> {
    return this.request<MapResponse>(`/v1/maps/${encodeURIComponent(id)}/revisions/${number}`, { method: "DELETE" });
  }

  /** `GET /v1/maps/:id/revisions/:n/file`: the bytes as they were uploaded. */
  async revisionFile(id: string, number: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}/v1/maps/${encodeURIComponent(id)}/revisions/${number}/file`, { headers: this.headers(), signal });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await errorOf(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, fileName: fileNameFrom(res.headers.get("content-disposition")) ?? "map.scx" };
  }

  /* ── Recipes ──────────────────────────────────────────── */

  /** Run one recipe, streaming events to the hooks; resolves with the output and what it cost. */
  async run<N extends RecipeName>(name: N, input: RecipeInputs[N], hooks: RunHooks = {}, options?: RecipeOptions): Promise<RunResult<N>> {
    if (this.prepare) await this.prepare();
    const body: RecipeRequest<N> = { protocol: PROTOCOL_VERSION, input, options };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}/v1/recipes/${name}`, {
        method: "POST",
        headers: { Accept: "text/event-stream", ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: hooks.signal,
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await errorOf(res);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      // A JSON answer (a server that does not stream): one result.
      const r = (await res.json()) as RecipeResponse<N>;
      this.ledger.add(r.usage);
      if (r.remaining) this.onRemaining?.(r.remaining);
      return { output: r.output, usage: r.usage, remaining: r.remaining };
    }
    if (!res.body) throw new ScmjsError("protocol", "the stream had no body.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let result: RunResult<N> | null = null;
    const handle = (data: string) => {
      let ev: RecipeEvent<N>;
      try { ev = JSON.parse(data) as RecipeEvent<N>; } catch { return; }
      switch (ev.event) {
        case "start": hooks.onStart?.(ev.model); break;
        case "progress": hooks.onProgress?.(ev.elapsedMs); break;
        case "thinking": hooks.onThinking?.(ev.text); break;
        case "delta": hooks.onDelta?.(ev.text); break;
        case "tool_use": hooks.onToolUse?.(ev.id, ev.name); break;
        case "result": result = { output: ev.output, usage: ev.usage, remaining: ev.remaining }; break;
        case "error": throw new ScmjsError(ev.error.code, ev.error.message, { retryAfterSec: ev.error.retryAfterSec });
        case "done": break;
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const data of parser.feed(decoder.decode(value, { stream: true }))) handle(data);
      }
      for (const data of parser.end()) handle(data);
    } catch (err) {
      if (err instanceof ScmjsError) throw err;
      throw toNetworkError(err);
    }
    if (!result) throw new ScmjsError("protocol", "the stream ended without a result.");
    const r: RunResult<N> = result;
    this.ledger.add(r.usage);
    if (r.remaining) this.onRemaining?.(r.remaining);
    return r;
  }
}

/** The file name out of a `Content-Disposition`, the RFC 5987 form first. */
export function fileNameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!); } catch { /* fall through */ } }
  const plain = /filename="([^"]*)"/i.exec(header) ?? /filename=([^;]+)/i.exec(header);
  return plain ? plain[1]!.trim() : null;
}
