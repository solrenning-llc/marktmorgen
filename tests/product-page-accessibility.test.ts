/**
 * The store's product page for a buyer, held to WCAG 2.2 AAA where a browser
 * audit of every product state found it short (274 [AX1]): the stock line's
 * colour (1.4.6), the size of what is pressed (2.5.5), the length of a line of
 * the platform's own words (1.4.8) and the reviews page's heading (2.4.10,
 * 1.3.1). Measured in Chromium with axe-core on a synthetic store, every state;
 * these checks keep each cause from coming back. They certify nothing else.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCENTS, THEMES, contrast, lookColours } from "@/lib/store-look";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { BuyBox, ClicksBox, WaitlistForm } from "@/components/store-product";
import { AssistReminderBox } from "@/components/assistant-reminder-box";
import { RatingLine, ReviewsSection } from "@/components/review-list";
import { Countdown } from "@/components/countdown";
import type { Summary } from "@/lib/review-summary";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** Every <label> that holds a checkbox, with whether it is drawn at least 44 px tall (min-h-11). */
function checkboxLabels(html: string): { id: string; tall: boolean }[] {
  return [...html.matchAll(/<label([^>]*)>(?:(?!<\/label>)[\s\S])*?<input[^>]*type="checkbox"[^>]*id="([^"]+)"|<label([^>]*)>(?:(?!<\/label>)[\s\S])*?<input[^>]*id="([^"]+)"[^>]*type="checkbox"/g)].map((m) => ({
    id: m[2] ?? m[4],
    tall: /\bmin-h-11\b/.test(m[1] ?? m[3] ?? ""),
  }));
}

