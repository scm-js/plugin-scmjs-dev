/**
 * Genre guides: what a madness map, a defense, an RPG, a bound *is* — how it plays, how
 * its players and forces are set up, which systems it runs on, what goes wrong — written
 * once here rather than rediscovered by the model on every request. They are fetched by
 * the assistant's `guide` tool when a conversation turns to a genre, and the Scenario
 * workflow sends the matching one with the design request; neither puts them in the
 * cached prefix, so a guide costs tokens only when it is read. The system kinds they name
 * are the toolkit's (`ums.ts`), so a guide is also the worked example of the toolkit.
 */

export interface Guide {
  id: string;
  title: string;
  /** Words in a prompt that point at this guide. */
  keywords: string[];
  text: string;
}

const BASICS = `# Scenario basics (UMS)

**Players.** Slots 1–8 are the game's players; slot 12 is neutral (resources, critters, props). A *Human* slot is a person; a *Computer* slot owns what the triggers create for the enemy or the shop; *Rescuable* units join whoever touches them; *Neutral* units belong to nobody. Every human needs a start location. A player who owns nothing when the game starts is defeated on the spot, and a defeated player's triggers never run: a computer that only spawns things needs a unit of its own somewhere out of the way (the editor places one when a design forgets). The game's AI does nothing for a computer slot in a scenario unless a trigger runs an AI script — which is usually what you want: the triggers are the AI.

**Forces.** Four. Players in one force can be allied (they do not attack each other), share victory (one wins, all win) and share vision. A team of humans is one force with Allied Victory; the enemy computer is another force. Force names are shown in the lobby.

**Triggers.** Each trigger has conditions (all must hold), actions (run in order) and a player list (it runs once *per player* it is listed for, with "Current Player" meaning that player). A trigger fires once, then never again, unless it has Preserve Trigger. The list runs top to bottom about every two seconds; with *hyper triggers* — a preserved trigger of ~62 Wait(0) actions, kept in three copies — it runs about twelve times a second, which is what makes spawns, timers and reactions feel instant. A Wait inside any *other* preserved trigger stalls that player's whole trigger queue, hyper triggers included: time with death counters instead.

**Death counters.** Deaths(player, unit) is the game's counter per player per unit type, and Set Deaths writes it — so a unit that is never placed ("Cave (Unused)", "Cantina (Unused)", the Markers) is a free integer variable per player. Timers: add 1 every cycle, act when it reaches N, set it to 0. Twelve cycles a second with hypers, one every two seconds without.

**Switches.** 256 booleans shared by everyone. Good for one-off flags ("boss spawned"), poor for anything counted.

**Locations.** Named rectangles (254 of them, Anywhere is the whole map). Bring(player, unit, location) is how a map sees where a unit is; Create Unit, Move Unit, Kill Unit At Location, Order all take one. Make locations a little larger than the thing they watch. A location can exclude heights (ground / air) so a flier overhead does not trigger a ground beacon.

**Resources and score.** Set Resources adds minerals or gas; Accumulate tests them. Kill score (Score … Kills) grows by roughly a unit's cost per kill and can be subtracted from, which is how "kill to cash" is paid. Leaderboards show kills, control, resources or points.

**Ending the game.** Nothing ends a scenario by itself. Victory and Defeat are actions; the melee rule "no buildings, you lose" does not apply. Every human needs a path to each. Opponents(Current Player, Exactly, 0) is true when every non-allied player is gone or defeated — the usual last-standing victory.

**Limits.** 1700 units on the map at once (Create Unit silently fails past it); 65535 strings in a Brood War map; 254 locations; text messages of a few hundred characters; a Wait longer than ~2 minutes is a bad idea. Units created on unwalkable ground or on top of a building are placed at the nearest free spot, or not at all when the location is packed.

**Text.** Display Text Message shows a line at the top left; Set Mission Objectives fills the objectives box (F10 ▸ Objectives). Colour codes are bytes below 0x20 in the string (the editor's string fields have a picker).`;

