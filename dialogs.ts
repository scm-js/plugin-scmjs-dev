/**
 * The Account dialog: who you are on scmjs.dev, what is left, what you have stored, the
 * ledger, and the buttons — sign in, top up, manage on the site, sign out — plus the
 * plugin's ticks under a Settings fold: the AI features and the status-bar cell. One
 * dialog for the guest and the account: the head and the buttons change with the
 * state, everything else stays where it is.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { SERVER_QUERY, SITE_URL } from "./account";
import { describeError, formatBytes, formatUsd, signInGives } from "./client";
import { append, clear, h, shortDay, styled, type Ctx } from "./ui";

/** A used-of-cap bar with its caption. */
export function storageBar(used: number, cap: number): HTMLElement {
  const share = cap > 0 ? Math.min(1, used / cap) : 0;
  const bar = h("div", { className: `sd-bar${share >= 0.95 ? " sd-full" : ""}` }, h("i", { style: `width:${(share * 100).toFixed(1)}%` }));
  const caption = h("div", { className: "sd-hint" }, `${formatBytes(used)} of ${formatBytes(cap)} used`);
  return h("div", null, bar, caption);
}

export function openAccountDialog(ctx: Ctx): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  return api.ui.dialog({
    title: "scmjs.dev Account",
    size: "md",
    mount(body, dialog) {
      const root = styled(body);
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);

      const head = h("div", null);
      const buttons = h("div", { className: "sd-btns" });
      const storageBox = h("div", null);
      const ledgerBox = h("div", null);

      const render = () => {
        const s = account.state();
        const v = s.account;
        clear(head); clear(buttons); clear(storageBox); clear(ledgerBox);
        const rows: [string, Node | string][] = [];
        if (s.kind === "guest") {
          rows.push(["Status", h("span", { className: "sd-big" }, "Not signed in")]);
          if (s.offers) rows.push(["", h("span", { className: "sd-hint" }, `${s.offers.trial ? `A free trial of ${formatUsd(s.offers.trialUsd)} needs no sign-in. ` : ""}Signing in ${signInGives(s.offers)}, and room to keep maps on your account.`)]);
        } else if (s.kind === "trial") {
          rows.push(["Status", h("span", { className: "sd-big" }, "Free trial")]);
          if (v) rows.push(["Balance", `${formatUsd(v.balanceUsd)} left`]);
          rows.push(["", h("span", { className: "sd-hint" }, "A trial is one browser, once. Sign in to keep what is left, get the sign-in credit, and store maps.")]);
        } else {
          rows.push(["Signed in as", h("span", { className: "sd-big" }, v?.name ?? "you")]);
          if (v) {
            rows.push(["Role", `${v.role}${v.unlimited ? " · no balance is kept" : ""}`]);
            if (!v.unlimited) {
              rows.push(["Balance", `${formatUsd(v.balanceUsd)}${v.creditUsd > 0 && v.weeklyUsd > 0 ? ` (${formatUsd(v.weeklyUsd)} weekly + ${formatUsd(v.creditUsd)} credit)` : ""}`]);
              if (v.resetsAt) rows.push(["Refills", `${shortDay(v.resetsAt)}, to ${formatUsd(Math.max(v.weeklyUsd, s.offers?.weeklyUsd ?? 0))}`]);
            }
            if (v.providers.length) rows.push(["Sign-in", v.providers.join(", ")]);
          }
        }
        append(head, [h("div", { className: "sd-head" }, ...rows.flatMap(([k, val]) => [h("span", { className: "sd-k" }, k), h("span", { className: "sd-v" }, val)]))]);

        // Buttons for the state.
        if (s.kind !== "account") {
          const providers = s.offers?.providers ?? [];
          if (!providers.length) buttons.append(h("span", { className: "sd-hint" }, s.offers ? "This server offers no sign-in." : "Waiting for the server…"));
          for (const p of providers) {
            buttons.append(w.button(`Sign in with ${p.name}`, { primary: true, onClick: async () => {
              say(`Waiting for ${p.name}…`);
              try {
                const view = await account.signIn(p.id);
                say(`Signed in as ${view.name ?? "you"}.`, "ok");
              } catch (err) { say(describeError(err), "error"); }
            } }));
          }
          if (s.kind === "guest" && s.offers?.trial) {
            buttons.append(w.button("Start the free trial", { onClick: async () => {
              try { await account.ensureSession(); say(`Trial started: ${formatUsd(account.current()?.balanceUsd ?? 0)} to spend.`, "ok"); }
              catch (err) { say(describeError(err), "error"); }
            } }));
          }
        } else {
          const packs = s.offers?.packs ?? [];
          if (packs.length && !v?.unlimited) {
            const packSelect = w.select(packs.map((p) => ({ value: p.id, label: `${formatUsd(p.priceUsd)} for ${formatUsd(p.creditUsd)} of credit` })), { value: packs[0]!.id });
            buttons.append(packSelect, w.button("Top up…", { onClick: async () => {
              try { await account.topUp(packSelect.value); say("The payment page opened in a new tab. The credit lands once it is paid."); }
              catch (err) { say(describeError(err), "error"); }
            } }));
          }
          buttons.append(w.button("Manage on scmjs.dev", { onClick: () => window.open(account.accountPageUrl(), "_blank", "noopener") }));
          buttons.append(w.button("My Maps…", { onClick: () => { dialog.close(); ctx.openMaps(); } }));
          buttons.append(w.button("Sign out", { onClick: async () => { await account.signOut(); say("Signed out."); } }));
        }

        // Storage.
        if (s.kind === "account") {
          if (s.storage) storageBox.append(w.group("Map storage", storageBar(s.storage.usedBytes, s.storage.capBytes), h("div", { className: "sd-hint" }, `${s.storage.maps} map${s.storage.maps === 1 ? "" : "s"}, ${s.storage.revisions} revision${s.storage.revisions === 1 ? "" : "s"}. Account ▸ My Maps… lists them; Account ▸ Save to scmjs.dev… adds one.`)));
          else if (s.offers && !s.offers.maps) storageBox.append(w.group("Map storage", h("div", { className: "sd-hint" }, "This server keeps no maps.")));
        }

        // Ledger.
        const ledger = account.ledger();
        if (s.kind === "account" && ledger.length) {
          const table = h("table", { className: "sd-ledger" },
            h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "What"), h("th", { style: "text-align:right" }, "Amount"), h("th", null, "Note"))),
            h("tbody", null, ...ledger.map((e) => h("tr", null,
              h("td", null, shortDay(e.at)),
              h("td", null, e.kind),
              h("td", { className: "sd-num" }, `${e.usd < 0 ? "−" : "+"}${formatUsd(Math.abs(e.usd))}`),
              h("td", { className: "sd-note" }, e.note),
            ))),
          );
          ledgerBox.append(w.group("Recent activity", h("div", { className: "sd-scroll" }, table)));
        }
      };

      /* Settings. */
      const settings = account.store.get();
      const aiBox = w.checkbox("Use the AI features (Tools ▸ AI, the assistant, the AI buttons in the editor's dialogs)", { value: settings.ai, onChange: (v) => { account.store.set({ ai: v }); } });
      const statusBox = w.checkbox("Show my status in the status bar", { value: settings.statusItem, onChange: (v) => { account.store.set({ statusItem: v }); } });
      const settingsFold = h("details", null,
        h("summary", null, "Settings"),
        h("div", { style: "padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 8px" },
          aiBox,
          h("div", { className: "sd-hint" }, "Off leaves your account and the maps stored on it; Tools ▸ AI ▸ Options… has the quality and the assistant's settings."),
          statusBox,
          account.overridden() ? h("div", { className: "sd-hint sd-bad" }, `Talking to ${account.serverUrl()} — a development server named by ?${SERVER_QUERY}= on the editor's address. Open the editor with ?${SERVER_QUERY}= (empty) to go back to scmjs.dev.`) : null,
        ),
      );

      root.append(head, buttons, storageBox, ledgerBox, settingsFold, status,
        h("div", { className: "sd-hint" }, `scmjs.dev keeps your provider id, display name, a ledger of what your calls cost, and the maps you store — nothing else, never a prompt or a card. Delete all of it from the account page at ${SITE_URL}.`));

      render();
      const off = account.onChange(render);
      // Fresh numbers every time the dialog opens; a session that has ended is dropped by this.
      void (async () => {
        try {
          if (!account.offers()) await account.connect();
          if (account.session()) await account.refresh();
        } catch (err) { say(describeError(err), "error"); }
      })();
      return () => { off(); };
    },
    buttons: [{ label: "Close", primary: true }],
  });
}
