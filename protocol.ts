/**
 * The wire contract with an ai-server (https://github.com/scm-js/ai-server): the account
 * and map-storage parts of its `src/protocol.ts`, copied word for word — the AI plugin
 * carries the whole file, this plugin only what accounts and maps need. Keep the blocks
 * identical to the server's when they change there.
 */

export type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "budget_exceeded"
  | "too_busy"
  | "recipe_disabled"
  | "model_not_allowed"
  /** The model declined; `message` carries its category when there is one. */
  | "refused"
  | "upstream"
  | "internal"
  /** No map or revision by that id on the account. */
  | "not_found"
  /** The upload would take the account past its storage cap. */
  | "storage_full";

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** For `rate_limited` / `too_busy`: when to try again. */
    retryAfterSec?: number;
  };
}

export interface Allowance {
  /** Requests left in the current minute / day; absent when unlimited. */
  requestsPerMinute?: number;
  requestsPerDay?: number;
  /** Dollars left today; absent when unlimited. */
  budgetUsd?: number;
  /** Dollars left on the account (weekly allowance plus purchased credit); session callers only. */
  balanceUsd?: number;
}

/* ── Accounts ───────────────────────────────────────────── */

/** What the server's account system offers, when it has one. */
export interface AccountsInfo {
  /** Sign-in providers, in the order to show them. */
  providers: { id: string; name: string }[];
  /** A browser that has not had one can ask for a free trial session. */
  trial: boolean;
  /** Dollars a trial starts with. */
  trialUsd: number;
  /** The default role's weekly allowance, for the sign-in pitch. */
  weeklyUsd: number;
  /** Credit packs on sale; empty when the server takes no payments. */
  packs: CreditPack[];
  /** The account page (sign in, ledger, top up, link providers, delete), for a new tab. */
  accountUrl: string;
  /** Map storage (`/v1/maps`) is on: a signed-in account can keep maps and their revisions here. */
  maps: boolean;
}

export interface CreditPack {
  id: string;
  /** What it costs. */
  priceUsd: number;
  /** What lands on the balance — the price less the payment fee, when sold at cost. */
  creditUsd: number;
}

/** A session caller's account as the plugin shows it. */
export interface AccountView {
  /** A trial has no sign-in yet. */
  kind: "trial" | "account";
  /** The display name from the provider; absent for a trial. */
  name?: string;
  /** The role the account is on (`trial` for a trial): what it may call and how much a week. */
  role: string;
  /** The role has no balance: nothing is checked or charged. */
  unlimited?: boolean;
  /** Weekly allowance left plus purchased credit. */
  balanceUsd: number;
  weeklyUsd: number;
  creditUsd: number;
  /** When the weekly allowance next fills, ISO 8601; absent for a trial. */
  resetsAt?: string;
  /** Provider ids linked to the account. */
  providers: string[];
  /** Map storage used and allowed; absent when the server keeps no maps or for a trial. */
  storage?: StorageView;
}

/* ── Map storage ────────────────────────────────────────── */

export interface StorageView {
  usedBytes: number;
  capBytes: number;
  maps: number;
  revisions: number;
}

/**
 * What the plugin knows about a map when it uploads a revision, so the list can show
 * it without opening the file: all optional, none trusted for anything but display.
 * `thumbnail` is a `data:image/png;base64,…` of the map at one pixel per tile.
 */
export interface MapMeta {
  scenarioName?: string;
  description?: string;
  tileset?: string;
  width?: number;
  height?: number;
  players?: number;
  humanPlayers?: number;
  units?: number;
  triggers?: number;
  thumbnail?: string;
}

export interface MapRevisionView {
  id: string;
  /** 1 for the first upload, counting up; never reused after a delete. */
  number: number;
  note: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  meta: MapMeta;
  createdAt: string;
}

export interface MapSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  revisions: number;
  /** The newest revision. */
  head: MapRevisionView;
}

export interface MapDetail extends MapSummary {
  /** Newest first. */
  history: MapRevisionView[];
}

/** `GET /v1/maps` — newest change first. */
export interface MapListResponse {
  maps: MapSummary[];
  storage: StorageView;
}

/** `POST /v1/maps`, `GET`/`PATCH /v1/maps/:id`, `POST /v1/maps/:id/revisions` and the revision routes. */
export interface MapResponse {
  map: MapDetail;
  storage: StorageView;
}

/** `GET /v1/storage`. */
export interface StorageResponse {
  storage: StorageView;
}

/** The fields beside the file in a multipart upload (`POST /v1/maps`, `POST /v1/maps/:id/revisions`). */
export interface MapUploadFields {
  /** The map's name in the list; the scenario name or the file name when absent. Creating only. */
  name?: string;
  /** Creating only. */
  description?: string;
  /** This revision's note. */
  note?: string;
  /** `MapMeta` as JSON. */
  meta?: string;
}

/** `PATCH /v1/maps/:id`. */
export interface MapPatch {
  name?: string;
  description?: string;
}

/** `PATCH /v1/maps/:id/revisions/:number`. */
export interface RevisionPatch {
  note?: string;
}

export interface LedgerEntry {
  at: string;
  kind: "trial" | "weekly" | "charge" | "purchase" | "adjust";
  /** Signed dollars. */
  usd: number;
  note: string;
}

export interface TrialRequest {
  /** A random id the browser made once and keeps; one trial per id. */
  deviceId: string;
}

export interface TrialResponse {
  session: string;
  account: AccountView;
}

export interface AuthStartRequest {
  provider: string;
  /** The page origin the callback posts the session back to (`window.opener`). */
  returnOrigin: string;
}

export interface AuthStartResponse {
  /** Open this in a popup. */
  url: string;
}

/** What the callback page posts to the opener. */
export interface AuthMessage {
  type: "scmjs-ai-auth";
  session: string;
  account: AccountView;
}

export interface AccountResponse {
  account: AccountView;
  /** Newest first. */
  ledger: LedgerEntry[];
}

export interface CheckoutRequest {
  pack: string;
}

export interface CheckoutResponse {
  /** The payment page, for a new tab. */
  url: string;
}

/** The account-related part of `GET /v1/info`; the rest of the answer is the AI plugin's business. */
export interface InfoResponse {
  version: string;
  name: string;
  motd?: string;
  /** Present when the server runs accounts (trial sessions, sign-in, balances). */
  accounts?: AccountsInfo;
  caller: {
    kind: "anonymous" | "token" | "byok" | "user";
    name?: string;
    remaining: Allowance;
    account?: AccountView;
  };
}
