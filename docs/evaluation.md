# Evaluating the assistant

A fixed set of tasks to run against the live assistant, with the prompt wording and the
map for each, so that a run this week can be compared with a run after the next change,
and a cold start with a warm one. The server's call log is the evidence: every Anthropic
call is a row, and for the admin role the request and answer bodies are kept.

Judge a task by **cost per successfully completed task**. Validity of the map and
correctness of the change are requirements, not columns to trade against price.

## Before a run

- The server's `config.yaml` has `logging: calls: true`, `diagnostics: true` and
  `promptsFor: ["role:admin"]`, and `AI_SERVER_ADMIN_TOKENS` is set in its `.env`.
  The server's "ready" log line at start-up shows `calls: { prompts: 1, diagnostics:
  true }`; `/health` does not report it.
- Signed in to the editor as the admin account. Tools ▸ AI ▸ Options…: Quality
  *Standard*, tool rounds at the default (24), follow-the-map on. Note anything else.
  Standard sends no effort, so each recipe runs at the server's per-recipe default
  (`RECIPE_DEFAULTS` in the server's config): the design, script and map-plan recipes at
  high, the assistant at its own default. The report's effort column shows what ran.
- The editor's game data is present (Help ▸ Game Data…), the TrigScript plugin is on.
- Fresh copies of the maps below in one folder. Never run a task on a map another task
  has already changed, except where the task says so.
- Run the whole set once **cold**, then once **warm**. Cold means no call with the same
  model, quality and thinking shape in the last hour (the one-hour cache has lapsed; with
  `cache.keepWarm` off, waiting an hour is enough). Warm means the same task started
  within the hour after a previous one on the same map. The report's cache columns tell
  the two apart: a cold first turn shows a one-hour write of the reference layers and the
  tools, a warm one shows reads only.

## Running it with the script

`scripts/evaluate.mjs` drives the whole set in a headless Chromium against the dev server
and the real service, and does everything "Running one task" describes except judging
the change:

```sh
# in scm-js: npm run dev            (its build vendors the pinned plugin)
npm i --no-save playwright && npx playwright install chromium     # once
SCMJS_SESSION=<session> AI_SERVER_ADMIN_TOKEN=<token> \
  node scripts/evaluate.mjs --maps ~/maps --start cold [--only 1,2,R3] [--timeout 20]
