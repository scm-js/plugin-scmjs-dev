# scmjs.dev plugin

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor, and one the editor ships with. It puts your
[scmjs.dev](https://scmjs.dev) account in the editor — sign in from the **Account** menu
or the status bar, see your balance, keep maps on your account with numbered revisions
and notes — and the AI that comes with the account: a whole scenario from a sentence, a
map laid out from a description, an area redone, triggers written and explained, a name
and a briefing, a review, string rewrites, and an assistant beside the map that reads and
edits everything in it with you.

There is nothing to set up. The first AI request starts a free trial with no sign-in;
when it is spent you sign in (Discord to start with) for the sign-in credit, and buy
credit at cost when that runs out. The plugin holds no model key and has no field for a
server, a token or a key: it talks to scmjs.dev and to nothing else, and it sends nothing
until you press a button — with no session stored it makes no request at startup. Every
menu item that reaches the network carries the plugin's mark.

## Install

It is on from the start. If it has been turned off: **Plugins ▸ Manage Plugins…** and
tick it. From another editor, **Plugins ▸ Browse Plugins…** and press Install on
scmjs.dev, or paste

```
https://github.com/scm-js/plugin-scmjs-dev
```

into Manage Plugins and press **Add**. To pin a version, add a ref:
`github:scm-js/plugin-scmjs-dev@v1.0.0`.

## The account

- **An Account menu**, before Help: *Sign in to scmjs.dev…*, *Account…*, *My Maps…*,
  *Save to scmjs.dev…*, *Sign out*. The two map items are under File as well, next to
  Open Recent and Save Copy As.
- **A cell in the status bar**: "Sign in to scmjs.dev" until you do, then your name and
  balance. Click it for the Account dialog. A tick in the dialog's settings takes it
  away.
- **The Account dialog.** As a guest: what signing in gives you, a button per provider,
  and the free trial. Signed in: your name and role, the balance with any weekly
  allowance and the credit told apart and the day it refills, the map storage used
  against your cap, the recent activity from the server's ledger, and buttons to top up,
  manage the account on scmjs.dev (link another provider, delete everything), open My
  Maps, and sign out. Under *Settings*: the AI tick and the status-bar tick.
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

## The AI

Everything is under **Tools ▸ AI**, and *Use the AI features* — in the Account dialog's
settings and at the top of Tools ▸ AI ▸ Options… — takes the whole menu, the assistant
and the AI buttons in the editor's dialogs away again, leaving the account and the maps.
Every change to the map is one undo step with an "AI: …" label, except the ones that
write the tables the settings dialogs write (properties, strings, triggers, players, unit
settings …), which say so and are not in the undo model, as in StarEdit.

**Make Scenario…** is the whole thing from a sentence: "a madness map", "an RPG about a
marine lost on a Zerg world", "a two-lane tower defense". The model writes a *design
document* first — the genre and premise, the players and forces, every trigger system the
map runs on, the layout brief, the objectives and the briefing — with the genre's guide
and the toolkit's catalogue in front of it; the dialog shows the document and lets you edit
it (rename, drop a system, change a parameter, rewrite the brief), or say what should be
different under "Change the design first". A location parameter may carry `{p}` for the
player number ("Spawn {p}", "Armory {p}"): the system is then built once per player, so
one spawn or shop entry serves everyone. Build folds the design away and goes step by
step, each step a row that passes or fails on its own: the map, the terrain and the named
locations (the long step, with its clock and the model's reasoning under the rows),
players and forces, every system, the objectives and briefing, the name, Check Map. The
terrain comes as *shapes* — plateaus, lanes, rivers, arenas in map tiles — which the
plugin compiles and the editor's brush draws, so a lane is continuous and a plateau that
asks for a ramp gets one where the editor's placement check says the ramp fits (ramps go
down south-west or south-east, as the game's do); bridges the same way, over a channel
painted for them, on the tilesets whose bridges fit the brush's shores. Systems the *toolkit* knows — hyper triggers,
spawn cycles, kill-to-cash, income, waves, lives, shops, heal spots, respawn, teleports,
kill zones, leaderboards, countdowns, last standing, alliances, auto-attack, rescue by
touch — are built by code from their parameters, instantly and the same way every time;
anything else is written as a trigger script through Write Triggers' compile loop when the
Trigger Script plugin is on. Afterwards, Review it or hand it to the assistant.

**Generate Map…** describes a map and gets a plan back: a coarse grid of terrain types,
the bases with their mineral lines, ramps, decoration, a name and a description. The
dialog shows the plan as a coloured grid with the designer's notes before anything is
painted. Apply renders it — the isometric brush per lattice diamond, lowest ground
first, so cliffs and shores draw themselves; bases laid out the way the Melee Wizard lays
them; doodads scattered on the cells the plan names — onto a new map, made first so the
model can be told which terrains the tileset has, or onto the open map when it is the
same size. Afterwards, Refine sends the plan back with what you want changed, a picture
of the result and everything the editor refused or found wrong, and the revised plan
replaces the applied one. Ramps come as doodads chosen by footprint, since the tilesets
give them no direction of their own; check them against the cliffs.

**Redo Area…** does the same for one rectangle: the marked area, a right-click on it, or
a drag on the map. The model sees the area and a margin round it as it is now, plus a
picture, so the edges join.

**Write Triggers…** turns a description into a trigger script in the language of the
[Trigger Script](https://github.com/scm-js/plugin-trigger-script) plugin, which has to be
switched on (Plugins ▸ Browse Plugins…). The model is given this map's declarations, so it
can name every unit, location and switch as the map calls them. The script is compiled
here; if it does not compile, the compiler's complaints go back for up to two repair
rounds. Build installs it exactly as the Script Editor's Build does, and the source stays
with the map. It can extend the map's current script or replace every trigger with the
script.

**Explain Triggers…** walks through what the triggers (or a range of them, or the
briefing) do in play, or answers a question about them. The text streams as it is
written.

**Name and Describe…** offers three name and description pairs from the map's facts;
pick one and it goes into Map Properties.

**Write Briefing…** writes objectives and narration and puts them into one mission
briefing trigger for every player: the objectives as a Mission Objectives action, each
line as a Text Message. Edit the text before writing it.

**Review Map…** sends a picture of the map with its statistics and what Check Map says,
and shows a critique with a list of findings; the ones that point somewhere have a Go to
button.

**Rewrite Strings…** takes an instruction — translate, fix spelling, shorten, retone — over
the strings in use, or only the trigger text, the briefing, or the names, and shows a
before-and-after table with a tick per row. Apply writes the ticked rows back in place,
never renumbering, so triggers keep pointing at the same strings.

**Assistant** (Ctrl+Shift+A) is a panel floating over the map (Options can put it in the
right dock instead, under the Properties panel). Say what you want to know or change; the
model reads the map through tools and changes it through others. While it works a strip
at the top says what is happening — waiting, thinking, writing, working on the map — with
the seconds and the cost; its words stream in as they arrive; a tool call appears the
moment the model commits to it and fills in when it runs; the map outlines what the call
is about to touch in teal and flashes what it changed in gold; the status bar's AI cell
shows the same state, so the panel can be closed while it works; Escape stops. The chips
above the input follow the layer and the selection. It can read everything: the map's
facts and statistics, units (with every record field), doodads, sprites, locations,
strings, switches, sounds, the triggers as text, the trigger script and its declarations,
the settings of any unit type, upgrade or technology, the fog, a coarse terrain grid or
one tile, Check Map, a screenshot of any area, and what you have selected. It can change
nearly everything the editor can: paint terrain, place / move / remove / edit units,
doodads and sprites, add / edit / remove locations, fog, the map's name and description,
triggers (append, replace, remove, reorder, preserve), strings, switch names, the script
(compile and build), player types / races / colours / forces, unit, upgrade and
technology settings, the sound table, the map revision, and the map's size. It reads the
same genre guides Make Scenario uses and builds the same toolkit systems, so "add kill to
cash" is one call, not a page of hand-written triggers. Every tool call shows as a row in
the transcript with its result on hover, screenshots inline; each edit is its own undo
step, and a settings change is a transaction outside undo, as in StarEdit, marked so in
the row. After a turn that changed the map the panel says what changed and offers to
undo that turn's edits in one press.

With every message the model gets the map's current state — counts, locations, what you
have selected or marked, where the view is, the top of the undo stack — and a reference in
three parts that the server keeps in its prompt cache: what every map shares (the editor's
conventions, the unit table, the trigger vocabulary, the text format and the script
language), the tileset's terrains and doodad categories, and this map's own names,
players and description. The first two are the same for everyone, so they are cached once
for the whole server; only the last is rewritten when the map changes, and the second
message of a chat costs little more than the words you typed. The long tables — unit
stats and weapons, every doodad, every trigger argument and its values — are behind a
tool the model reads when a task needs them. Right-click on the map and choose
*Ask AI about this…* to start a message about the spot, the marked area or the selection.
The picture tick sends a screenshot of the visible area with the message. Each message also
carries an id for the chat and its turn number, so the server's log can tell one chat's
requests from another's; Clear starts a new id. It stops after the rounds of tool calls
the Options allow (24 by default) and offers to continue.

**Inside the editor's own dialogs.** Map Properties gets *Suggest a name*, which fills the
name and description fields from what is on the map (OK writes them, as always). The
Trigger Editor, the Text Trigger Editor and Mission Briefing get *Explain*, *Write…* and
*Ask*; the String Editor *Rewrite with AI…*; Player Settings *Set up with AI…*. They open
the matching item, or the assistant with a message started.

**Options** (Tools ▸ AI ▸ Options…) is short on purpose. *Quality* is how hard the model
works on a request, and so what it costs: *Standard* gives each feature the setting it was
tuned for, *Quick* the cheapest one, *Thorough* the highest. Under *Assistant*: the rounds
of tool calls per message, the picture tick, the dock, and whether the model's reasoning
summary is shown while it works. Which model answers is the service's business and is
never asked.

## Costs

Every AI dialog shows how long it has been waiting, and once the answer is back what it
cost, what the session has cost so far, and what is left on the account. Roughly: a map
plan is a few tens of cents, a trigger script and a review about the same, a name or a
translation a few cents. The trial and the sign-in credit are what the Account dialog
says; credit bought on top is charged at cost, does not expire, and is spent after any
weekly allowance. When the balance is empty the dialog says so and links to the Account
dialog — sign in if you were on the trial, top up or wait for the refill if you were not.

## For other plugins

The plugin holds its sign-in out as the **`scmjs-dev.account` service** through the
editor's `api.services` (the stateful counterpart of `api.commands`), so a plugin of your
own that talks to scmjs.dev can use the same session instead of asking the user to sign
in again. The contract is [`contract.d.ts`](contract.d.ts): the state (`guest` / `trial`
/ `account`, the server's view of the account, the storage line, what the server offers),
a change subscription, the server address, the session and the `Authorization` header
for it, `ensureSession()` (the free trial on first need, or a `budget_exceeded` telling
the user to sign in), `signIn()`, `signOut()`, `refresh()`, `openAccount()`, and
`noteBalance()` for a consumer whose calls carry the balance back. A consumer takes this
repository as a dev dependency and imports the types with `import type`:

```ts
import type { ScmjsAccountService } from "@scm-js/plugin-scmjs-dev";

api.services.watch<ScmjsAccountService>("scmjs-dev.account", (account) => {
  if (account) useSessionFrom(account); else askToSignIn();
});
```

## What is stored, and where

In this browser (Preferences ▸ Browser storage, under the plugin): the session, a random
device id the one free trial is keyed by, the ticks and the AI options. On the server:
your provider id and display name, a ledger of what your calls cost, and the maps you
stored. Nothing else — never a prompt, never a card. The account page on scmjs.dev
deletes all of it.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # dist/plugin.js, the bundle the editor loads
```

The account half: `client.ts` is the typed client for the server's account, map and
recipe routes, `account.ts` the session, the settings and the state every surface reads,
`dialogs.ts` the Account dialog, `maps.ts` the two map dialogs, `protocol.ts` the wire
shapes copied from the server's `src/protocol.ts` (keep them identical). The AI half is
`ai/`: `install.ts` puts the AI contributions in and takes them out; `options.ts` is the
Options dialog; `ui.ts` the runner every AI dialog shares; `facts.ts` and `reference.ts`
what the model is told about the map; `grid.ts` / `plan.ts` / `render.ts` the layout
language and its rendering; `layout.ts` the Melee Wizard's base geometry, vendored;
`tools.ts`, `tools/` and `assistant.ts` the tool-using conversation; `intent.ts` where a
tool call lands on the map; `ums.ts` the toolkit of trigger systems and `guides.ts` the
genre guides; `slots.ts` the buttons inside the editor's own dialogs; `markdown.ts` a
small renderer; `dialogs/` one file per menu item. `tests/` runs it all against a fake
`fetch` and a fake popup.

To run against a server on your own machine, open the editor with
`?scmjs-server=http://localhost:8080` once; the address is kept until the editor is opened
with `?scmjs-server=` (empty). The Account dialog says when one is in use. There is no
field for it anywhere on purpose.

## License

MIT.
