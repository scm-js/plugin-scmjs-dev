import { describe, expect, it } from "vitest";
import { embedSnippets } from "../share/embed";

const CARD = "https://api.scmjs.dev/v1/cards/AbCdEfGhIjKlMnOpQrSt.png";
const LINK = "https://editor.scmjs.dev/map/tok123456789";

describe("embed snippets", () => {
  it("wrap the card in the link, for Markdown, BBCode and HTML", () => {
    const s = embedSnippets({ name: "Lost Temple", link: LINK, card: CARD, action: "copy", small: false });
    expect(s.markdown).toBe(`[![Lost Temple — open a copy in scmJS](${CARD})](${LINK})`);
    expect(s.bbcode).toBe(`[url=${LINK}][img]${CARD}[/img][/url]`);
    expect(s.html).toBe(`<a href="${LINK}"><img src="${CARD}" alt="Lost Temple — open a copy in scmJS" width="600" height="315"></a>`);
    expect(s.image).toBe(CARD);
  });

  it("ask for the small card, say what an edit link does, and escape the name", () => {
    const s = embedSnippets({ name: `Sam's "Map" [v2] <b>`, link: LINK, card: CARD, action: "edit", small: true });
    expect(s.image).toBe(`${CARD}?w=600`);
    expect(s.markdown).toContain("[![Sam's \"Map\" \\[v2\\] <b> — edit together in scmJS]");
    expect(s.html).toContain('alt="Sam\'s &quot;Map&quot; [v2] &lt;b&gt; — edit together in scmJS" width="300" height="158"');
  });
});