const MADNESS = `# Madness maps

A *madness* map is a symmetric free-for-all where the map spawns each player's army for them and the armies fight on their own. The player's job is to spend what they earn on the right things and to pick the moment to push.

**Layout.** One base per player, each a small walled plateau or corner with its hall (or a beacon that stands for it) and its *spawn location* beside it, all opening onto a common arena in the middle. Distances equal; the arena open; no resources to mine.

**Players.** One human per base; one computer slot for props if any; humans each in their own force (or two forces for a team game with Allied Victory). All humans start hostile to each other.

**Systems (toolkit kinds).**
- \`hyper\`, always.
- \`spawn\`: a unit every few seconds at \`Spawn {p}\`, owned by the player (\`owner: each\`), with \`attack\` set to the arena so the units go and fight. Several spawn systems for several unit types; \`limit\` keeps the unit count under control.
- \`auto-attack\` on each player's units from Anywhere to the arena keeps stragglers moving.
- \`kill-to-cash\` or \`income\` so there is something to spend; unit and upgrade costs go through Unit Settings.
- \`stages\` so the game does not stall: every few minutes a stage rises, pays, and adds a heavier spawn.
- \`last-standing\` with \`unit: Buildings\` (the hall is the life) or a hero unit.
- \`leaderboard\` kills, \`objectives\`.

**Pitfalls.** Spawns without a limit hit the 1700-unit cap in minutes and the game stops creating units for everyone. A base with two exits is a base that dies to a flank; one ramp. Spawned units that are not ordered sit at the spawn until attacked.`;

const DEFENSE = `# Defense and tower defense

Waves of enemy units walk from a spawn to a goal; the players kill them on the way. In a *tower defense* the players build static defence (turrets, cannons, sunkens) along a lane and cannot fight themselves; in a *hero defense* they control units.

**Layout.** A lane from a spawn location to a goal location — a corridor of unbuildable ground with buildable strips beside it for towers, or a maze. The goal is a small location the enemies path into. Players start beside the lane with a builder each and no minerals to mine.

**Players.** Humans in one force with Allied Victory and shared vision; one computer as the enemy, hostile to all; its units must be ordered, or they stand at the spawn.

**Systems.**
- \`hyper\`.
- \`waves\`: units by wave, count and growth, interval, spawn and goal; the last wave cleared is the victory.
- \`lives\`: a leak (an enemy reaching the goal) is removed and costs a shared life; zero lives is defeat.
- \`kill-to-cash\` for the bounty (\`scorePerKill\` ≈ the enemy unit's cost, so a Zergling pays half a Hydralisk).
- \`income\` per wave or per tower (\`perUnit\`) if the map wants a steady economy.
- \`leaderboard\` kills, \`objectives\`, \`message\` for the first wave.

**Pitfalls.** Towers on the lane block it and the wave stops: make the lane unbuildable. Bounty through kill score pays in lumps of \`scorePerKill\`; set it to the cheapest enemy's score. A wave stronger than the towers ends the game in one leak — give lives.`;

const RPG = `# RPG maps

Each player controls a hero (a named unit, or an ordinary unit with Unit Settings) through a world of quests, shops and bosses. Progression is minerals from kills spent at shops, upgrades bought at beacons, and story told by text.

**Layout.** A town (start locations, a heal spot, shops as beacon locations, a save/teleport gate) and regions of rising difficulty joined by paths; a boss room at the end. Enemy units are placed by hand (they belong to the computer) or spawned in regions when a player enters. Locations: the town, each shop's beacon, each region, each boss room, teleport pairs.

**Players.** Humans in one force, allied, shared vision, Allied Victory. The computer owns the enemies and the shopkeepers; a *rescuable* slot for units that join when found.

**Systems.**
- \`hyper\`.
- \`kill-to-cash\` for the economy; \`shop\` per item (bring the hero to the beacon with the price; \`deliver\` next to the shop); \`heal\` in the town.
- \`respawn\` for the hero (with \`lives\`, or unlimited), or \`defeat-when-lost\` for permadeath.
- \`spawn\` with \`owner: computer\` in a region for monsters that keep coming; \`give\` for a rescued companion; \`teleport\` between the town and the regions.
- \`message\` on entering a region (\`location\`) for the story; \`objectives\`.
- Victory: \`victory-on-kills\` of the boss unit (\`unit: <the boss>\`, \`count: 1\`), or a custom system for a staged fight.

**Pitfalls.** Heroes need Unit Settings (hit points, damage) to survive at all; the default marine dies to two zerglings. A shop beacon inside the walking path buys by accident — set it off the path. Enemies placed by hand for the computer stand still unless the computer runs an AI script or a trigger orders them: \`auto-attack\` from a region to the town is the simplest guard behaviour.`;

