/**
 * The account behind everything: which server, which session, and what the server last
 * said about it. `AccountManager` owns the three ways a session comes about — a free
 * trial the first time something needs one, a sign-in through a provider in a popup, a
 * session already in storage from last time — and every consumer reads the same
 * `AccountState`: the status bar, the Account dialog, the map storage dialogs, and
 * the other plugins through the `scmjs-dev.account` service (`contract.d.ts`), which
 * is a thin face over this class.
 *
 * Settings are the plugin's own `api.storage` (listed in Preferences ▸ Browser storage
 * under the plugin): the server address, the session, the device id the one trial is
 * keyed by, and the two ticks in the Account dialog.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { AccountKind, AccountState, ScmjsAccountService } from "./contract";
import type { AccountsInfo, AccountView, LedgerEntry, StorageView } from "./protocol";
import { formatUsd, ScmjsClient, ScmjsError } from "./client";

export const DEFAULT_SERVER_URL = "https://api.scmjs.dev";
export const SITE_URL = "https://scmjs.dev";

export interface Settings {
  serverUrl: string;
  /** The session the server issued (a trial's or a signed-in account's). */
  session: string;
  /** A random id made once, for the one free trial a browser gets. */
  deviceId: string;
  /** Hold the sign-in out to other plugins as the `scmjs-dev.account` service. */
  share: boolean;
  /** The cell in the status bar. */
  statusItem: boolean;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: DEFAULT_SERVER_URL, session: "", deviceId: "", share: true, statusItem: true };

const KEY = "settings";

function newDeviceId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export interface SettingsStore {
  get(): Settings;
  set(patch: Partial<Settings>): void;
}

export function settingsStore(api: PluginApi): SettingsStore {
  const stored = api.storage.get<Partial<Settings>>(KEY, {});
  let current: Settings = { ...DEFAULT_SETTINGS, ...stored };
  if (!current.serverUrl.trim()) current.serverUrl = DEFAULT_SERVER_URL;
  if (!current.deviceId) current.deviceId = newDeviceId();
  api.storage.set(KEY, current);
  return {
    get: () => current,
    set: (patch) => { current = { ...current, ...patch }; api.storage.set(KEY, current); },
  };
}

/** A store over a plain object, for tests and for a dialog's working copy. */
export function memoryStore(initial: Partial<Settings> = {}): SettingsStore {
  let current: Settings = { ...DEFAULT_SETTINGS, deviceId: "device-test", ...initial };
  return { get: () => current, set: (patch) => { current = { ...current, ...patch }; } };
}

/** What the popup's callback page posts back to the editor. */
export const AUTH_MESSAGE_TYPE = "scmjs-ai-auth";

export interface AccountDeps {
  /** `window.open`, so a test can hand over a fake popup. */
  openPopup?: (name: string) => { close(): void; closed: boolean; location: { href: string } } | null;
  /** The editor's origin the callback page must post back to. */
  origin?: () => string;
  /** The message channel the callback page posts on. */
  listen?: (handler: (e: { origin: string; data: unknown }) => void) => () => void;
  signInTimeoutMs?: number;
}

export class AccountManager {
  readonly store: SettingsStore;
  readonly client: ScmjsClient;
  private view: AccountView | null = null;
  private ledgerRows: LedgerEntry[] = [];
  private info: AccountsInfo | null = null;
  private serverName = "";
  private readonly listeners = new Set<(state: AccountState) => void>();
  private pending: Promise<void> | null = null;
  private readonly deps: AccountDeps;

  constructor(store: SettingsStore, client: ScmjsClient, deps: AccountDeps = {}) {
    this.store = store;
    this.client = client;
    this.deps = deps;
  }

  /* ── Reading ──────────────────────────────────────────── */

  kind(): AccountKind {
    if (!this.store.get().session) return "guest";
    return this.view?.kind === "account" ? "account" : "trial";
  }

  current(): AccountView | null { return this.view; }
  offers(): AccountsInfo | null { return this.info; }
  ledger(): LedgerEntry[] { return this.ledgerRows; }
  server(): string { return this.serverName; }
  storage(): StorageView | null { return this.view?.storage ?? null; }
  serverUrl(): string { return this.client.base(); }
  session(): string { return this.store.get().session; }

