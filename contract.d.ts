/**
 * The service this plugin holds out to other plugins as `scmjs-dev.account` through
 * `api.services` — one sign-in for every plugin that talks to scmjs.dev, so the AI
 * plugin (and whatever comes next) never asks the user to sign in twice or keeps a
 * session of its own.
 *
 * A consumer imports these types with `import type` (erased before the editor's loader
 * sees the specifier) and reaches the object with
 *
 *     api.services.watch<ScmjsAccountService>("scmjs-dev.account", (account) => { … });
 *
 * The object is withdrawn when the plugin is turned off or when the user unticks
 * "Let other plugins use this sign-in" in its settings; a consumer sees null then and
 * falls back to whatever it did before. `CONTRACT_VERSION` is the `version` the service
 * is provided with; a consumer that needs a newer member checks `ServiceInfo.version`.
 */
import type { AccountsInfo, AccountView, StorageView } from "./protocol";

export declare const CONTRACT_VERSION: 1;

export type AccountKind = "guest" | "trial" | "account";

export interface AccountState {
  /** `guest`: no session in this browser. `trial`: a free-trial session, no sign-in. `account`: signed in. */
  kind: AccountKind;
  /** The server's view of the session; null for a guest, and until the first refresh after a reload. */
  account: AccountView | null;
  /** Map storage used and allowed, when the server keeps maps and the account is signed in. */
  storage: StorageView | null;
  /** What the server offers (providers, trial, packs), once it has been asked. */
  offers: AccountsInfo | null;
}

export interface ScmjsAccountService {
  state(): AccountState;
  /** Called on every change of state: sign-in, sign-out, a refresh, a balance moving. Returns the unsubscribe. */
  onChange(listener: (state: AccountState) => void): () => void;
  /** The server every call goes to, without a trailing slash (`https://api.scmjs.dev` by default). */
  serverUrl(): string;
  /** The bearer session, or an empty string for a guest. */
  session(): string;
  /** `{ Authorization: "Bearer …" }`, or `{}` for a guest — spread into a request's headers. */
  headers(): Record<string, string>;
  /**
   * Make sure there is a session before a call that needs one: a guest gets the free
   * trial (once per browser); a browser that has had one is told to sign in, as an error
   * whose `code` is `"budget_exceeded"` — the wording every consumer already shows.
   */
  ensureSession(): Promise<void>;
  /** Open this plugin's sign-in (the provider popup); resolves with the account, rejects when the window is closed. */
  signIn(provider?: string): Promise<AccountView>;
  signOut(): Promise<void>;
  /** Ask the server again; drops a session it no longer knows. */
  refresh(): Promise<AccountView | null>;
  /** Open the Account dialog. */
  openAccount(): void;
  /**
   * Tell the service the server answered a call with a fresh view of the account (every
   * recipe result carries `remaining.balanceUsd`), so the status bar follows without a
   * request of its own.
   */
  noteBalance(balanceUsd: number): void;
}

/**
 * `scmjs-dev.replays` (version 1): a replay's link, for the replay viewer's Share. The viewer hands over the replay's
 * bytes and name and gets the link back; it never talks to the server itself. Provided while the plugin is on.
 *
 *     api.services.watch<ScmjsReplaysService>("scmjs-dev.replays", (replays) => { … });
 */
export interface ScmjsReplaysService {
  /**
   * Where a replay stands, asked without sending it: nobody signed in (with the ways to sign in), signed in without
   * it on the account, or kept (with its link, if it has one). `unavailable` when the server keeps no replays, or
   * could not be asked (`reason`, a sentence to show).
   */
  status(replay: ReplayFile): Promise<ReplayStatus>;
  /**
   * The replay's link, `https://scmjs.dev/replay/<token>`: signs in first when nobody is (in `provider`'s window,
   * opened at once, so call this from the press), keeps the replay on the account when it does not have it (by its
   * hash: one it has already is never sent again), and makes it a link when it has none. Rejects with the sentence
   * to show as the message, and `code` `"aborted"` when the sign-in window was closed.
   */
  link(replay: ReplayFile, provider?: string): Promise<string>;
  /** Called on a sign-in and a sign-out; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface ReplayFile {
  bytes: Uint8Array;
  fileName: string;
}

export type ReplayStatus =
  | { state: "signed-out"; providers: { id: string; name: string }[] }
  | { state: "not-kept" }
  | { state: "kept"; link: string | null }
  | { state: "unavailable"; reason: string };