const BOUND = `# Bound maps

A *bound* is an obstacle course: a narrow path the player's unit must run through, past explosions that fire in patterns, with checkpoints to respawn at. Pure timing and pattern; no economy.

**How an explosion works.** An explosion is a unit (Scourge, Scarab, a nuke's flash) *created and killed in the same instant* at a spot — the death animation is the blast. The animation hurts nothing by itself: the same trigger kills every unit the players have standing on the spot, and that is what makes the spot lethal. Explosion units left alive do not attack (a Scourge cannot even hit ground units): create and kill, never create and wait.

**Layout.** A winding path four tiles wide across water or empty space, from a start to a finish, cut into *stretches*: each a field of *spots* laid back to back along the path — every spot a slab across the whole path, or two or three side by side when the field has lanes — with safe ground before and after it and a checkpoint at its end. The \`bound\` layout preset makes all of it: Start, Finish, Checkpoint {n}, Stretch {n}, Spot {n}. Spots are numbered along the course, lane by lane within a slab: with one lane, Stretch 1 is Spot 1 … Spot 8 and Stretch 2 is Spot 9 … Spot 16; with two lanes a slab is two consecutive numbers (Spot 1 and 2 side by side, then 3 and 4).

**Patterns.** One \`obstacles\` system per stretch, each with its own beat, over that stretch's run of spots: a *roll* is the spots in order one at a time (the runner follows the wave); *pairs* or *thirds* fire \`groups\` spots spread along the run at once (the runner reads two hazards); a *flash* is every spot of the stretch in one group (the runner waits for the gap); with lanes, the odd spots then the even ones alternate sides (the runner zigzags). The beat sets the difficulty — 0.8 s for an opening, 0.5 s for a finale.

**Players.** Humans each with one unit (a Zergling, a fast Terran unit), in one force or none; a computer owns the explosions. Lives per player, or unlimited.

**Systems (toolkit kinds).**
- \`hyper\`, essential: the timing is the game.
- \`obstacles\`: the spots in firing order, a beat in seconds, how many fire at once — one system per stretch, over that stretch's spots. It runs on death counters, never Wait: a Wait in a preserved trigger stalls that player's whole queue, hyper triggers included.
- \`checkpoints\`: the unit, the start, the checkpoints in order, the finish — recording progress, respawning at the last checkpoint, and the win for the first to the finish with the loss for the rest.
- \`message\` at the start; \`leaderboard\` deaths if wanted. Nothing here needs a custom system.

**Pitfalls.** Without hyper triggers a bound is unplayable — the explosions come every two seconds. Explosion units owned by a human hurt only enemies; give them to the computer. A spot must lie on the path, and the pattern must leave a gap a unit can run through.`;

const DIPLOMACY = `# Diplomacy and risk maps

Territories on a world map, each with a building or beacon that marks control; income per territory held; alliances made and broken in the game's diplomacy menu; last empire standing wins.

**Layout.** Regions of buildable ground separated by water, mountains and chokes, each with a capital location and a few resource-free building spots; start locations spread evenly; a legend of region names in the description or the objectives.

**Players.** Up to eight humans, each in their own force so alliances are up to them (no shared vision); a computer for rebels or barbarians, hostile to all.

**Systems.**
- \`hyper\` is optional; a slow tempo suits.
- \`income\` per region: one system per region with \`perUnit\` the region's capital building and \`players: humans\`, or a flat income plus \`kill-to-cash\`.
- \`spawn\` with \`owner: computer\` in neutral regions for rebels; \`auto-attack\` to send them at the nearest capital.
- \`last-standing\` with \`unit: Buildings\`; \`leaderboard\` control of the capital building; \`objectives\`.
- A \`countdown\` with \`onEnd: draw\` if the game must end.

**Pitfalls.** Eight players and Allied Victory in one force means everyone wins together — leave the humans in separate forces. Income systems each take a death counter; the toolkit has about eighteen.`;

const ARENA = `# Arena and micro maps

Rounds in a walled arena: each side gets the same units, the survivor of the round scores, first to N rounds wins. All skill, no economy.

**Layout.** A flat arena with two (or four) spawn locations at its sides and a wall around it; a lobby location per player outside. Symmetric.

**Players.** Two humans (or two forces of humans with Allied Victory), hostile.

**Systems.**
- \`hyper\`.
- Round flow is custom: when the arena holds units of only one side, that side's score counter goes up, everything in the arena is removed, and after a short pause both sides get the round's units at their spawns. Say the unit list per round in the description.
- \`spawn\` does not fit (it is periodic); use it only for a practice mode.
- \`victory-on-kills\` does not fit either; the win is the round score — custom, or \`countdown\` with \`onEnd: victory:<the leader>\` when a timed match is enough.
- \`leaderboard\` points with the round score in Set Score (Custom); \`objectives\`.

**Pitfalls.** Units left from the last round decide the next; remove everything in the arena between rounds. A wall the units can shoot over is not a wall.`;