node scripts/evaluate.mjs --list
```

The session is the admin account's, copied from the browser (DevTools ▸ Application ▸
Local Storage ▸ the editor's origin ▸ `scmjs.plugin.scmjs-dev.settings` ▸ `session`);
the script signs a fresh browser context in with it for every task, so nothing about the
run touches your own editor state. The maps folder holds the five maps; task 0a writes
`Scenario.scx` into it, and `Broken.scx` is made by hand (task 0b). For each task the
script drops the map, types the prompt where the task says (the assistant, Make
Scenario…, Write Triggers…), waits for it to finish, reads Check Map, saves the map as
`docs/evaluation/<id>-<start>.scx`, pulls the server's calls since the task started, and
appends the row to `docs/evaluation/results.csv`; `<id>-<start>.json` beside it holds the
transcript, the tool rows, the Check Map findings and the call rows. `change_correct` is
left empty for you to fill after looking at the map. R6 and R8 are listed as manual and
skipped. `scripts/evaluation-tasks.mjs` holds the prompts; the wording there and here is
the same, and a change to one is a change to both.

To check the driving without spending anything, run it against the guide's stand-in
server (`scripts/lib/guide-scmjs-mock.mjs` in scm-js, session `guide-session`); its
answers are canned, so only the mechanics are tested.

## Running one task

1. Open the map. In the AI Assistant press **Clear** so the conversation is new.
2. Paste the prompt exactly as written. Do nothing in the editor while it works unless
   the task says to.
3. When it stops, fill the row: did the model say it was done, did the map change the way
   the prompt asked (look), does Check Map pass, how many "Continue" presses it took.
4. Pull the log. From a checkout of `ai-server`:

   ```sh
   export AI_SERVER_URL=https://api.scmjs.dev AI_SERVER_ADMIN_TOKEN=…
   npm run report -- --since 2h
   ```

   The by-conversation table's newest row is this task; then

   ```sh
   npm run report -- --conversation <id>
   ```

   prints its calls oldest first. `GET /v1/admin/calls?conversation=<id>&prompt=1` with
   the same bearer token returns the kept request and answer bodies for reading tool
   results and the model's reasoning.
5. Save the map under a new name next to the original, so the outcome can be re-opened.

## What to record

One row per task and start (cold or warm). Keep them in `docs/evaluation/results.csv`
with these columns:

```
date, task, start, conversation, done_claimed, change_correct, check_map, rounds, continues,
tool_calls, tool_failures, retries, cost_usd, charged_usd, seconds, cache_write_1h_tokens,
cache_read_tokens, uncached_input_tokens, stop_reason, notes
```

`rounds` is the number of model calls; `tool_failures` is the count of tool results that
came back as failures (the `error` envelope), `retries` how many of those the model called
again with different arguments. Cost columns come from the report; `charged_usd` differs
from `cost_usd` when a failed request's completed calls were charged to the limiter only.

## The maps

| Name in this document | File | Why |
| --- | --- | --- |
| BGH | `(8)Big Game Hunters.scm` | Eight players, many units, long lists: paging, naming, a big base |
| Ice Floes | `(2)Ice Floes.scx` | The ice tileset has no ramps or bridges the brush can place |
| Spring Thaw | `(4)Spring Thaw.scx` | Four players, room for a plateau and a river |
| Scenario | made in task 0 | A Make Scenario map with several systems and a script |
| Broken | made in task 0 | A map with a missing start location and a trigger naming a location that no longer exists |

Task 0 makes the last two and is not scored.

### Task 0: make the working maps

**Scenario.** New map, 128×128, Jungle. Tools ▸ AI ▸ Make Scenario… with:

> A four-player tower defense on two lanes. Waves of Zerg walk from the top corners to
> the goal at the bottom middle; players share twenty lives and earn minerals for kills.

Build with the design as it came. Then Tools ▸ AI ▸ Write Triggers… with:

> When a player's Marine reaches the location named Goal, give that player 50 gas and
> centre the view on the goal.

Build. Save as `Scenario.scx`. Record its cost in the notes of the results file but not
as a task.

**Broken.** Open BGH. In the Units layer delete Player 3's Start Location. In the
Locations layer draw a location named `Gate`, add a trigger for Player 1 whose condition
is "Bring 1 Marine to Gate", then delete the location `Gate` again so the trigger names
a location the map no longer has. Save as `Broken.scx`. Check Map should now report both
faults.

## Core tasks

These are the review's nine task types. Each gives the map, the prompt, what counts as
correct, and what to look for in the log.

### 1. Naming

Map: BGH. Prompt:

> Rename this map to "Great Game Hunters" and write a two-sentence description that
> mentions the eight start positions and the plentiful minerals.

Correct: Scenario ▸ Map Properties shows the new name and a description of two sentences
with both facts. Check Map is under Tools. Expect one or two rounds and no tool failures. The log's first call is
the one-hour write when cold; the map layer is rewritten on the next turn because the
name changed (the reference includes it), so a follow-up in the same conversation should
show a small write.

### 2. String rewrite

Map: Scenario. Prompt:

> Rewrite every text message the triggers display so it is in the second person and no
> longer than sixty characters. Do not change anything else.

Correct: list_strings before and after differ only in the displayed messages; trigger
count unchanged; Check Map passes. Look for: whether the model paged through the strings
(`next` / `offset` in its calls) rather than stopping at the first page, and whether it
touched strings that are not trigger messages (unit names, the briefing).

### 3. A resource base

Map: Spring Thaw. Prompt:

> Add a fifth expansion in the middle of the map: eight mineral patches and one geyser,
> laid out like the map's other naturals, on ground a worker can reach from every start.

Correct: `place_base` or `place_units` used, the patches are on buildable ground, a
`reachable` or `placement_ok` check was made, and every start can walk to it (run
Walkability if in doubt). Look for retries after a `placement_ok` failure.

### 4. A plateau with a ramp

Map: Spring Thaw. Prompt:

> Raise a high-ground plateau about 12 by 10 tiles near the centre with one ramp down to
> the south-west. Leave the bases alone.

Correct: high dirt (or the tileset's high terrain) with proper cliffs, one ramp that the
editor's placement check accepted, no base tiles changed. Look for `paint_shapes` with a
ramp request and whether the ramp fitting was reported back as placed or refused.

### 5. A river with one crossing

Map: Spring Thaw. Prompt:

> Run a river from the west edge to the east edge across the lower third of the map with
> exactly one bridge.

Correct: continuous water, one bridge doodad on a diagonal the river bends onto, walkable
across it. Compare with the same prompt on **Ice Floes**, which must answer that ice has
no bridge and offer a ford or a gap instead of placing nothing silently (regression
case R7 below).

### 6. A multi-system scenario

Map: Scenario. Prompt:

> Add a shop: a Civilian brought to the location called Goal spends 200 minerals and
> gives its owner a Firebat at their spawn. Also add a countdown of 25 minutes after which
> the players win if any life is left.

Correct: two new systems that use death counters and switches not already used by the
map's spawn, income and lives systems (list_switches and the triggers show no overlap),
and they compile without breaking the existing triggers. This is the case the shared
state allocator fix was for; read the call that built each system and check the
`usedDcUnits` / switches it was given.

### 7. Extending an existing script

Map: Scenario. Prompt:

> In the map's script, when a Marine reaches Goal also display the text "Goal reached"
> to that player.

Correct: the existing program is extended rather than replaced, `script_declarations`
was read before writing, and the compile loop needed at most one repair round. Look for
`build_script` or `compile_script` failures and their messages.

### 8. A partially broken map

Map: Broken. Prompt:

> Check this map and fix whatever stops it from being played.

Correct: `validate` was called first, Player 3 got a start location on open ground, and
the trigger naming the deleted location was either given a location or removed with an
explanation. Check Map passes afterwards. Look for the model fixing things Check Map did
not report.

### 9. A read-only explanation

Map: BGH. Prompt:

> Without changing anything, explain how the resources on this map are distributed and
> which start position you would pick and why.

Correct: no tool that writes was called (the transcript shows only reads and possibly a
screenshot), and the answer names actual counts. This is the cheapest task; its cost is
the floor for a turn on this map.

## Regression cases

The cases the slice 1 and 2 fixes were meant to cover. Each is a short scenario; most
are one prompt plus something you do.

### R1. Spawn and income on one player

Map: new 96×96 Badlands, no units. Make Scenario…:

> A one-player survival map. Zerglings spawn every 20 seconds at the top, the player
> earns 10 minerals every 5 seconds and loses when the Command Center dies.

Correct: the spawn cycle and the income system use different death-counter units (list
the triggers; before the fix both used Cave (Unused)). Both run in the simulator
(`simulate_triggers`).

### R2. A long Continue chain

Map: BGH. Prompt:

> For every start position, put a bunker with four marines inside just outside the
> mineral line, facing the nearest ramp. Do them one at a time and tell me after each.

Correct: the assistant reaches the tool-round limit at least once, "Continue" resumes
without losing the brief (the first message), and by the end all eight bunkers exist.
Look at `message_count` and the request size per call: the history should be trimmed
from the tail of tool rounds while the first user message stays.

### R3. Stop between tool calls

Map: Spring Thaw. Same prompt as task 4. Press **Stop** while the tool rows are running.

Correct: the remaining calls in that batch are answered "not run", the panel returns to
idle, the map holds only what completed, and the next prompt in the same conversation
works (the tool results block is complete, so the server does not reject the history).

### R4. Failure after successful edits

Map: Spring Thaw. Prompt as task 3, but disconnect the network (or set the account's
balance to a few cents) after the first tool row succeeds.

Correct: the edits already made stay on the map with their undo labels, the panel shows
the failure, and the report shows the completed calls with `charged: false` on the
account and counted against the limiter.

### R5. Paging to the last page

Map: BGH. Prompt:

> How many units are on this map in total, and how many of them belong to Player 8? List
> Player 8's units.

Correct: the model follows `next` until the last page rather than answering from the
first page (the total must match the editor's Statistics). Count the `list_units` calls
and check each one's `offset`.

### R6. Change maps during a response

Map: BGH. Prompt as task 1. While it is running, switch to another open map tab.

Correct: the response finishes against BGH (the turn is bound to the document id), the
other map is untouched, and the panel says which map the answer belongs to.

### R7. A tileset with no ramps or bridges

Map: Ice Floes. Prompt as task 5.

Correct: the model reports that the tileset has no bridge and proposes an alternative
rather than claiming a bridge was placed. Look for `place_bridge` returning a failure
envelope and the model reading it.

### R8. An older turn's Undo

Map: Spring Thaw. Run task 1, then task 4, then in the Terrain layer paint a few tiles
by hand. Press the Undo button on task 1's row.

Correct: the button is grey once the stack no longer holds that step, and pressing an
active one undoes exactly its step.

### R9. A required location missing in Make Scenario

Map: new 128×128 Jungle. Make Scenario… with:

> A capture-the-flag map where each team's flag room is at its base and the score is
> kept per team.

Correct: if the layout did not draw a location a system needs, that row waits and names
the location; drawing it and pressing "Build the waiting systems" finishes without a box
being placed in the map's centre.

### R10. Many screenshots

Map: BGH. Prompt:

> Take a screenshot of each of the eight bases, one at a time, and tell me which has the
> most room to build.

Correct: the eight pictures fit under the request limit (each is shrunk to WebP under
700 KB and the history under 1.1 MB), no request is refused for size, and the log shows
`image_bytes` per call.

## After a run

Compare with the previous run in `evaluation-results.csv`. The questions the numbers
should answer before the next design change:

- How many rounds does each core task take, and where do the rounds go — reading the map,
  retrying after a failure, or the model narrating?
- What fraction of each turn's input is uncached, and how much of the one-hour write is
  the tool list? That decides whether tool descriptions are trimmed or a tool search is
  added.
- Which tool failures repeat across tasks? Those are the tool contracts to fix.
- Is any task's cost mostly in one or two rounds? Those are the candidates for a cheaper
  model or a lower effort.
- Did any task that claimed to be done leave Check Map failing? Those are the cases for
  the "done means dependencies satisfied" change.
