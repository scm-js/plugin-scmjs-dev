# scmjs.dev plugin

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It puts your [scmjs.dev](https://scmjs.dev) account in the editor:
sign in from the **Account** menu or the status bar, see your balance and what you have
spent, keep maps on your account with numbered revisions and notes, and let the AI plugin
use the same sign-in instead of asking for its own. It reaches one server —
`https://api.scmjs.dev`, the same one the AI plugin talks to — and nothing else; every
menu item that does carries the plugin's mark.

## Install

In scmJS: **Plugins ▸ Browse Plugins…** and press Install on scmjs.dev, or **Plugins ▸
Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-scmjs-dev
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-scmjs-dev@v0.1.0`.

## What it adds

- **An Account menu**, before Help: *Sign in to scmjs.dev…*, *Account…*, *My Maps…*,
  *Save to scmjs.dev…*, *Sign out*. The two map items are under File as well, next to
  Open Recent and Save Copy As.
- **A cell in the status bar**: "Sign in to scmjs.dev" until you do, then your name and
  balance. Click it for the Account dialog. The tick in the dialog's settings takes it
  away.
- **The Account dialog.** As a guest: what signing in gives you, a button per provider
  (Discord to start with), and the free trial. Signed in: your name and role, the balance
  with the weekly allowance and purchased credit told apart and the day it refills, the
  map storage used against your cap, the recent activity from the server's ledger, and
  buttons to top up, manage the account on scmjs.dev (link another provider, delete
  everything), open My Maps, and sign out. Under *Settings*: the two ticks below and the
  server address, for anyone running an [ai-server](https://github.com/scm-js/ai-server)
  of their own.
- **My Maps.** The maps on your account, newest change first, each with its picture,
  tileset, size, players and revision count. Pick one for its revisions — number, note,
  file name, size, when — and open any of them in the editor, download it, edit its
  note, rename the map, or delete a revision or the map. A map keeps its last revision;
  delete the map to remove it.
- **Save to scmjs.dev.** The open map as a new map or as the next revision of one you
  pick (the one it was opened from, or last saved to, is picked for you), with a note and
  a picture for the list. The file is what File ▸ Save would write, with the save options
  you last used. Saving the same bytes again costs no storage — only the note is new —
  so a note on its own is free.

Maps are kept on a signed-in account; a trial cannot store them. What an account may
keep is the server's cap (250 MB on scmjs.dev, and a role can have more); the dialog
shows what is used.

## One sign-in for every plugin

The plugin holds its sign-in out to other plugins as the **`scmjs-dev.account`
service** through the editor's `api.services` (the stateful counterpart of
`api.commands`). The [AI plugin](https://github.com/scm-js/plugin-ai) watches for it and,
while it is there, takes its session from here: its own Settings say "Signed in through
the scmjs.dev plugin" and lock the access mode, and its sign-in buttons go. Turn it off
with **Let other plugins use this sign-in** in the Account dialog's settings and the AI
plugin goes back to signing in by itself.

The contract is [`contract.d.ts`](contract.d.ts): the state (`guest` / `trial` /
`account`, the server's view of the account, the storage line, what the server offers), a
change subscription, the server address, the session and the `Authorization` header
for it, `ensureSession()` (the free trial on first need, or a `budget_exceeded` telling
the user to sign in), `signIn()`, `signOut()`, `refresh()`, `openAccount()`, and
`noteBalance()` for a consumer whose calls carry the balance back. A consumer takes this
repository as a dev dependency and imports the types with `import type`:

```ts
import type { ScmjsAccountService } from "@scm-js/plugin-scmjs-dev";

api.services.watch<ScmjsAccountService>("scmjs-dev.account", (account) => {
  if (account) useSessionFrom(account); else useOwnSignIn();
});
```

## What is stored, and where

In this browser (Preferences ▸ Browser storage, under the plugin): the server address,
the session, a random device id the one free trial is keyed by, and the two ticks. On
the server: your provider id and display name, a ledger of what your calls cost, and the
maps you stored. Nothing else — never a prompt, never a card. The account page on
scmjs.dev deletes all of it.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # dist/plugin.js, the bundle the editor loads
```

`client.ts` is the typed client for the server's account and map routes, `account.ts`
the session and the state every surface reads, `dialogs.ts` the Account dialog,
`maps.ts` the two map dialogs, `protocol.ts` the wire shapes copied from the server's
`src/protocol.ts` (keep them identical). `tests/` runs the client and the account
manager against a fake `fetch` and a fake popup.

## License

MIT.
