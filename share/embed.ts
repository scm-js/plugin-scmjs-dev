/**
 * *Embed This Map*: a picture of the map that links to it, as ready-made code for a forum
 * post or signature (BBCode), a README or a Discourse forum (Markdown), or a website (HTML).
 *
 * The picture is the server's card image, fetched by the card's own id — its address opens
 * nothing. The link around it is the one the owner picks: a copy link (the default: anyone
 * who follows it gets their own copy), or, for a map kept open, the shared map's own link,
 * which lets anyone who sees the picture join and edit. That choice is said plainly.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { describeError } from "../client";
import { clear, h, styled, type Ctx } from "../ui";

export type EmbedAction = "copy" | "edit";

/** Where an embed can point: always a copy link (made when first asked for), and for a kept map its owner the shared map's own link. */
export interface EmbedTarget {
  name: string;
  copy: () => Promise<{ link: string; card: string }>;
  edit?: { link: string; card: string };
}

export interface Snippets {
  markdown: string;
  bbcode: string;
  html: string;
  /** The image's own address, at the size picked. */
  image: string;
}

/** The three snippets for a picture of `name` at `card`, linking to `link`. */
export function embedSnippets(o: { name: string; link: string; card: string; action: EmbedAction; small: boolean }): Snippets {
  const image = o.small ? `${o.card}?w=600` : o.card;
  const alt = `${o.name} — ${o.action === "edit" ? "edit together in scmJS" : "open a copy in scmJS"}`;
  const [w, hgt] = o.small ? [300, 158] : [600, 315];
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const md = (s: string) => s.replace(/([\\\[\]])/g, "\\$1");
  return {
    image,
    markdown: `[![${md(alt)}](${image})](${o.link})`,
    bbcode: `[url=${o.link}][img]${image}[/img][/url]`,
    html: `<a href="${attr(o.link)}"><img src="${attr(image)}" alt="${attr(alt)}" width="${w}" height="${hgt}"></a>`,
  };
}

const EMBED_STYLE = `
.sd .sd-embed-pic { display: block; width: 100%; max-width: 480px; aspect-ratio: 1200 / 630; border-radius: 6px; border: 1px solid var(--border, #333); background: var(--bg-1, #14171d); }
.sd .sd-snip { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: start; }
.sd .sd-snip textarea { width: 100%; min-height: 44px; resize: vertical; font-family: var(--mono, monospace); font-size: 11px; }
`;

export function openEmbedDialog(ctx: Ctx, target: EmbedTarget): DialogHandle {
  const { api } = ctx;
  const w = api.ui.widgets;
  return api.ui.dialog({
    title: "Embed This Map",
    size: "md",
    mount(body) {
      const root = styled(body);
      const style = document.createElement("style");
      style.textContent = EMBED_STYLE;
      body.prepend(style);
      const status = w.statusLine({ text: "" });
      const out = h("div", null);
      let copy: { link: string; card: string } | null = null;

      const to = w.select([
        { value: "copy", label: "A copy of the map: anyone can open their own" },
        ...(target.edit ? [{ value: "edit", label: "The shared map: anyone who sees it can join and edit" }] : []),
      ], { value: "copy", onChange: () => void render() });
      const size = w.select([
        { value: "large", label: "Large (1200 × 630)" },
        { value: "small", label: "Small (600 × 315), for a signature" },
      ], { value: "large", onChange: () => void render() });

      const row = (label: string, text: string) => {
        const area = document.createElement("textarea");
        area.readOnly = true;
        area.value = text;
        const copyBtn = w.button("Copy", { onClick: async () => {
          try { await navigator.clipboard.writeText(text); status.set(`${label} copied.`, "ok"); }
          catch { area.select(); status.set("Select the text and copy it.", "warn"); }
        } });
        return h("div", null, h("div", { className: "sd-k" }, label), h("div", { className: "sd-snip" }, area, copyBtn));
      };

      const render = async () => {
        clear(out);
        const action = to.value === "edit" && target.edit ? "edit" : "copy";
        if (action === "copy" && !copy) {
          status.busy("Making a link…");
          try { copy = await target.copy(); status.set(""); }
          catch (err) { status.set(describeError(err), "error"); return; }
        }
        const pick = action === "edit" ? target.edit! : copy!;
        const s = embedSnippets({ name: target.name, link: pick.link, card: pick.card, action, small: size.value === "small" });
        if (action === "edit") status.set("Anyone who sees this picture can follow it, join the map and edit it. Account ▸ Shared maps ▸ New link stops the old link working.", "warn");
        else if (!status.textContent?.includes("copied")) status.set("");
        out.append(
          h("img", { className: "sd-embed-pic", src: `${pick.card}?w=600`, alt: "" }),
          row("Markdown — GitHub, Discourse, Reddit", s.markdown),
          row("BBCode — forums", s.bbcode),
          row("HTML — websites", s.html),
          row("The picture on its own", s.image),
        );
      };

      root.append(
        h("div", { className: "sd-hint" }, `A picture of “${target.name}” that links to it, for a forum post or signature, a README or a website. The picture shows the map, its name, who shared it, its size and players.`),
        w.form([{ label: "The picture opens", field: to }, { label: "Size", field: size }]),
        out,
        status,
      );
      void render();
    },
    buttons: [{ label: "Close", primary: true }],
  });
}
