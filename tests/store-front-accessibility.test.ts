/**
 * The store's front page for a buyer (app/[handle]/page.tsx), held to WCAG 2.2
 * AAA where a browser audit of its states found it short (274 [AX1]): the size
 * of what is pressed (2.5.5), a "Read more" link that says which product it is
 * for (2.4.9), the "Previous"/"Next" that cannot be pressed (1.4.6) and the
 * length of a line (1.4.8). Measured in Chromium with axe-core on synthetic
 * stores (full, empty, long, its second page, a search); these checks keep each
 * cause from coming back. They certify nothing else.
 *
 * The audit kept in tests/e2e/store-front-audit.mjs (7 November 2026, build of
 * 06bca7d8d) then counted the characters actually on each line and added an
 * "edge" store: a one-letter title link was 13 px wide, a real sentence reached
 * 81 characters a line at 200% and words of narrow letters 126 at 1280 px.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { THEMES, contrast, lookColours } from "@/lib/store-look";
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setProductDisplay, setProductImage, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { ProductCard } from "@/components/store-product";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const tall = (cls: string) => /\bmin-h-11\b/.test(cls) && /\binline-flex\b/.test(cls);
/** 44 px wide as well as tall (2.5.5): a one-letter title is otherwise as narrow as its letter. */
const square = (cls: string) => tall(cls) && /\bmin-w-11\b/.test(cls);
/** Text without its markup, dropped one character at a time (no single-pass regex). */
function words(markup: string): string {
  let out = "";
  let inTag = false;
  for (const ch of markup) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}
