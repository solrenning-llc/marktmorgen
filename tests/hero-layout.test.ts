/**
 * The hero's layouts and its button (lib/sales-page.ts, HeroBlock). Checked:
 * a layout and a button are kept only as known values, left unsaid for the
 * default; the coach counts a button under the headline as one near the top;
 * the picture behind the words is darkened enough for white text on any
 * picture.
 */
import { readFileSync } from "node:fs";
import { PAGE_TEMPLATES, blocksFromDraft, blocksFromTemplate, parsePage } from "@/lib/sales-page";
import { coachChecks } from "@/lib/page-coach";
import { contrast, mix } from "@/lib/store-look";
import { done, is, part } from "./check";

const hero = (more: Record<string, unknown>) => parsePage({ blocks: [{ id: "hero0001", kind: "hero", headline: "Bread", sub: "", media: "picture", video: null, ...more }] }).blocks[0];

async function main(): Promise<void> {
  part("What a hero keeps");
  is("side by side is left unsaid", (hero({}) as { layout?: string }).layout ?? "unsaid", "unsaid");
  is("centered and behind the words are kept", ["centered", "cover"].map((layout) => (hero({ layout }) as { layout?: string }).layout), ["centered", "cover"]);
  is("anything else is the default", (hero({ layout: "parallax" }) as { layout?: string }).layout, undefined);
  is("a button only when asked for in so many words", [(hero({ button: true }) as { button?: boolean }).button, (hero({ button: "yes" }) as { button?: boolean }).button], [true, undefined]);

  part("The coach");
  const early = (more: Record<string, unknown>) =>
    coachChecks({ page: parsePage({ blocks: [{ id: "hero0001", kind: "hero", headline: "Bread", sub: "", media: "none", video: null, ...more }] }), productTitle: "Bread", free: false, picture: false, pictureAlt: "", facts: {} }).find((c) => c.id === "early-button")?.done;
  is("a button under the headline is a button near the top", [early({}), early({ button: true })], [false, true]);

  part("Pages that start with a button under the headline");
  const starts = PAGE_TEMPLATES.map((t) => blocksFromTemplate(t.id, { title: "Bread", summary: "", picture: false })[0]);
  is("every template", starts.every((b) => b?.kind === "hero" && b.button === true), true);
  const drafted = blocksFromDraft({ headline: "Bake", sub: "", story: null, benefits: [], inside: [], faq: [], guarantee: "", cta: "Get it", seoTitle: "", seoDescription: "" }, false).blocks[0];
  is("and a page drafted with AI", drafted.kind === "hero" && drafted.button === true, true);

  part("Words on any picture");
  const css = readFileSync("app/globals.css", "utf8");
  const stops = [...(css.match(/\.sp-hero-cover::before \{[^}]*\}/)?.[0] ?? "").matchAll(/rgb\(0 0 0 \/ ([0-9.]+)\)/g)].map((m) => Number(m[1]));
  const lightest = Math.min(...stops);
  const worst = mix("#ffffff", "#000000", lightest);
  is("darkened at least 55% everywhere", lightest >= 0.55, true);
  is("so white words on a white picture still read at 4.5:1", contrast("#ffffff", worst) >= 4.5, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
