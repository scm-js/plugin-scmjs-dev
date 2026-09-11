/**
 * The evaluation task set, one entry per task in `docs/evaluation.md`, in the form
 * `scripts/evaluate.mjs` runs. The prompts here are the prompts there; change both.
 *
 * `kind` is how the task is driven: `assistant` types the prompt into the AI Assistant,
 * `scenario` runs Make Scenario… (Design, then Build), `triggers` runs Write Triggers…
 * (Write, then Build). `map` is a file in the maps folder, or absent for a task that
 * starts on a new map. `manual` marks a case the script cannot drive (a tab switch, a
 * hand edit between turns); it is listed and skipped. `maxRounds` lowers the tool-round
 * limit for one task, `continues` how many times Continue is pressed at that limit,
 * `stopOn: "tools"` presses Stop inside the first tool batch, `refuseAfterSteps: n`
 * refuses the next request to the server once n tool steps have completed.
 */

export const MAPS = {
  bgh: "(8)Big Game Hunters.scm",
  ice: "(2)Ice Floes.scx",
  thaw: "(4)Spring Thaw.scx",
  scenario: "Scenario.scx",
  broken: "Broken.scx",
};

const RIVER = "Run a river from the west edge to the east edge across the lower third of the map with exactly one bridge.";
const PLATEAU = "Raise a high-ground plateau about 12 by 10 tiles near the centre with one ramp down to the south-west. Leave the bases alone.";
const BASE = "Add a fifth expansion in the middle of the map: eight mineral patches and one geyser, laid out like the map's other naturals, on ground a worker can reach from every start.";
const NAMING = "Rename this map to \"Great Game Hunters\" and write a two-sentence description that mentions the eight start positions and the plentiful minerals.";

export const TASKS = [
  /* ── task 0: the working maps (not scored) ── */
  {
    id: "0a", title: "Scenario map", scored: false, kind: "scenario",
    size: [128, 128], tileset: "jungle", players: 4,
    prompt: "A four-player tower defense on two lanes. Waves of Zerg walk from the top corners to the goal at the bottom middle; players share twenty lives and earn minerals for kills.",
    then: { kind: "triggers", prompt: "When a player's Marine reaches the location named Goal, give that player 50 gas and centre the view on the goal." },
    saveAs: MAPS.scenario,
  },
  {
    id: "0b", title: "Broken map", scored: false,
    manual: "Open Big Game Hunters, delete Player 3's Start Location, draw a location named Gate, add a trigger with the condition \"Bring 1 Marine to Gate\", delete Gate, save as Broken.scx in the maps folder.",
  },

  /* ── the core tasks ── */
  { id: "1", title: "Naming", kind: "assistant", map: MAPS.bgh, prompt: NAMING },
  {
    id: "2", title: "String rewrite", kind: "assistant", map: MAPS.scenario,
    prompt: "Rewrite every text message the triggers display so it is in the second person and no longer than sixty characters. Do not change anything else.",
  },
  { id: "3", title: "Resource base", kind: "assistant", map: MAPS.thaw, prompt: BASE },
  { id: "4", title: "Plateau with a ramp", kind: "assistant", map: MAPS.thaw, prompt: PLATEAU },
  { id: "5", title: "River with one crossing", kind: "assistant", map: MAPS.thaw, prompt: RIVER },
  {
    id: "6", title: "Multi-system scenario", kind: "assistant", map: MAPS.scenario,
    prompt: "Add a shop: a Civilian brought to the location called Goal spends 200 minerals and gives its owner a Firebat at their spawn. Also add a countdown of 25 minutes after which the players win if any life is left.",
  },
  {
    id: "7", title: "Extend the script", kind: "triggers", map: MAPS.scenario, extend: true,
    prompt: "When a Marine reaches Goal also display the text \"Goal reached\" to that player.",
  },
  { id: "8", title: "Partially broken map", kind: "assistant", map: MAPS.broken, prompt: "Check this map and fix whatever stops it from being played." },
  {
    id: "9", title: "Read-only explanation", kind: "assistant", map: MAPS.bgh,
    prompt: "Without changing anything, explain how the resources on this map are distributed and which start position you would pick and why.",
  },

  /* ── regression cases ── */
  {
    id: "R1", title: "Spawn and income on one player", kind: "scenario",
    size: [96, 96], tileset: "badlands", players: 1,
    prompt: "A one-player survival map. Zerglings spawn every 20 seconds at the top, the player earns 10 minerals every 5 seconds and loses when the Command Center dies.",
  },
  {
    id: "R2", title: "Long Continue chain", kind: "assistant", map: MAPS.bgh, continues: 6, maxRounds: 6,
    prompt: "For every start position, put a bunker with four marines inside just outside the mineral line, facing the nearest ramp. Do all eight without stopping to ask; after each one, say which is done.",
  },
  { id: "R3", title: "Stop between tool calls", kind: "assistant", map: MAPS.thaw, prompt: PLATEAU, stopOn: "tools", followUp: "What did you manage to do before I stopped you?" },
  { id: "R4", title: "Failure after successful edits", kind: "assistant", map: MAPS.thaw, prompt: BASE, refuseAfterSteps: 1 },
  {
    id: "R5", title: "Paging to the last page", kind: "assistant", map: MAPS.bgh,
    prompt: "How many units are on this map in total, and how many of them belong to Player 8? List Player 8's units.",
  },
  { id: "R6", title: "Change maps during a response", manual: "Run task 1 on Big Game Hunters with a second map open and switch tabs while it runs." },
  { id: "R7", title: "No ramps or bridges on ice", kind: "assistant", map: MAPS.ice, prompt: RIVER },
  { id: "R8", title: "An older turn's Undo", manual: "Run tasks 1 and 4 in one conversation, paint a few tiles by hand, press the Undo button on task 1's row." },
  {
    id: "R9", title: "Required location missing", kind: "scenario",
    size: [128, 128], tileset: "jungle", players: 4,
    prompt: "A capture-the-flag map where each team's flag room is at its base and the score is kept per team.",
  },
  {
    id: "R10", title: "Many screenshots", kind: "assistant", map: MAPS.bgh,
    prompt: "Take a screenshot of each of the eight bases, one at a time, and tell me which has the most room to build.",
  },
];