const SURVIVAL = `# Survival, hero survival, cat and mouse

Hold out until a timer runs out, or hunt the survivors before it does. In *cat and mouse* one side (the cats) hunts the others (the mice), who build walls and hide; in *hero survival* every player fights the map's spawns and the last one alive wins.

**Layout.** A large open area with hiding places and chokes for the mice; spawn locations for the map's monsters at the edges; a safe start for each human.

**Players.** Cats and mice in two forces (no Allied Victory across them); or every human alone; a computer for the monsters.

**Systems.**
- \`hyper\`.
- \`countdown\` with \`onEnd: victory:Force 2\` (the mice) — the cats must win before it ends; or \`victory:humans\` in a co-op survival.
- \`spawn\` with \`owner: computer\` at the edges, \`attack\` toward the centre, and \`auto-attack\` so the monsters hunt.
- \`defeat-when-lost\` on each player's hero, or \`last-standing\`.
- \`income\` for the mice to build with; \`kill-to-cash\` for the cats.
- \`leaderboard\` control of the hero unit shows who is still alive; \`objectives\`.

**Pitfalls.** A countdown victory for a force while another system gives Defeat on the same cycle is a race — put the defeat's grace period after the timer. Monsters spawned without an order stand still.`;

export const TERRAIN = `# Terrain work: how the brush, the shapes, ramps, bridges, bases and doodads behave

**The isometric brush** (paint_terrain, every shape). Terrain is painted by type id (list_terrains, or the reference's tileset block); cliffs and shores between two types draw themselves where they join, and a type joins only the types the tileset's tables link it to. The brush bleeds: a shore or a cliff takes about three tiles either side of the boundary, so a band of water narrower than about ten tiles is all shore, and a rect painted right up to water or a cliff redraws that edge — leave a few tiles' gap, or name the terrains to leave alone (\`keep\`). Diamonds the tileset cannot join to their neighbours are refused and counted. Painting the ground under a doodad removes it: doodads inside the painted rect go with the ground and are counted in one line; the re-blend also reaches along a cliff or shore well outside the rect, and a doodad it lifts there is put back where it still fits (a second undo step) or named with its position. Repainting the ground under a unit keeps the unit.

**Shapes** (paint_shapes), in map tiles, later over earlier, each an object with an \`op\`:
- \`ground\` (the whole map) and \`border\` (width) take a terrain id.
- \`rect\` (x, y, w, h; optional \`cut\`: isometric corner cut in rows), \`diamond\` / \`ellipse\` (cx, cy, rx, ry), \`polygon\` (points).
- \`stroke\` (points, width): a band — a river, a road, a wall. A river carries its bridges as \`bridges\`: [[x, y], …]; the editor bends the river onto the 2:1 diagonal a bridge spans through each site, narrows it to the channel, paints the banks and fits the bridge, so the water reaches the bridge from both sides. Optional \`bank\` terrain id and \`bankWidth\` paint a band either side, bent with the river. A stroke's round ends reach half its width past each point: keep later strokes off a bridge's tiles.
- \`plateau\` (like rect, plus \`ramps\`: which lower corners get a ramp down, "sw" and/or "se"): the editor cuts the corner into the diagonal edge a ramp fits, paints the pair the tileset has ramps for either side, and fits the ramp.
- \`lane\` (points, width, \`wall\` terrain id, \`wallWidth\`): a walkable band with walls either side, continuous by construction; the width is the walkable core kept.
- \`ramp\` (x, y, side): on a cliff already there. \`bridge\` (x, y, along "se" or "sw"): a stamp over whatever is there — a channel of the bridge's water along the 2:1 diagonal, about 30 tiles long, with 8 tiles of the bridge's ground either side, then the bridge; a river drawn separately must be brought to both ends of the channel as water, and the result says when it is not. Prefer a stroke with bridges.
Only the tiles the shapes cover change. \`originX\` / \`originY\` shift every coordinate, for shapes written relative to an area's corner. \`clear\` removes the units, doodads and sprites inside the rectangle the shapes touch first (the whole map for ground or border); leave it off unless the area is meant to start empty. Optional \`locations\` ([{name, x0, y0, x1, y1}]) and \`units\` ([{unit, player, x, y}]) go on afterwards.

**Ramps** go down south-west or south-east and nowhere else. A ramp is a doodad that fits only a straight diagonal cliff run facing south, between ground the tileset has a ramp for (the reference's tileset block lists the pairs); a tile-aligned cliff takes none. place_ramp tries every ramp within a few tiles with the editor's own placement rule and takes the nearest fit; a plateau shape makes an edge that fits.

**Bridges** are doodads too, fitting only a channel of the bridge's water along the 2:1 diagonal (two tiles across for one down, running south-east or south-west) of the width the reference's tileset block gives. Badlands' bridges the editor cannot place; Installation and Ash World have none: there, a crossing is a gap of ground in the water — say so rather than trying. After painting, reachable answers whether units can walk from one place to another; a yes is not proof that a river holds, since a broken barrier answers yes too. To prove a bridge is the only way over, ask again with \`ignoreBridges\` (the tiles under every bridge count as water), which should answer no.

**Bases.** place_base lays the mineral patches on the ring three tiles from a 4 × 3 town hall footprint, where the game mines fastest, spread round a compass \`direction\` (where the line lies seen from the hall; default away from the map's centre) and wrapping the hall's corners like Blizzard's own lines, the geyser on the same ring just past the line's end (\`geyserSide\` left / right / auto). Positions the editor refuses (cliffs, water, the edge, units already there) are left out and the line closes over them; when that side has no whole line it turns to the nearest direction that does and says so. \`minerals\` (default 8), \`geysers\` (0–2, default 1), \`amount\` (1500) and \`gas\` (5000) are the numbers; \`hall\` names a Command Center, Nexus or Hatchery to place for \`player\`. find_site with purpose building and about 14 × 11 finds room for hall and ring; bases reads what every start already has.

**Doodads.** scatter_doodads keeps to the ground its category names (the editor's own rule: a Water doodad stands only on water, a Snow one only on snow) and clear of other doodads, so scatter a category over its own ground and read the count; a rect that also covers other ground places few and says so. place_doodads takes a name, an id or a category name, with the top-left corner at a tile.`;

