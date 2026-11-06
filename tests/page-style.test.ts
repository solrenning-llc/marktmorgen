/**
 * A sales page's style (lib/sales-page.ts, PageStyle). What is checked:
 *
 *   - a page keeps a style it knows and falls back to "plain" for anything
 *     else, so an old page or a hand-made request still draws;
 *   - a page started from another product's page takes its style with it;
 *   - in bands, the first section shown below the hero is on a band and they
 *     alternate from there;
 *   - the band's colour, for every theme and every preset colour and some
 *     colours of a creator's own, keeps the text and the muted text at 7:1
 *     and the coloured links at 4.5:1 — a style never costs anyone reading;
 *   - muted text keeps 7:1 on the page, cards, items and the soft accent too;
 *   - the stylesheet draws each style the page and the preview ask for.
 */
import { readFileSync } from "node:fs";
import { ACCENTS, THEMES, contrast, lookColours, lookStyle } from "@/lib/store-look";
import { EMPTY_PAGE, PAGE_STYLES, bandsOf, copyOfPage, onBand, parsePage } from "@/lib/sales-page";
import { done, is, part } from "./check";

async function main() {
  part("The style a page keeps");
  is("an empty page is plain", EMPTY_PAGE.style, "plain");
  is("a page saved before styles is plain", parsePage({ blocks: [] }).style, "plain");
  for (const style of PAGE_STYLES) is(`"${style}" is kept`, parsePage({ blocks: [], style }).style, style);
  is("an unknown style is plain", parsePage({ blocks: [], style: "neon" }).style, "plain");
  is("a style that is not a word is plain", parsePage({ blocks: [], style: { bands: true } }).style, "plain");

  part("Starting from another page");
  const other = parsePage({ blocks: [{ id: "b1", kind: "text", heading: "Why", body: "Because." }], style: "cards" });
  is("the copy takes the style", copyOfPage(other).style, "cards");

  part("Bands alternate on what is shown");
  is("bands: first, third and fifth on a band", [0, 1, 2, 3, 4].map((i) => onBand("bands", i)), [true, false, true, false, true]);
  is("plain: none", [0, 1, 2].map((i) => onBand("plain", i)), [false, false, false]);
  is("cards: none", [0, 1, 2].map((i) => onBand("cards", i)), [false, false, false]);

  part("Blocks kept to one kind of screen");
  const kept = parsePage({
    blocks: [
      { id: "hero0001", kind: "hero", headline: "Bread", sub: "", media: "none", video: null, screens: "phone" },
      { id: "text0001", kind: "text", heading: "A", body: "a", screens: "phone" },
      { id: "text0002", kind: "text", heading: "B", body: "b", screens: "computer" },
      { id: "text0003", kind: "text", heading: "C", body: "c", screens: "tv" },
    ],
  });
  is("phones, computers, or every screen when unsaid or unknown", kept.blocks.map((b) => b.screens ?? "all"), ["all", "phone", "computer", "all"]);
  is("the hero always shows: it carries the page's heading", kept.blocks[0].screens, undefined);
  const mixed = [{}, { screens: "phone" as const }, { screens: "computer" as const }, {}, {}];
  is("bands alternate on what phones show", bandsOf("bands", mixed).map((b) => b.phone), [true, false, false, true, false]);
  is("and apart, on what computers show", bandsOf("bands", mixed).map((b) => b.computer), [true, false, false, true, false]);
  is("a block not shown on a screen is never a band there", [bandsOf("bands", [{ screens: "computer" }])[0].phone, bandsOf("bands", [{ screens: "phone" }])[0].computer], [false, false]);
  is("no bands outside the bands style", bandsOf("cards", mixed).some((b) => b.phone || b.computer), false);
  const css2 = readFileSync("app/globals.css", "utf8");
  is("each is hidden on the other side of the page's 700-pixel line", [/@container \(max-width: 699\.98px\) \{[^@]*\.sp-only-computer \{\s*display: none;/.test(css2), /@container \(min-width: 700px\) \{[^@]*\.sp-only-phone \{\s*display: none;/.test(css2)], [true, true]);

  part("The band reads, in every look");
  const accents = [...ACCENTS.map((a) => a.hex), "#ffff00", "#00ffff", "#ffffff", "#000000", "#7f7f7f", "#ff00ff"];
  let worst = { text: 99, muted: 99, link: 99 };
  for (const theme of THEMES) {
    for (const accent of accents) {
      const c = lookColours({ theme: theme.id, accent });
      worst = {
        text: Math.min(worst.text, contrast(c.band, c.text)),
        muted: Math.min(worst.muted, contrast(c.band, c.muted)),
        link: Math.min(worst.link, contrast(c.band, c.accentText)),
      };
    }
  }
  is("text on a band, at least 7:1", worst.text >= 7, true);
  is("muted text on a band, at least 7:1 (WCAG 1.4.6 AAA, small text)", worst.muted >= 7, true);
  is("links on a band, at least 4.5:1", worst.link >= 4.5, true);
  // Muted words (dates, notes, hints) are small text: 7:1 on every surface of every theme, not only on bands.
  let worstSurface = 99;
  for (const theme of THEMES) {
    const c = lookColours({ theme: theme.id, accent: ACCENTS[0].hex });
    worstSurface = Math.min(worstSurface, contrast(c.bg, c.muted), contrast(c.card, c.muted), contrast(c.item, c.muted));
  }
  is("muted text on the page, a card and an item, at least 7:1 in every theme", worstSurface >= 7, true);
  let worstSoft = 99;
  for (const theme of THEMES) for (const accent of accents) {
    const c = lookColours({ theme: theme.id, accent });
    worstSoft = Math.min(worstSoft, contrast(c.accentSoft, c.muted));
  }
  is("muted text on the soft accent (chosen, selected and highlighted things), at least 7:1", worstSoft >= 7, true);
  const violet = lookColours({ theme: "light", accent: "#5a36ee" });
  is("the band is not the card: it can be seen", violet.band !== violet.card, true);
  is("the page is given the band", lookStyle({ theme: "light", accent: "#5a36ee" })["--st-band"], violet.band);

  part("The stylesheet draws each style");
  const css = readFileSync("app/globals.css", "utf8");
  is("bands are drawn, on phones and on larger screens", [css.includes(".sp-style-bands .sp-band-phone > .sp-section"), css.includes(".sp-style-bands .sp-band-computer > .sp-section")], [true, true]);
  is("cards are drawn", css.includes(".sp-style-cards .sp-block > .sp-section"), true);
  const page = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("the live page carries its style", page.includes("sp-style-${page.style}"), true);
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  is("the preview carries the style being edited", editor.includes("sp-style-${style}"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