  state(): AccountState {
    return { kind: this.kind(), account: this.view, storage: this.storage(), offers: this.info };
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed() { const s = this.state(); for (const l of this.listeners) { try { l(s); } catch (err) { console.error("[scmjs.dev] listener failed", err); } } }

  /** One line for the status bar and the dialogs' head. */
  summary(): string {
    const v = this.view;
    switch (this.kind()) {
      case "guest": return "Not signed in";
      case "trial": return v ? `Free trial · ${formatUsd(v.balanceUsd)} left` : "Free trial";
      default: return v ? `${v.name ?? "Signed in"} · ${v.unlimited ? "no balance is kept" : formatUsd(v.balanceUsd)}` : "Signed in";
    }
  }

  /* ── The server ───────────────────────────────────────── */

  /**
   * Ask the server what it offers and what it thinks of the session. Run at activation
   * and whenever the dialog opens; a session the server no longer knows is dropped.
   */
  async connect(): Promise<void> {
    const info = await this.client.info();
    this.info = info.accounts ?? null;
    this.serverName = info.name;
    if (info.caller.kind === "user" && info.caller.account) this.view = info.caller.account;
    else if (this.store.get().session && info.caller.kind === "anonymous") {
      // The session was sent and not recognised: it has ended.
      this.store.set({ session: "" });
      this.view = null;
    }
    this.changed();
  }

  /** Re-read the account and the ledger; a session the server no longer knows is dropped. */
  async refresh(): Promise<AccountView | null> {
    if (!this.store.get().session) { this.view = null; this.ledgerRows = []; this.changed(); return null; }
    try {
      const r = await this.client.account();
      this.view = r.account;
      this.ledgerRows = r.ledger;
    } catch (err) {
      if (err instanceof ScmjsError && err.code === "unauthorized") { this.store.set({ session: "" }); this.view = null; this.ledgerRows = []; }
      else throw err;
    }
    this.changed();
    return this.view;
  }

  noteBalance(balanceUsd: number): void {
    if (!this.view) return;
    const cents = (v: number) => Math.round(v * 100) / 100;
    const weekly = Math.max(0, Math.min(this.view.weeklyUsd, balanceUsd));
    this.view = { ...this.view, balanceUsd: cents(balanceUsd), weeklyUsd: cents(weekly), creditUsd: cents(Math.max(0, balanceUsd - weekly)) };
    this.changed();
  }

  noteStorage(storage: StorageView): void {
    if (!this.view) return;
    this.view = { ...this.view, storage };
    this.changed();
  }

  /**
   * Before a call that needs a session: a guest gets the trial. A browser that has had
   * one is told to sign in — as a `budget_exceeded`, which is what consumers show with
   * a way to the sign-in.
   */
  ensureSession(): Promise<void> {
    if (this.store.get().session) return Promise.resolve();
    if (!this.pending) this.pending = this.startTrial().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async startTrial(): Promise<void> {
    const s = this.store.get();
    try {
      const r = await this.client.trial(s.deviceId);
      this.store.set({ session: r.session });
      this.view = r.account;
      this.changed();
    } catch (err) {
      if (err instanceof ScmjsError && (err.code === "forbidden" || err.code === "rate_limited")) {
        throw new ScmjsError("budget_exceeded", `${err.message} Sign in to scmjs.dev for a weekly allowance.`);
      }
      throw err;
    }
  }

  /**
   * Sign in through a provider: the popup is opened at once (a click is what lets it
   * open) and pointed at the provider once the server has said where; the callback page
   * posts the session back and the popup closes itself. Rejects when the popup is closed
   * first or nothing arrives in five minutes.
   */
  async signIn(provider?: string): Promise<AccountView> {
    const id = provider ?? this.info?.providers[0]?.id;
    if (!id) throw new ScmjsError("forbidden", "this server offers no sign-in.");
    const origin = new URL(this.client.base()).origin;
    const open = this.deps.openPopup ?? ((name) => window.open("", name, "width=540,height=720,popup=yes"));
    const popup = open("scmjs-signin");
    if (!popup) throw new ScmjsError("network", "the browser blocked the sign-in window; allow popups for this site and try again.");
    let url: string;
    try {
      url = (await this.client.authStart(id, (this.deps.origin ?? (() => window.location.origin))())).url;
    } catch (err) {
      popup.close();
      throw err;
    }
    popup.location.href = url;
    const listen = this.deps.listen ?? ((handler) => { const fn = (e: MessageEvent) => handler(e); window.addEventListener("message", fn); return () => window.removeEventListener("message", fn); });
    return new Promise<AccountView>((resolve, reject) => {
      let done = false;
      let stop = () => {};
      const finish = (fn: () => void) => { if (done) return; done = true; stop(); clearInterval(watch); clearTimeout(limit); fn(); };
      stop = listen((e) => {
        if (e.origin !== origin) return;
        const m = e.data as { type?: string; session?: string; account?: AccountView } | null;
        if (!m || m.type !== AUTH_MESSAGE_TYPE || typeof m.session !== "string" || !m.account) return;
        this.store.set({ session: m.session });
        this.view = m.account;
        this.changed();
        finish(() => resolve(m.account!));
        void this.refresh().catch(() => {});
      });
      const watch = setInterval(() => { if (popup.closed) finish(() => reject(new ScmjsError("aborted", "the sign-in window was closed."))); }, 500);
      const limit = setTimeout(() => { finish(() => { try { popup.close(); } catch { /* gone */ } reject(new ScmjsError("network", "the sign-in did not finish in time.")); }); }, this.deps.signInTimeoutMs ?? 5 * 60_000);
    });
  }

  async signOut(): Promise<void> {
    if (this.store.get().session) { try { await this.client.logout(); } catch { /* the session is dropped locally regardless */ } }
    this.store.set({ session: "" });
    this.view = null;
    this.ledgerRows = [];
    this.changed();
  }

  /** The payment page for a pack, in a new tab. */
  async topUp(pack: string): Promise<string> {
    const { url } = await this.client.checkout(pack);
    window.open(url, "_blank", "noopener");
    return url;
  }

  accountPageUrl(): string {
    return this.info?.accountUrl ?? `${this.client.base()}/account`;
  }

  /* ── The service other plugins see ────────────────────── */

  service(openAccount: () => void): ScmjsAccountService {
    return {
      state: () => this.state(),
      onChange: (listener) => this.onChange(listener),
      serverUrl: () => this.serverUrl(),
      session: () => this.session(),
      headers: () => this.client.headers(),
      ensureSession: () => this.ensureSession(),
      signIn: (provider) => this.signIn(provider),
      signOut: () => this.signOut(),
      refresh: () => this.refresh(),
      openAccount,
      noteBalance: (usd) => this.noteBalance(usd),
    };
  }
}
