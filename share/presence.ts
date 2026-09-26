/**
 * Other people on a shared map, drawn over it: each person's pointer as an arrow with their
 * name, and the edge of what they can see as a dashed box, in their colour — the editor's
 * player colours, one per person in the order they joined.
 */
import type { MapView } from "@scm-js/plugin-api";
import type { RoomPerson } from "../protocol";
import type { Presence } from "./shared";
import { msg, t, translate } from "../i18n";

/** StarCraft's first eight player colours. */
export const PERSON_COLORS = ["#f40404", "#0c48cc", "#2cb494", "#88409c", "#f88c14", "#703014", "#cce0d0", "#fcfc38"];

export const personColor = (p: RoomPerson) => PERSON_COLORS[p.color % PERSON_COLORS.length]!;

/** The built-in dialogs by id, in words, for "in Player Settings". */
const DIALOG_NAMES: Record<string, string> = {
  mapProperties: msg("Map Properties"), resizeMap: msg("Resize Map"), mapRevision: msg("Map Revision"), playerSettings: msg("Player Settings"), forceSettings: msg("Forces"),
  playerColors: msg("Player Colors"), unitSettings: msg("Unit Settings"), upgradeSettings: msg("Upgrade Settings"), techSettings: msg("Tech Settings"), stringEditor: msg("the String Editor"),
  soundEditor: msg("the Sound Editor"), switches: msg("Switches"), locationList: msg("the location list"), unitProperties: msg("Unit Properties"), locationProperties: msg("Location Properties"),
  spriteProperties: msg("Sprite Properties"), triggerEditor: msg("the Trigger Editor"), missionBriefing: msg("Mission Briefing"), cuwpEditor: msg("Unit Properties Slots"),
  replaceTerrain: msg("Replace Terrain"), autoStarts: msg("Auto-place Start Locations"), importTriggers: msg("Import Triggers"), importStrings: msg("Import Strings"),
  gameData: msg("Game Data (getting the game's graphics)"),
};

/** What a person is doing, in a few words, or "". */
export function doing(p: Presence | undefined): string {
  if (!p?.dialog) return "";
  const name = DIALOG_NAMES[p.dialog];
  return name ? t("in {dialog}", { dialog: translate(name) }) : "";
}

export function drawPeople(ctx: CanvasRenderingContext2D, view: MapView, people: RoomPerson[], presence: Map<string, Presence>) {
  ctx.save();
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (const person of people) {
    const p = presence.get(person.id);
    if (!p) continue;
    const color = personColor(person);
    if (p.view) {
      const x0 = view.x(p.view.x0 * 32), y0 = view.y(p.view.y0 * 32);
      const x1 = view.x(p.view.x1 * 32), y1 = view.y(p.view.y1 * 32);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    if (p.px !== null && p.py !== null) {
      const x = view.x(p.px), y = view.y(p.py);
      ctx.fillStyle = color;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 14);
      ctx.lineTo(x + 4, y + 10.5);
      ctx.lineTo(x + 9.5, y + 10.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const label = [person.name, doing(p)].filter(Boolean).join(" · ");
      const w = ctx.measureText(label).width + 8;
      ctx.fillRect(x + 10, y + 12, w, 16);
      ctx.fillStyle = luminance(color) > 0.6 ? "#000" : "#fff";
      ctx.fillText(label, x + 14, y + 20);
    }
  }
  ctx.restore();
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
}
