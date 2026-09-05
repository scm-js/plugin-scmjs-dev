/**
 * The typed client for the account and map-storage routes of an ai-server. Every call
 * is one `fetch` under the server address with the session as a bearer; a failure is a
 * `ScmjsError` carrying the server's error code (or `network`, `aborted`, `protocol`
 * for what never reached one). `fetch` is injected so the tests run without a network.
 */
import type {
  AccountResponse, AuthStartResponse, CheckoutResponse, ErrorBody, ErrorCode, InfoResponse, MapListResponse, MapMeta, MapPatch, MapResponse,
  RevisionPatch, StorageResponse, TrialResponse,
} from "./protocol";

export interface Credentials {
  serverUrl: string;
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
      case "unauthorized": return `The session has ended: ${err.message}`;
      case "forbidden": return `The server refused: ${err.message}`;
      case "rate_limited": return `Too many requests for now.${retry}`;
      case "too_busy": return `The server is busy.${retry || " Try again in a moment."}`;
      case "budget_exceeded": return err.message;
      case "storage_full": return err.message;
      case "not_found": return err.message;
      case "invalid_input": return `The server rejected the request: ${err.message}`;
      case "network": return `The server could not be reached: ${err.message}`;
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
  const message = err instanceof Error ? err.message : String(err);
  return new ScmjsError("network", message.replace(/^TypeError: /, "") || "no answer.");
}

async function errorOf(res: Response): Promise<ScmjsError> {
  let body: ErrorBody | null = null;
  try { body = (await res.json()) as ErrorBody; } catch { /* not JSON */ }
  const retry = Number(res.headers.get("retry-after") ?? "") || undefined;
  if (body && body.error && typeof body.error.code === "string") {
    return new ScmjsError(body.error.code, body.error.message, { retryAfterSec: body.error.retryAfterSec ?? retry, status: res.status });
  }
  return new ScmjsError("protocol", `HTTP ${res.status} with no error body.`, { status: res.status });
}

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

export interface UploadFields {
  fileName: string;
  name?: string;
  description?: string;
  note?: string;
  meta?: MapMeta;
}

export class ScmjsClient {
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

  info(signal?: AbortSignal): Promise<InfoResponse> {
    return this.request<InfoResponse>("/v1/info", { signal });
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
}

/** The file name out of a `Content-Disposition`, the RFC 5987 form first. */
export function fileNameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!); } catch { /* fall through */ } }
  const plain = /filename="([^"]*)"/i.exec(header) ?? /filename=([^;]+)/i.exec(header);
  return plain ? plain[1]!.trim() : null;
}