/** Markup without its screen-reader-only spans, cut by index (no single-pass regex). */
function withoutSrOnly(markup: string): string {
  const open = '<span class="sr-only">';
  let out = "";
  let at = 0;
  for (let i = markup.indexOf(open); i !== -1; i = markup.indexOf(open, at)) {
    const end = markup.indexOf("</span>", i);
    if (end === -1) break;
    out += markup.slice(at, i);
    at = end + "</span>".length;
  }
  return out + markup.slice(at);
}
/** Every <a> in the markup: its class and its words, with what only a screen reader hears. */
function anchors(html: string): { cls: string; text: string; heard: string }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => {
    const inner = m[2];
    return {
      cls: m[1].match(/class="([^"]*)"/)?.[1] ?? "",
      text: words(withoutSrOnly(inner)).trim(),
      heard: words(inner).replace(/\s+/g, " ").trim(),
    };
  });
}
const rule = (css: string, selector: RegExp) => css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_store_front_a11y";
  process.env.RESEND_API_KEY = "re_test_store_front_a11y";
  const OWNER = "front-a11y@example.com";
  await claimHandle(OWNER, "fronttest", "Quiet Oven Front", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFront00001", true);
  await setSubscription(OWNER, { customerId: "cus_front00001", subscriptionId: "sub_front00001", active: true, tier: "creator", period: paidPeriod() });
  const ids: string[] = [];
  for (const [title, display] of [["Starter Loaf Guide", "button"], ["Rye Week", "callout"], ["Crust Notes", "preview"]] as const) {
    const made = await addProduct(OWNER, title, "A synthetic product.", "19", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    await setProductAbout(OWNER, made.product.id, true);
    if (display !== "button") {
      await setProductImage(OWNER, made.product.id, { path: `images/${"a".repeat(24)}/${"c".repeat(32)}.jpg`, width: 1200, height: 800, alt: "A loaf", bytes: 1, small: null });
      await setProductDisplay(OWNER, made.product.id, display);
    }
    ids.push(made.product.id);
  }
  // A title of one letter, with no details (so no "Read more"): the audit's narrowest title link.
  const letter = await addProduct(OWNER, "Q", "", "5", null);
  if (!letter.ok) throw new Error("no product");
  await setProductLink(OWNER, letter.product.id, `https://example.com/${letter.product.id}`);
  const store = (await storeForEmail(OWNER)) as Store;
  const cards: { title: string; links: ReturnType<typeof anchors> }[] = [];
  for (const id of ids) {
    const listing = await readListing(store, id);
    if (!listing) throw new Error("no listing");
    const html = renderToStaticMarkup(createElement(ProductCard, { store, product: listing, related: [], remaining: null, writes: true, selling: true, manageable: false, grid: true }));
    cards.push({ title: listing.title, links: anchors(html) });
  }
  const one = await readListing(store, letter.product.id);
  if (!one) throw new Error("no listing");
  const oneLinks = anchors(renderToStaticMarkup(createElement(ProductCard, { store, product: one, related: [], remaining: null, writes: true, selling: true, manageable: false, grid: true })));

  part("2.5.5: a product's title on its card is a 44 px target, in every card style");
  for (const card of cards) {
    const titles = card.links.filter((a) => /\bst-title-link\b/.test(a.cls));
    is(`"${card.title}": its title link is drawn at least 44 px tall and 44 px wide`, [titles.length, titles.every((a) => square(a.cls))], [1, true]);
  }
  const oneTitle = oneLinks.filter((a) => /\bst-title-link\b/.test(a.cls));
  is("a title of one letter (\"Q\", 13 px wide in the audit) is a 44 × 44 px target too", [oneTitle.length, oneTitle[0]?.text, oneTitle.every((a) => square(a.cls))], [1, "Q", true]);

  part("2.5.5 and 2.4.9: \"Read more\" is 44 px tall and its name says which product it is for");
  for (const card of cards) {
    const more = card.links.filter((a) => a.text === "Read more");
    is(`"${card.title}": one "Read more", at least 44 px tall`, [more.length, more.every((a) => tall(a.cls))], [1, true]);
    is(`"${card.title}": a screen reader hears the product's title with it, after the visible words (2.5.3)`, more[0]?.heard, `Read more: ${card.title}`);
  }

  part("2.5.5: the page's own small links and the questions are 44 px tall");
  const page = readFileSync("app/[handle]/page.tsx", "utf8");
  const css = readFileSync("app/globals.css", "utf8");
  is("the store front's layout is marked, so its rules reach only it", /data-store-layout=""/.test(page), true);
  const footer = rule(css, /\[data-store-layout\] \.st-footer-link:not\(summary, figcaption > \*\)/);
  is("its standalone links (blog, \"Get it again\", affiliates, report, delete, the search's \"Show every product\") are 2.75rem tall", [/display:\s*inline-flex/.test(footer), /min-height:\s*2\.75rem/.test(footer)], [true, true]);
  // Claude 5's review of #2987 (LOW 2): a summary drawn as such a link (the presale's "Or join the waitlist") keeps
  // its disclosure triangle, and a link inside a quote's caption breaks with its sentence.
  const waitlist = rule(css, /\[data-store-layout\] summary\.st-footer-link/);
  is("a summary drawn as such a link stays a list item, 44 px tall by its padding", [/display:/.test(waitlist), /min-height:\s*2\.75rem/.test(waitlist), /calc\(\(2\.75rem - 1lh\) \/ 2\)/.test(waitlist)], [false, true, true]);
  const news = rule(css, /\.st-announce a/);
  // LOW 3: the arrow after the news stays at the end of its sentence, with its space, not a flex item of its own.
  is("the creator's line of news, as a link, is 2.75rem tall without growing the band", [/display:\s*inline-block/.test(news), /min-height:\s*2\.75rem/.test(news), /margin-block:\s*-0\.75rem/.test(news)], [true, true, true]);
  is("and its words and arrow flow as one sentence (no flex)", /display:\s*inline-flex/.test(news), false);
  // In CSS, not as min-h-11 on the summary: tests/tap-targets.test.ts asks such a box to center with flex, which would
  // take away the summary's disclosure triangle.
  const question = rule(css, /\.st-faq > summary/);
  is("each question of the store's FAQ opens from a 44 px row, its words centered in it", [/<details key=\{item\.q\} className="st-card st-faq /.test(page), /min-height:\s*2\.75rem/.test(question), /calc\(\(2\.75rem - 1lh\) \/ 2\)/.test(question)], [true, true, true]);

  part("1.4.6: \"Previous\" and \"Next\" that cannot be pressed are still readable at 7:1");
  const off = rule(css, /\.st-pager-off/);
  is("drawn in the muted color, with no opacity that fades it below 7:1", [/color:\s*var\(--st-muted\)/.test(off), /opacity/.test(off)], [true, false]);
  is("told apart from a pressable one by its dashed edge, not by color (1.4.1)", /border:\s*1px dashed/.test(off), true);
  const muted = THEMES.map((theme) => { const c = lookColours({ theme: theme.id, accent: "#5a36ee" }); return Math.min(contrast(c.muted, c.bg), contrast(c.muted, c.card)); });
  is("the muted color reaches 7:1 on the page and the card in every theme", muted.every((ratio) => ratio >= 7), true);

  part("1.4.8: a line of the store front's sentences is at most 80 characters");
  const measure = css.match(/\[data-store-layout\] :where\(([^)]*)\)\s*\{([^}]*)\}/);
  is("a rule caps its paragraphs, quotes and captions", Boolean(measure && /\bp\b/.test(measure[1]) && /\bblockquote\b/.test(measure[1]) && /\bfigcaption\b/.test(measure[1])), true);
  // A question keeps up to MAX_FAQ_Q (150) characters, and its summary is the whole width of the card.
  is("and the FAQ's questions, which can be 150 characters long", /\bsummary\b/.test(measure?.[1] ?? ""), true);
  is("but not the cards themselves (li), so the grid keeps its columns", /\bli\b/.test(measure?.[1] ?? "li"), false);
  // Claude 5's review of #2987 (MEDIUM 1): a p that is a box, not running text (the promotion band p.st-card, the
  // community card p > a.st-card, the search's p.flex and the cart's total p.flex), keeps the column's whole width.
  const boxes = css.match(/\[data-store-layout\] :where\(p\.flex, p\.grid, p\.st-card, p:has\(> \.st-card\), p\.st-note\)\s*\{([^}]*)\}/);
  is("a p that is a box (flex, grid, a card or holding one) is not capped", /max-width:\s*none/.test(boxes?.[1] ?? ""), true);
  is("and that rule comes after the cap, so it wins at the same weight", css.indexOf(boxes?.[0] ?? "\u0000") > css.indexOf(measure?.[0] ?? "\u0000"), true);
  // Rule 30 from Claude 5's review of #2907: Tailwind v4 puts its utilities in a layer, and a rule in no layer beats any
  // layer, so a block's own max-w-* or mx-* would lose to the cap. In @layer components, the utility wins again.
  const capAt = css.indexOf(measure?.[0] ?? "\u0000");
  const layerOpen = css.lastIndexOf("@layer components {", capAt);
  const layerClose = layerOpen < 0 ? -1 : css.indexOf("\n}\n", layerOpen);
  is("the store front's cap, its boxes and its centering sit in @layer components", layerOpen >= 0 && layerClose > css.indexOf(boxes?.[0] ?? "\u0000") && layerClose > css.search(/\[data-store-layout\] :where\(p\.text-center/), true);
  // 1ch is the width of "0". Characters counted line by line in Chromium by tests/e2e/store-front-audit.mjs at 56ch
  // (build of 06bca7d8d, Geist): a real sentence reached 81 a line (the full store at 200%), words of narrow letters
  // only (i, l, t, f, j, r, s) 126 (the edge store at 1280 px). A line scales with the cap.
  const width = Number(measure?.[2].match(/max-width:\s*(\d+)ch/)?.[1] ?? 999);
  const at = (count: number) => (count * width) / 56;
  is("so a real sentence stays at or under 80 characters a line", at(81) <= 80, true);
  is("and so do words of the narrowest letters", at(126) <= 80, true);
  is("while a real sentence keeps at least 45 characters a line, so the cap does not chop ordinary reading", at(81) >= 45, true);
  is("a centered line stays centered under the cap", /\[data-store-layout\] :where\(p\.text-center, \.text-center > p\)\s*\{[^}]*margin-inline:\s*auto/.test(css), true);
  // Rule 30 from Claude 5's and Claude 2's returns on #2907/#2987: a note box (dashed) keeps the column's width as on the
  // product page, its words capped by its own end padding, not a 34ch box set apart in the middle.
  is("a note box keeps the column's width, as on the product page", /\bp\.st-note\b/.test(boxes?.[0] ?? ""), true);
  is("its words are capped by its own end padding", /\[data-store-layout\] p\.st-note\s*\{[^}]*padding-inline-end:\s*max\(1\.25rem,\s*calc\(100% - 34ch - 1\.25rem\)\)/.test(css), true);
  // Narrower glyphs still exist (an apostrophe is 0.27ch in Geist; a hair space is narrower): no width holds 80 of
  // any glyph without chopping ordinary sentences, so that case and its alternative are recorded, as AX274 asks.
  const programme = readFileSync("docs/accessibility-programme.md", "utf8");
  is("the glyphs narrower than the cap holds are recorded in the programme, with the reason and the alternative", /## Store front lines and the narrowest glyphs/.test(programme), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