export const GUIDES: Guide[] = [
  { id: "terrain", title: "Terrain work: the brush, shapes, ramps, bridges, bases, doodads", keywords: [], text: TERRAIN },
  { id: "basics", title: "Scenario basics", keywords: ["ums", "scenario", "trigger", "death counter", "hyper", "switch", "location"], text: BASICS },
  { id: "madness", title: "Madness maps", keywords: ["madness", "mass", "spawn war", "auto spawn"], text: MADNESS },
  { id: "defense", title: "Defense and tower defense", keywords: ["defense", "defence", "tower", "td", "waves", "sunken", "cannon"], text: DEFENSE },
  { id: "rpg", title: "RPG maps", keywords: ["rpg", "hero", "quest", "adventure", "shop", "boss", "dungeon"], text: RPG },
  { id: "bound", title: "Bound maps", keywords: ["bound", "obstacle", "dodge", "explosion", "scourge"], text: BOUND },
  { id: "diplomacy", title: "Diplomacy and risk", keywords: ["diplomacy", "risk", "empire", "territory", "nations", "world map"], text: DIPLOMACY },
  { id: "arena", title: "Arena and micro", keywords: ["arena", "micro", "rounds", "duel", "1v1", "pvp", "tournament"], text: ARENA },
  { id: "survival", title: "Survival, hero survival, cat and mouse", keywords: ["survival", "survive", "cat and mouse", "hunt", "zombie", "horror", "hold out", "last man"], text: SURVIVAL },
];

export function guideById(id: string): Guide | null {
  const wanted = id.trim().toLowerCase();
  return GUIDES.find((g) => g.id === wanted || g.title.toLowerCase() === wanted) ?? null;
}

/** The genre guide a prompt points at — the one whose keywords it mentions most — or null when none do. */
export function guideFor(prompt: string): Guide | null {
  const text = ` ${prompt.toLowerCase()} `;
  let best: Guide | null = null;
  let score = 0;
  for (const g of GUIDES) {
    if (g.id === "basics" || g.id === "terrain") continue;
    let n = 0;
    for (const k of g.keywords) if (text.includes(` ${k} `) || text.includes(`${k} `) || text.includes(` ${k}`)) n += k.length > 3 ? 2 : 1;
    if (n > score) { best = g; score = n; }
  }
  return best;
}

/** What the `guide` tool answers with no argument: the list. */
export function guideIndex(): string {
  return GUIDES.map((g) => `${g.id}: ${g.title}`).join("\n");
}
