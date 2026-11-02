# scmjs.dev plugin

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. The editor ships with it, turned on. It connects the editor to your
[scmjs.dev](https://scmjs.dev) account. With it you can:

- sign in and see your balance
- keep maps on your account, with numbered revisions and notes
- share the open map so other people can edit it with you at the same time
- use the AI tools, on your own Anthropic API key

The AI tools can build a whole scenario from a sentence, lay out a map from a description,
write and explain triggers, and review a map. An assistant panel beside the map can read
and edit everything in it.

The plugin talks to scmjs.dev and nothing else. It sends nothing until you press a button.
With no stored session it makes no request at startup. Every menu item that uses the
network carries the plugin's mark.

## Install

It is on from the start. If it has been turned off, open **Plugins ▸ Manage Plugins…** and
tick it.

In an editor that does not list it, open **Plugins ▸ Browse Plugins…** and press
**Install** on scmjs.dev. Or paste this into Manage Plugins and press **Add**:

```
https://github.com/scm-js/plugin-scmjs-dev
```

To pin a version, add a ref: `github:scm-js/plugin-scmjs-dev@v1.39.0`.

## Turning on the AI

The AI tools run on your own Anthropic API key. You do not need a scmjs.dev account for
them.

1. Make a key at [console.anthropic.com](https://console.anthropic.com).
2. Open **Edit ▸ Preferences ▸ Plugins ▸ scmjs.dev** (or **Add your key…** in the Account
   dialog), paste the key under *Your Anthropic key* and press **Check and use**.
3. The key is checked with Anthropic first, which costs nothing. When it passes, the
   **Tools ▸ AI** menu, the assistant and the AI buttons appear.

If the key field is missing, open the Account dialog once. The plugin shows the field only
after it has heard from the server.

Anthropic bills each request to you. The key stays in this browser: scmjs.dev passes it on
with each request and keeps no copy. **Forget the key** on the same page removes it, and
the AI tools with it. Aftermath's replay casts are not available on your own key.

An account whose role the server pays for (an admin on scmjs.dev) gets the AI without a
key, on its balance. The free trial and the sign-in credit work the same way, on a server
that offers them. The account, map storage and shared maps are the same for everybody.

## The account

The plugin adds an **Account** menu before Help:

- **Sign in to scmjs.dev…**
- **Account…**
- **My Maps…**
- **Save to scmjs.dev…**
- **Copy Link to This Map…**
- **Open a Map Link…**
- **Share this Map…** and **Join a Shared Map…** (see below)
- **Sign out**

The File menu also gets **Open from scmjs.dev…** (after Open Recent) and **Save to
scmjs.dev…** (after Save Copy As…).

A cell in the status bar reads "Sign in to scmjs.dev" until you do, then shows your name
and balance. Click it to open the Account dialog. To hide it, untick *Show my status in
the status bar* in the dialog's settings.

**Account…** opens the Account dialog. As a guest it has a sign-in button per provider
and the free trial. Signed in, it shows your balance and when it refills, the storage you
have used, recent activity and your shared maps. From there you can top up, manage the
account on scmjs.dev (link another provider, or delete everything) and sign out. The
editor's guide has more: [Your scmjs.dev account](https://docs.scmjs.dev/guide/your-scmjsdev-account/).

### My Maps

My Maps lists the maps on your account, newest change first, with a search box. Up and
Down move through the list and Enter opens the picked map.

Beside the list are the picked map's picture, details and revisions. You can:

- open or download the newest revision, or any other
- add or edit a revision's note
- rename the map
- delete a revision, or the whole map (a map always keeps its last revision)
- manage the map's copy links (see below)

Maps need a signed-in account; a trial cannot store them. The server sets how much you
can keep (250 MB on scmjs.dev, more for some roles). The Account dialog shows what is
used.

### Saving to scmjs.dev

**Save to scmjs.dev…** stores the open map as a new map, or as the next revision of one
you pick. The map it was opened from, or last saved to, is picked for you. Add a note and,
if you like, a picture for the list.

The file is what File ▸ Save would write, with the save options you last used. Saving the
same bytes again uses no storage, so a new note on its own is free.

### Copy links

A copy link opens a copy of a stored map for anyone who has it, signed in or not. The
*Open a Copy* dialog shows the map and opens it as a new file. File ▸ Save then asks where
to keep it.

- **Copy Link to This Map…** saves the open map and makes the link in one step. The link
  stays on that revision unless you let it follow later saves.
- **Open a Map Link…** takes a pasted link. Use it in the desktop editor.
- In My Maps, under *Links*, you can see how often each link was opened, remove a link,
  or make a new one.

Deleting a revision or a map removes its links too.

## Editing a map together

**Account ▸ Share this Map…** (signed in) copies the open map to a room on scmjs.dev and
gives you a link. The Share dialog shows:

- the link, with a Copy button
- who is in the map, each in a player colour, with the dialog they have open
- for the person who shared it: **Remove** beside each person, **New link** (the old link
  stops working, and nobody is sent out) and **Stop sharing** (ends it for everyone)

To join, open the link in a browser: the editor starts with the Join dialog up. In the
desktop editor, paste it into **Account ▸ Join a Shared Map…**. The dialog says whose map
it is and how many people are in it. Type a name and the map opens in a new tab.

While a map is shared, everyone's changes reach everyone as they are made. That covers
terrain, doodads, units, sprites, locations, fog, the settings and trigger dialogs,
strings and sounds. A resize or tileset change is sent as the whole map. Each person's
pointer and view edge are drawn over the map (View ▸ *People on the shared map* hides
them), and a status-bar cell says who is in.

How conflicts are handled:

- Other people's changes wait while you hold the mouse on the map or have a map dialog
  open.
- When two people change the same tile, the later change wins.
- A change to a unit someone else deleted is dropped.
- Ctrl+Z undoes only your own changes.

The server orders and relays the changes. It never opens the map.

If the connection drops, the editor keeps your changes and reconnects on its own for up to
two minutes. If the map has moved on too far to catch up, the shared map opens again in a
new tab and your copy stays open beside it.

### Chat

While the shared map is in front, a **Chat** button in its bottom-right corner opens a
small chat window. A message that arrives while the window is closed shows as a notice and
a count on the button. People who join later see what was said before. The server keeps
the last 100 messages in memory and drops them when the room ends.

### How long it stays open

*Keep it open* in the Share dialog sets how long the room lasts:

- **Until everyone leaves.** The room lives in the server's memory. It ends when the
  person who shared it stops, half an hour after the last person leaves, or when the
  server restarts. Everyone keeps the map and can save it.
- **For a day**, **For a week**, **For a month** or **Until I end it**. The map is saved
  to My Maps and stays open at its link between sessions and across server restarts.
  Each time everyone has left, it saves a revision. It ends that long after its last
  edit.

The Account dialog lists your kept maps, with Join, Copy link, New link, how long, and End
sharing. My Maps marks them and can put an older revision back into one. Up to eight
people can be in a map, and an account can have five shared maps.

### Embedding

**Embed…** (on links in My Maps, on kept maps, and in the Share dialog) gives a picture of
the map that links to it, as Markdown, BBCode or HTML. A kept map's embed opens a copy by
default. It can open the shared map itself instead, in which case anyone who sees the
picture can join and edit.

The editor's guide covers all of this in more detail:
[Editing a map together](https://docs.scmjs.dev/guide/editing-a-map-together/).

## The AI

Everything is under **Tools ▸ AI**. To hide the menu, the assistant and the AI buttons,
untick *Use the AI features* in the Account dialog's settings or at the top of
**Tools ▸ AI ▸ Options…**. The account and the maps stay.

Every change the AI makes to the map is one undo step labelled "AI: …". The editor's
guide has a section on [the AI](https://docs.scmjs.dev/guide/the-ai/) with pictures.

### Make Scenario…

Builds a whole scenario from a sentence, such as "a madness map", "an RPG about a marine
lost on a Zerg world" or "a two-lane tower defense".

The model first writes a design document: the genre and premise, players and forces, every
trigger system, the layout, the objectives and the briefing. You can edit it before
anything is built, or describe what should change under "Change the design first". A
location parameter may include `{p}` for the player number ("Spawn {p}"); the system is
then built once per player.

The design also says what the map plays on: *Every version of StarCraft* (triggers only),
or *StarCraft: Remastered*, where a scripted system may be a TrigScript program. Timers
count trigger cycles, and the rate depends on this choice. The build's notes give each
timer in real seconds.

**Build** then runs step by step: a check that the map has enough free death counters and
switches, then the terrain and named locations, players and forces, each trigger system,
the objectives, briefing and name, and Check Map. Each step is a row that passes or fails
on its own. **Stop the build** ends it and keeps what was built. Only a status of "Built"
is a finished scenario.

A system whose location was not drawn waits. Its row names the location it needs. Draw it,
then press **Build the waiting systems**.

Common layouts (camps around an arena, lanes, a bound's course, a town) and common trigger
systems (waves, shops, lives, teleports, kill-to-cash, leaderboards and more) are built by
the plugin's own code, the same way every time. Anything else is written as a trigger
script through Write Triggers, when the TrigScript plugin is on. Afterwards, review the
result or hand it to the assistant.

### Generate Map…

Describe a map and get a plan back: a coarse grid of terrain types, bases with mineral
lines, ramps, decoration, a name and a description. The dialog shows the plan as a
coloured grid with the designer's notes before anything is painted.

**Apply** paints it onto a new map, or onto the open map when it is the same size. Bases
are laid out the way the Melee Wizard does it. **Refine** sends the plan back with what you
want changed, a picture of the result and anything the editor refused. The revised plan
replaces the old one. Ramps are placed as doodads, so check them against the cliffs.

### Redo Area…

Does the same for one rectangle: the marked area, a right-click on it, or a drag on the
map. The model sees the area and a margin around it, plus a picture, so the edges join.

### Write Triggers…

Turns a description into a [TrigScript](https://github.com/scm-js/plugin-trigscript)
program. The TrigScript plugin must be on (it is by default). The model is given the map's
unit, location and switch names, and its existing triggers, so it does not write them
again. The script is checked here. If that fails, the errors go back for up to two repair
rounds. **Build** installs it the same way TrigScript's own Build does, and the source
stays with the map. It can extend the map's current script or replace every trigger.

### The smaller tools

- **Explain Triggers…** explains what the triggers (or some of them, or the briefing) do
  in play, or answers a question about them.
- **Name and Describe…** offers three name and description pairs. Pick one and it goes
  into Map Properties.
- **Write Briefing…** writes objectives and narration into one mission briefing trigger
  for every player. You can edit the text first.
- **Review Map…** sends a picture of the map with its statistics and Check Map results,
  and shows a critique. Findings that point somewhere have a Go to button.
- **Rewrite Strings…** applies an instruction (translate, fix spelling, shorten, change
  tone) to the strings in use, or only the trigger text, briefing or names. It shows a
  before-and-after table with a tick per row. **Apply** writes the ticked rows back in
  place, so triggers keep pointing at the same strings.

### Assistant

**Assistant** (Ctrl+Shift+A) opens a panel over the map. Options can dock it on the right
instead. Say what you want to know or change. The assistant can read everything in the
map, take screenshots and run Check Map, and it can change nearly anything the editor
can. It has the same tools as Make Scenario, so "add kill to cash" or "make this a
two-lane defense" is one step.

The transcript shows a line per tool call (▸ a read, ✎ a change). While it works, the map
outlines what a call is about to touch in teal and flashes what it changed in gold, and the
view follows the work until you scroll or zoom yourself. Escape stops. Each edit is its own
undo step, and the turn's **Undo** button reverts all of a turn's edits at once.

Right-click on the map and choose *Ask AI about this…* to start a message about the spot,
the marked area or the selection. The assistant stops after the number of tool rounds set
in Options (24 by default) and offers to continue. Each open map has its own conversation.

### Inside the editor's dialogs

- Map Properties gets **Suggest a name**, which fills the name and description fields. OK
  writes them.
- The Trigger Editor, the Text Trigger Editor and Mission Briefing get **Explain**,
  **Write…** and **Ask**.
- The String Editor gets **Rewrite with AI…**.
- Player Settings gets **Set up with AI…**.

Each opens the matching tool, or the assistant with a message started.

### Options

**Tools ▸ AI ▸ Options…** opens the plugin's page in Edit ▸ Preferences. It holds:

- **Quality**: how hard the model works, and so what it costs. *Standard* gives each
  feature the setting it was tuned for. *Quick* is the cheapest and *Thorough* the
  highest.
- **Spending ceilings**: one per assistant message, and one per Make Scenario design or
  build (Write Triggers runs under this one too). At the ceiling the work stops with the
  map as edited so far. The assistant offers to continue, and a build says which step it
  stopped at. The last call can go a little over. 0 turns a ceiling off.
- **Assistant**: rounds of tool calls per message, the picture tick, whether the view
  follows the work, the dock, and whether the model's reasoning is shown.

Which model answers is up to the service and is not a setting.

## Costs

Every AI dialog shows how long it has been waiting. When the answer is back it shows what
it cost, what the session has cost, and what is left on the account. Roughly:

- a map plan, a trigger script or a review: a few tens of cents
- a name or a translation: a few cents
- an assistant message: $0.10 to $0.30
- a Make Scenario build: $0.50 to $1.00

On your own key these are Anthropic's charges to you, and the balance line says so.

The trial and the sign-in credit are as the Account dialog says. Credit bought on top is
charged at cost, does not expire, and is spent after any weekly allowance. When the
balance is empty the dialog says so and links to the Account dialog.

## What is stored, and where

In this browser (under the plugin in Edit ▸ Preferences ▸ Storage):

- the session
- a random device id that the one free trial is tied to
- the ticks and the AI options
- your Anthropic key, if you gave one
- the name you last joined a shared map under

On the server:

- your provider id and display name
- a ledger of what your calls cost (none for calls on your own key)
- the maps you stored and their links (anyone with a link can download the map behind it)
- while a map is shared, a copy of it and the changes since, in memory

Nothing else is kept: no prompts and no card details. The account page on scmjs.dev
deletes all of it.

## For other plugins

The plugin shares its sign-in as the `scmjs-dev.account` service through the editor's
`api.services`. A plugin of your own that talks to scmjs.dev can use the same session
without asking the user to sign in again.

The contract is [`contract.d.ts`](contract.d.ts). It covers the account state, a change
subscription, the server address, the session and its `Authorization` header,
`ensureSession()`, `signIn()`, `signOut()`, `refresh()`, `openAccount()` and
`noteBalance()`. Add this repository as a dev dependency and import the types with
`import type`:

```ts
import type { ScmjsAccountService } from "@scm-js/plugin-scmjs-dev";

api.services.watch<ScmjsAccountService>("scmjs-dev.account", (account) => {
  if (account) useSessionFrom(account); else askToSignIn();
});
```

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # dist/plugin.js, the bundle the editor loads
```

Where things are:

- `client.ts`: the typed client for the server's routes
- `account.ts`: the session, the settings, and the state every surface reads
- `dialogs.ts`: the Account dialog; `maps.ts`: My Maps and Save to scmjs.dev
- `share/`: shared maps (the room's socket, pointers, links, chat, embeds, the Share and
  Join dialogs)
- `protocol.ts`: the wire shapes, copied from the server's `src/protocol.ts` (keep them
  identical)
- `ai/`: the AI tools; `ai/install.ts` adds the menu, and `ai/dialogs/` has one file per
  menu item
- `tests/`: runs against a fake `fetch` and a fake popup.
  `tests/ums-behaviour.test.ts` runs the toolkit's triggers through the editor's text
  parser and TrigScript's interpreter.

`docs/evaluation.md` is the fixed set of live tasks run against the assistant before and
after a change. `npm run evaluate` drives it in a headless browser.

To use a server on your own machine, open the editor once with
`?scmjs-server=http://localhost:8080`. The address is kept until you open the editor with
`?scmjs-server=` (empty). The Account dialog says when one is in use. There is
deliberately no field for it.

## License

MIT.
