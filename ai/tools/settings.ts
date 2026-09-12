/** The Scenario menu's dialogs: players, forces, unit / upgrade / technology settings, the revision. Transactions outside the undo model. */
import { bag, bool, byName, capResult, colorIndexOf, fail, fieldsGiven, ints, jsonOf, list, noSuchTech, noSuchUnit, noSuchUpgrade, num, obj, plural, slotOf, str, techIdByName, unitIdByName, upgradeIdByName, type Tool } from "./common";

export function settingsTools(): Tool[] {
  return [
    {
      def: { name: "set_players", description: "Player Settings and Colors: entries of { player (1-based), type (Human, Computer, Rescuable, Neutral, Inactive …), race, color (a name or a COLR index), rgb ([r, g, b], Remastered), force 1–4 }. Only the fields given change. Not undoable.", inputSchema: obj({ players: { type: "array", items: bag({ player: { type: "integer" } }, ["player"]) } }, ["players"]) },
      describe: (input) => { const ps = list(input.players); return `Set player${ps.length === 1 ? "" : "s"} ${ps.map((p) => str(p.player)).join(", ")}: ${fieldsGiven(Object.assign({}, ...ps), ["type", "race", "color", "rgb", "force"]) || "nothing"}`; },
      report: (result) => { const r = jsonOf(result); if (!r) return ""; const notes = Array.isArray(r.notes) ? r.notes : []; return `${plural(num(r.changed), "player")} changed${notes.length ? `; ${String(notes[0])}` : ""}`; },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const notes: string[] = [];
        let changed = 0;
        const r = api.document.update("AI: player settings", (tx) => {
          for (const p of list(input.players)) {
            const slot = slotOf(p.player);
            if (slot === null || slot === "default") { notes.push(`player ${str(p.player)}: not a player number`); continue; }
            const patch: { type?: number; race?: number; color?: number; rgb?: [number, number, number] | null; force?: number } = {};
            if (p.type !== undefined) { const t = byName(api.names.playerTypes(), str(p.type)); if (t) patch.type = t.value; else notes.push(`unknown player type "${str(p.type)}"`); }
            if (p.race !== undefined) { const rc = byName(api.names.races(), str(p.race)); if (rc) patch.race = rc.value; else notes.push(`unknown race "${str(p.race)}"`); }
            if (p.color !== undefined) { const c = colorIndexOf(p.color); if (c !== null) { patch.color = c; patch.rgb = null; } else notes.push(`unknown colour "${str(p.color)}"`); }
            if (Array.isArray(p.rgb) && p.rgb.length === 3) patch.rgb = [num(p.rgb[0]), num(p.rgb[1]), num(p.rgb[2])];
            if (p.force !== undefined) patch.force = Math.max(0, Math.min(3, Math.round(num(p.force, 1)) - 1));
            if (tx.players.set(slot, patch)) changed++;
          }
        });
        return capResult({ changed, sections: r.sections, notes });
      },
    },
    {
      def: { name: "set_forces", description: "Force Settings: entries of { force 1–4, name, allied, alliedVictory, sharedVision, randomStart (booleans), players ([1-based]) }. Only the fields given change. Not undoable.", inputSchema: obj({ forces: { type: "array", items: bag({ force: { type: "integer" } }, ["force"]) } }, ["forces"]) },
      describe: (input) => { const fs = list(input.forces); return `Set force${fs.length === 1 ? "" : "s"} ${fs.map((f) => str(f.force)).join(", ")}: ${fieldsGiven(Object.assign({}, ...fs), ["name", "allied", "alliedVictory", "sharedVision", "randomStart", "players"]) || "nothing"}`; },
      report: (result) => { const r = jsonOf(result); return r ? `${plural(num(r.changed), "force")} changed` : ""; },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        let changed = 0;
        const r = api.document.update("AI: force settings", (tx) => {
          for (const f of list(input.forces)) {
            const force = Math.round(num(f.force, 1)) - 1;
            const patch: { name?: string; allied?: boolean; alliedVictory?: boolean; sharedVision?: boolean; randomStart?: boolean; players?: number[] } = {};
            if (typeof f.name === "string") patch.name = f.name;
            for (const k of ["allied", "alliedVictory", "sharedVision", "randomStart"] as const) { const v = bool(f[k]); if (v !== undefined) patch[k] = v; }
            if (Array.isArray(f.players)) patch.players = ints(f.players).map((p) => p - 1).filter((p) => p >= 0 && p < 8);
            if (tx.forces.set(force, patch)) changed++;
          }
        });
        return capResult({ changed, sections: r.sections, forces: api.settings.forces().map((f) => ({ force: f.force + 1, name: f.name, players: f.players.map((p) => p + 1), allied: f.allied, alliedVictory: f.alliedVictory, sharedVision: f.sharedVision, randomStart: f.randomStart })) });
      },
    },
    {
      def: { name: "set_unit_type", description: "Unit Settings for `unit`: hitPoints, shields, armor, buildTime (frames), mineralCost, gasCost, weapons [{id, damage, bonus}], name (\"\" restores), available [{player 1–12 or \"default\", value true / false / \"default\"}]. A number set turns use-default off; useDefault: true restores it. Not undoable.", inputSchema: bag({ unit: { type: "string" } }, ["unit"]) },
      describe: (input) => `Unit settings for ${str(input.unit)}: ${fieldsGiven(input, ["useDefault", "name", "hitPoints", "shields", "armor", "buildTime", "mineralCost", "gasCost", "weapons", "available"]) || "nothing"}`,
      report: (result) => { const r = jsonOf(result); return r ? (r.changed ? "changed" : "nothing changed") : ""; },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const id = unitIdByName(api, str(input.unit));
        if (id === null) return noSuchUnit(api, str(input.unit));
        const patch: Record<string, unknown> = {};
        for (const k of ["hitPoints", "shields", "armor", "buildTime", "mineralCost", "gasCost"]) if (input[k] !== undefined) patch[k] = Math.round(num(input[k]));
        if (input.useDefault !== undefined) patch.useDefault = bool(input.useDefault);
        if (typeof input.name === "string") patch.name = input.name;
        if (Array.isArray(input.weapons)) patch.weapons = list(input.weapons).map((w) => ({ id: Math.round(num(w.id)), ...(w.damage !== undefined ? { damage: Math.round(num(w.damage)) } : {}), ...(w.bonus !== undefined ? { bonus: Math.round(num(w.bonus)) } : {}) }));
        if (Array.isArray(input.available)) {
          patch.available = list(input.available).map((a) => { const player = slotOf(a.player); const v = typeof a.value === "string" && /default/i.test(a.value) ? "default" : bool(a.value); return player === null || v === undefined ? null : { player, value: v }; }).filter((x) => x !== null);
        }
        let changed = false;
        api.document.update(`AI: unit settings ${api.names.unit(id)}`, (tx) => { changed = tx.unitTypes.set(id, patch as never); });
        const t = api.settings.unitType(id);
        return capResult({ changed, now: t ? { name: t.name, useDefault: t.useDefault, hitPoints: t.hitPoints, shields: t.shields, armor: t.armor, buildTime: t.buildTime, mineralCost: t.mineralCost, gasCost: t.gasCost, weapons: t.weapons, availability: t.availability } : null });
      },
    },
    {
      def: { name: "set_upgrade", description: "Upgrade Settings for `upgrade`: mineralCost, mineralFactor, gasCost, gasFactor, timeCost, timeFactor (frames), levels [{player 1–12 or \"default\", start, max, useDefault}]. useDefault: true restores the game's. Not undoable.", inputSchema: bag({ upgrade: { type: "string" } }, ["upgrade"]) },
      describe: (input) => `Upgrade settings for ${str(input.upgrade)}: ${fieldsGiven(input, ["useDefault", "mineralCost", "mineralFactor", "gasCost", "gasFactor", "timeCost", "timeFactor", "levels"]) || "nothing"}`,
      report: (result) => { const r = jsonOf(result); return r ? (r.changed ? "changed" : "nothing changed") : ""; },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const id = upgradeIdByName(api, str(input.upgrade));
        if (id === null) return noSuchUpgrade(api, str(input.upgrade));
        const patch: Record<string, unknown> = {};
        for (const k of ["mineralCost", "mineralFactor", "gasCost", "gasFactor", "timeCost", "timeFactor"]) if (input[k] !== undefined) patch[k] = Math.round(num(input[k]));
        if (input.useDefault !== undefined) patch.useDefault = bool(input.useDefault);
        if (Array.isArray(input.levels)) patch.levels = list(input.levels).map((l) => { const player = slotOf(l.player); return player === null ? null : { player, ...(l.start !== undefined ? { start: Math.round(num(l.start)) } : {}), ...(l.max !== undefined ? { max: Math.round(num(l.max)) } : {}), ...(bool(l.useDefault) ? { useDefault: true } : {}) }; }).filter((x) => x !== null);
        let changed = false;
        api.document.update(`AI: upgrade ${api.names.upgrade(id)}`, (tx) => { changed = tx.upgrades.set(id, patch as never); });
        return capResult({ changed, now: api.settings.upgrade(id) });
      },
    },
    {
      def: { name: "set_tech", description: "Technology Settings for `tech`: mineralCost, gasCost, researchTime (frames), energyCost, state [{player 1–12 or \"default\", available, researched, useDefault}]. useDefault: true restores the game's. Not undoable.", inputSchema: bag({ tech: { type: "string" } }, ["tech"]) },
      describe: (input) => `Technology settings for ${str(input.tech)}: ${fieldsGiven(input, ["useDefault", "mineralCost", "gasCost", "researchTime", "energyCost", "state"]) || "nothing"}`,
      report: (result) => { const r = jsonOf(result); return r ? (r.changed ? "changed" : "nothing changed") : ""; },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const id = techIdByName(api, str(input.tech));
        if (id === null) return noSuchTech(api, str(input.tech));
        const patch: Record<string, unknown> = {};
        for (const k of ["mineralCost", "gasCost", "researchTime", "energyCost"]) if (input[k] !== undefined) patch[k] = Math.round(num(input[k]));
        if (input.useDefault !== undefined) patch.useDefault = bool(input.useDefault);
        if (Array.isArray(input.state)) patch.state = list(input.state).map((s) => { const player = slotOf(s.player); return player === null ? null : { player, ...(bool(s.available) !== undefined ? { available: bool(s.available) } : {}), ...(bool(s.researched) !== undefined ? { researched: bool(s.researched) } : {}), ...(bool(s.useDefault) ? { useDefault: true } : {}) }; }).filter((x) => x !== null);
        let changed = false;
        api.document.update(`AI: technology ${api.names.tech(id)}`, (tx) => { changed = tx.techs.set(id, patch as never); });
        return capResult({ changed, now: api.settings.tech(id) });
      },
    },
    {
      def: { name: "set_map_version", description: "Map Revision: original (.scm 1.00), hybrid (.scm 1.04), broodwar (.scx) or remastered. Ask first. Not undoable.", inputSchema: obj({ version: { type: "string", enum: ["original", "hybrid", "broodwar", "remastered"] } }, ["version"]) },
      describe: (input) => `Set the map revision to ${str(input.version)}`,
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const v = str(input.version) as "original" | "hybrid" | "broodwar" | "remastered";
        if (!["original", "hybrid", "broodwar", "remastered"].includes(v)) return fail("Unknown version.");
        const r = api.document.update("AI: map revision", (tx) => { tx.setVersion(v); });
        return r.changed ? `Now ${api.settings.version()?.label}. Sections touched: ${r.sections.join(", ")}.` : "Already that revision.";
      },
    },
    {
      def: { name: "add_sound", description: "Add a WAV path to the sound table (the file must already be in the archive). Not undoable.", inputSchema: obj({ path: { type: "string" } }, ["path"]) },
      describe: (input) => `Add the sound ${str(input.path)}`,
      writes: true,
      settings: true,
      run: (input, { api }) => { let slot = -1; api.document.update("AI: sound", (tx) => { slot = tx.sounds.add(str(input.path)); }); return slot < 0 ? "No free sound slot." : `Sound slot ${slot}: ${api.settings.sounds().find((s) => s.slot === slot)?.path}. ${plural(api.settings.sounds().length, "sound")} listed.`; },
    },
  ];
}