async function main(): Promise<void> {
  redis.clear();
  // Stand-ins only, so the forms are drawn as on a store that can sell: nothing is sent anywhere.
  process.env.STRIPE_SECRET_KEY = "sk_test_product_page_a11y";
  process.env.RESEND_API_KEY = "re_test_product_page_a11y";

  part("1.4.6: the creator's color as text keeps 7:1, in every theme and for any color picked");
  const accents = [...ACCENTS.map((a) => a.hex), "#5a36ee", "#ffff00", "#00ffff", "#ffffff", "#000000", "#7f7f7f", "#ff00ff", "#00ff88"];
  let worst = { card: 99, item: 99, bg: 99, at: "" };
  for (const theme of THEMES) {
    for (const accent of accents) {
      const c = lookColours({ theme: theme.id, accent });
      const card = contrast(c.accentText, c.card), item = contrast(c.accentText, c.item), bg = contrast(c.accentText, c.bg);
      if (Math.min(card, item, bg) < Math.min(worst.card, worst.item, worst.bg)) worst = { card, item, bg, at: `${theme.id} ${accent}` };
    }
  }
  is("on the card (the stock line, \"Sold out\", \"Coming soon\")", worst.card >= 7, true);
  is("on an item inside the card", worst.item >= 7, true);
  is("on the page behind the card", worst.bg >= 7, true);
  const violet = lookColours({ theme: "light", accent: "#5a36ee" });
  is("the default violet, measured at 6.56:1 in the browser, now reads at 7:1", contrast(violet.accentText, violet.card) >= 7, true);

  part("2.5.5: every box a buyer checks on the product page is a 44 px target");
  const OWNER = "a11y-test@example.com";
  await claimHandle(OWNER, "a11ytest", "Quiet Oven Test", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestA11y00001", true);
  await setSubscription(OWNER, { customerId: "cus_a11y00001", subscriptionId: "sub_a11y00001", active: true, tier: "creator", period: paidPeriod() });
  const free = await addProduct(OWNER, "Flour Cheat Sheet", "Which flour for which bread.", "0", null);
  const paid = await addProduct(OWNER, "Starter Loaf Guide", "Your first loaf.", "19", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  await setProductLink(OWNER, free.product.id, "https://example.com/free");
  await setProductLink(OWNER, paid.product.id, "https://example.com/paid");
  const store = (await storeForEmail(OWNER)) as Store;
  const freeListing = await readListing(store, free.product.id);
  const paidListing = await readListing(store, paid.product.id);
  if (!freeListing || !paidListing) throw new Error("no listings");
  const freeForm = renderToStaticMarkup(createElement(BuyBox, { store, product: freeListing, related: [], remaining: null, writes: true, selling: true }));
  const freeBoxes = checkboxLabels(freeForm);
  is("the free form has its two boxes (more email, and links in it)", freeBoxes.length, 2);
  is("each is drawn at least 44 px tall", freeBoxes.filter((b) => !b.tall).map((b) => b.id), []);
  const paidForm = renderToStaticMarkup(createElement(BuyBox, { store, product: paidListing, related: [], remaining: null, writes: true, selling: true }));
  const paidBoxes = checkboxLabels(paidForm);
  is("the paid form's boxes (news, links, the start-at-once consent) are each 44 px tall", [paidBoxes.length >= 2, paidBoxes.filter((b) => !b.tall).map((b) => b.id)], [true, []]);
  const waitlist = checkboxLabels(renderToStaticMarkup(createElement(WaitlistForm, { store, product: paidListing, writes: true })));
  is("the waitlist's boxes, when it is coming soon", [waitlist.length, waitlist.filter((b) => !b.tall).map((b) => b.id)], [2, []]);
  const clicks = checkboxLabels(renderToStaticMarkup(createElement(ClicksBox, { id: "k1", label: "Links in it", always: true })));
  const remind = checkboxLabels(renderToStaticMarkup(createElement(AssistReminderBox, { id: "r1", lang: "en", store: "Quiet Oven" })));
  is("the links box and the reminder box, wherever they are drawn", [clicks, remind].map((list) => list.map((b) => b.tall)), [[true], [true]]);

  part("2.5.5: the rating link and the page's own way back are 44 px tall");
  const summary: Summary = { count: 2, stars: 9, visible: 2, hidden: 0, refunded: 0, dist: [0, 0, 0, 1, 1] };
  const rating = renderToStaticMarkup(createElement(RatingLine, { summary, href: "#reviews" }));
  const css = readFileSync("app/globals.css", "utf8");
  const ratingRule = css.match(/a\.rv-line\s*\{([^}]*)\}/)?.[1] ?? "";
  is("the rating is a link to the reviews", rating.startsWith('<a href="#reviews" class="rv-line'), true);
  is("which is at least 2.75rem (44 px) tall", /min-height:\s*2\.75rem/.test(ratingRule), true);
  const page = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  const reviewsPage = readFileSync("app/[handle]/p/[product]/reviews/page.tsx", "utf8");
  const bookPage = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is("\"Everything from …\" under the product is a 44 px target", /className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold"[^>]*>\s*\{w\.everythingFrom/.test(page), true);
  is("\"Back to …\" on its reviews page is a 44 px target", /className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold"[^>]*>\s*\{w\.backTo/.test(reviewsPage), true);
  is("and on a call's booking page", /className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold"[^>]*>\s*\{w\.backTo/.test(bookPage), true);

  part("1.4.8: a line of text on the product page is at most 80 characters");
  const measure = css.match(/\.st-measure :where\(([^)]*)\)\s*\{([^}]*)\}/);
  const capped = (measure?.[1] ?? "").split(",").map((s) => s.trim());
  is("a rule caps the page's paragraphs, definitions, quotes and captions", ["p", "dd", "blockquote", "figcaption"].every((s) => capped.includes(s)), true);
  // A list item of plain text: the long description's and a block's lists, and what an option includes.
  is("and the lines of its lists (the description's, and what an option includes)", [".st-about li", ".st-includes li"].every((s) => capped.includes(s)), true);
  // A question keeps up to MAX_QUESTION (200) characters, an item MAX_ITEM (200), a detail MAX_ITEM_DETAIL (300).
  is("and the FAQ's questions, which can be 200 characters long, without narrowing the row that opens them", capped.includes(".sp-faq summary > span"), true);
  is("and the words of a block's benefits, fit lists, steps, contents and bonuses, each in its own size", [".sp-benefit > span", ".sp-fit-side li > span", ".sp-inside span.block", ".sp-step span.block", ".sp-bonus span.block"].every((s) => capped.includes(s)), true);
  // A card or a row is an li too (a review, "More from", a bundle's row, a call's length button): capped as a box it would
  // stop short of its column. Its words are capped instead, as on the store front.
  is("but not every li, so cards, rows and buttons keep their width", capped.includes("li"), false);
  // 1ch is the width of "0". A line holds the cap divided by its glyphs' width in ch, and ch follows each capped
  // element's own font size, so the count does not depend on the size. Counted line by line in Chromium at 56ch (Geist):
  // the product page's real sentences reached 78 a line; words of narrow letters only (i, l, t, f, j, r, s) reached 126 on
  // the store front, a property of the font, which the product page shares. A line scales with the cap.
  const width = Number(measure?.[2].match(/max-width:\s*(\d+)ch/)?.[1] ?? 999);
  const at = (count: number) => (count * width) / 56;
  is("so a real sentence stays at or under 80 characters a line", at(78) <= 80, true);
  is("and so do words of the narrowest letters", at(126) <= 80, true);
  is("while a real sentence keeps at least 45 characters a line, so the cap does not chop ordinary reading", at(78) >= 45, true);
  is("a centered line stays centered under the cap", /\.st-measure :where\([^)]*\.text-center[^)]*\)\s*\{[^}]*margin-inline:\s*auto/.test(css), true);
  // A box that centers its words with text-align (the countdown, a "By the numbers" card) but whose capped lines sit
  // at the left of it would draw them off its middle: the countdown's "Until …" ended about 100 px left of its numbers.
  const centered = (css.match(/\.st-measure :where\(([^)]*)\)\s*\{\s*margin-inline:\s*auto/)?.[1] ?? "").split(",").map((s) => s.trim());
  is("the countdown's heading, its \"Until …\" and its note are centered under the cap, like its numbers", centered.includes(".sp-countdown > p"), true);
  is("and so is a \"By the numbers\" figure in its card", centered.includes(".sp-fact > dd"), true);
  const countdown = renderToStaticMarkup(createElement(Countdown, { until: 2_000_000_000, now: 1_900_000_000, heading: "Doors close soon", note: "Seats are kept for a week." }));
  // Each <p> is a direct child of the countdown's box, so ".sp-countdown > p" reaches every one of them.
  let depth = 0;
  const pAt: number[] = [];
  for (const tag of countdown.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (tag[1]) depth--;
    else {
      if (tag[2] === "p") pAt.push(depth);
      depth++;
    }
  }
  is("the countdown is the box that centers them, with its words as its own paragraphs", [countdown.startsWith('<div class="sp-countdown"'), pAt], [true, [1, 1]]);
  is("and a figure is the dd of its card", /<div key=\{fact\.key\} className="sp-fact">\s*<dt[^>]*>[^<]*<\/dt>\s*<dd>/.test(readFileSync("components/sales-blocks.tsx", "utf8")), true);
  is("the product page, its reviews page and a call's booking page use it", [/<main id="content" className=\{`st-measure /.test(page), /<main id="content" className="st-measure /.test(reviewsPage), /<main id="content" className="st-measure /.test(bookPage)], [true, true, true]);
  // Narrower glyphs still exist (an apostrophe is 0.27ch in Geist): no width holds 80 of any glyph without chopping
  // ordinary sentences, so that case and its alternative are recorded, as AX274 asks.
  const programme = readFileSync("docs/accessibility-programme.md", "utf8");
  const section = programme.match(/## Store front lines and the narrowest glyphs[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  is("the glyphs narrower than the cap holds are recorded in the programme, for the product page too", [section.length > 0, /\.st-measure/.test(section), /product page/.test(section)], [true, true, true]);

  part("2.4.10 and 1.3.1: the reviews page has one level-one heading");
  const own = renderToStaticMarkup(createElement(ReviewsSection, { heading: "Reviews of Rye Week", summary, reviews: [], storeName: "Quiet Oven", productTitle: "Rye Week", moreHref: null, level: 1 }));
  const within = renderToStaticMarkup(createElement(ReviewsSection, { heading: "", summary, reviews: [], storeName: "Quiet Oven", productTitle: "Rye Week", moreHref: null }));
  is("as a page of its own, its heading is the h1", [own.includes("<h1 "), own.includes("<h2 ")], [true, false]);
  is("inside the product page it stays an h2", [within.includes("<h2 "), within.includes("<h1 ")], [true, false]);
  is("the reviews page asks for the h1", /<ReviewsSection[\s\S]*?level=\{1\}/.test(reviewsPage), true);

  // Claude 5's second review of #2907 (6704784993).
  part("1.4.8, MEDIUM: the 34ch cap is on words, never on a p drawn as a box or a row, and a utility still wins over it");
  const capAt = css.search(/\.st-measure :where\(p, dd/);
  const layerOpen = css.lastIndexOf("@layer components {", capAt);
  const layerClose = layerOpen < 0 ? -1 : css.indexOf("\n}\n", layerOpen);
  // Tailwind v4 puts its utilities in @layer utilities; a rule in no layer beats any layer, so a block's own max-w-*,
  // mx-* or ml-* would lose to the cap. In @layer components, the utility wins again.
  is("the cap and its centering sit in @layer components, so a block's own utility still wins", layerOpen >= 0 && layerClose > capAt && layerClose > css.search(/\.st-measure :where\(p\.text-center/), true);
  const boxes = css.match(/\.st-measure :where\(p\.flex, p\.grid, p\.st-note, p\.rounded-2xl\)\s*\{([^}]*)\}/);
  is("a p that is a box or a row (flex, grid, a dashed note, a rounded notice) keeps its width", /max-width:\s*none/.test(boxes?.[1] ?? ""), true);
  is("and that rule comes after the cap", css.indexOf(boxes?.[0] ?? "\u0000") > capAt, true);
  const noteWords = css.match(/\.st-measure p\.st-note\s*\{([^}]*)\}/)?.[1] ?? "";
  const notice = css.match(/\.st-measure p\.rounded-2xl\s*\{([^}]*)\}/)?.[1] ?? "";
  is("a note box's words are capped by its own padding, the box at full width", /padding-inline-end:\s*max\(1\.25rem,\s*calc\(100% - 34ch - 1\.25rem\)\)/.test(noteWords), true);
  is("and so are a rounded notice's (the package and the chosen time)", /padding-inline-end:\s*max\(1rem,\s*calc\(100% - 34ch - 1rem\)\)/.test(notice), true);

  // Claude 5's focal return on #2907 (6704971308), confirmed open by Claude 2 (6707750064).
  part("1.4.8, LOW: the note's end padding is on a p only, so a centered div.st-note stays in the middle");
  is("no end padding on every .st-note inside the cap", /\.st-measure \.st-note\s*\{/.test(css), false);
  is("the end padding sits on p.st-note, as on p.rounded-2xl", /\.st-measure p\.st-note\s*\{[^}]*padding-inline-end:\s*max\(1\.25rem,\s*calc\(100% - 34ch - 1\.25rem\)\)/.test(css), true);

  part("1.4.11, LOW: the reader's own chat bubble keeps a visible edge on the card");
  const dmMine = css.match(/\.cm-dm-mine\s*\{([^}]*)\}/)?.[1] ?? "";
  const chatMine = css.match(/\.st-chat-mine\s*\{([^}]*)\}/)?.[1] ?? "";
  is("the community DM bubble's border is drawn in the accent text color, never transparent", [/border-color:\s*transparent/.test(dmMine), /border-color:\s*var\(--st-accent-text\)/.test(dmMine)], [false, true]);
  is("the store chat's own bubble has the same 1px edge", /border:\s*1px solid var\(--st-accent-text\)/.test(chatMine), true);

  part("1.4.6, LOW 1: text in the creator's color keeps 7:1 on the soft accent and on the band too");
  let soft = 99, band = 99;
  for (const theme of THEMES) {
    for (const accent of accents) {
      const c = lookColours({ theme: theme.id, accent });
      soft = Math.min(soft, contrast(c.accentText, c.accentSoft));
      band = Math.min(band, contrast(c.accentText, c.band));
    }
  }
  is("on the soft accent (the buyer's own chat bubble, an icon's disc, a picked pill)", soft >= 7, true);
  is("on the band", band >= 7, true);

  part("2.5.5, LOW 2: the cart panel's own controls are 44 px");
  const cart = readFileSync("components/store-cart.tsx", "utf8");
  is("each line's remove button is 44 × 44 px", /className="grid h-11 w-11 place-items-center rounded-full"/.test(cart), true);
  // main made it 44 × 44 px and gives the focus back to the button that opened the panel (store-cart.tsx).
  is("the panel's Close is 44 px tall", /className="st-footer-link inline-flex min-h-11 [^"]*items-center[^"]*"\s*onClick=\{\(\) => \{\s*setOpen\(false\);/.test(cart), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
