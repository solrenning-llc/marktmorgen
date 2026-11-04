/**
 * A campaign for a creator who ships what they sell (242 [CF5], unit 3;
 * added 2 November 2026), and what no campaign may ever say.
 */
import { readFileSync } from "node:fs";
import { FUNNEL_STARTERS, funnelStarter, starterBeforeLines, starterOutline } from "@/lib/funnel-starters";
import { NICHE_FIT, starterCard } from "@/lib/funnel-starter-catalog";
import { outlineOf, planImport } from "@/lib/funnel-bundle";
import { shipProblem, type ShipCandidate } from "@/lib/shipping";
import { nicheCampaignLabels, startersFeature } from "@/lib/funnel-niche-feature";
import { done, is, part } from "./check";

const starter = funnelStarter("physical-product")!;
// Every string a campaign writes, outside the ids and settings that are never shown.
const HIDDEN = new Set(["id", "ref", "kind", "format", "schema", "slug", "target", "style", "media", "type", "wants", "form"]);
const wordsOf = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => wordsOf(item, out));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) if (!HIDDEN.has(key)) wordsOf(item, out);
  return out;
};
// Everything a campaign writes, brackets and all; and what it says as it stands, outside the parts in [brackets] the creator writes.
const raw = (s: { label: string; hint: string; bundle: unknown; before?: string[] }) => wordsOf([s.label, s.hint, s.bundle, s.before ?? []]).join(" \n ");
const said = (s: { label: string; hint: string; bundle: unknown; before?: string[] }) => raw(s).replace(/\[[^\]]*\]/g, " ");

part("The campaign");
is("it exists, for selling, with one paid product the creator ships", [Boolean(starter), starterCard(starter).goal, starter.bundle.products.map((p) => p.wants)], [true, "sales", ["paid"]]);
is("its page leads to the product, then to what happens next", starter.bundle.steps.map((s) => s.kind), ["page", "product", "page"]);
const page = starter.bundle.pages[0];
is(
  "what comes in the box, size and materials, and questions before ordering",
  page.blocks.map((b) => ("heading" in b ? b.heading : b.kind)),
  ["hero", "What comes in the box", "Size and materials", "Before you order", "cta"],
);
is("no shipping time, date, cost or country is said as it stands", /\d|business day|\bdays?\b|\bweeks?\b|within|overnight|express|tomorrow|ships in|free shipping|worldwide/i.test(said(starter)), false);
const faq = JSON.stringify(page);
is(
  "where it ships, what it costs, when it ships and returns are the creator's own words, from their settings and policy",
  [
    "[Say where you ship and what shipping costs, as your shipping settings say. The product's page and the checkout show both from there.]",
    "[Say when you ship it, in the same words as the note in your shipping settings.]",
    "[Say how returns and exchanges work, as your refund policy says.]",
  ].map((part) => faq.includes(part)),
  [true, true, true],
);
is("a check mark is only beside what is in the box", page.blocks.find((b) => b.kind === "benefits") && JSON.stringify(page.blocks.find((b) => b.kind === "benefits")).includes("not included"), false);

part("What the product's page and the checkout really show");
const product = readFileSync("components/store-product.tsx", "utf8");
const checkout = readFileSync("lib/store-checkout.ts", "utf8");
is("the cost, the countries and the note, from the shipping settings", [product.includes("sw.cost(money(shipping.cents))"), product.includes("sw.shipsTo(shipsToWords("), product.includes("shipping.note")], [true, true, true]);
is("the checkout asks for an address in those countries, with the shipping rate", [checkout.includes("shipping_address_collection[allowed_countries]"), checkout.includes("shipping_options[0][shipping_rate_data]")], [true, true]);

part("Turning shipping on is said before and after it is made");
const [first] = starter.before!;
is("said first in the preview, before the parts to fill in", starterOutline(starter).fill, [first, ...outlineOf(starter.bundle).fill]);
is("and first in the list shown once it is made", starterBeforeLines(starter), [{ level: "fix", text: first }]);
const route = readFileSync("app/api/store/funnel-share/route.ts", "utf8");
is("the route uses both", [route.includes("outline: starterOutline(starter)"), route.includes("lines: [...before, ...result.lines]")], [true, true]);
const plan = planImport(starterOutline(starter), [{ id: "p1", title: "Clay mug", free: false, call: false, draft: false }], { pagesLeft: 10, funnelsLeft: 1, formsLeft: 0 }, { x1: "p1" });
is("the preview says it as something to do, and it does not stop the import", [plan.ok, plan.lines.filter((l) => l.level === "fix" && l.text === first).length], [true, 1]);
is("it names the button in the product's editor", [first.includes("“Ship it: a physical product, sent by you”"), readFileSync("components/shipping-editor.tsx", "utf8").includes("Ship it: a physical product, sent by you")], [true, true]);
// Every reason lib/shipping.ts gives for a product that cannot ship is named, so the creator can choose one that can.
const base: ShipCandidate = { priceCents: 2_000, recurring: null, call: null, options: [], pwyw: null, plan: null, file: null, link: null, course: null, podcast: null, bundle: null };
const cannot: [string, Partial<ShipCandidate>, RegExp][] = [
  ["free", { priceCents: 0 }, /paid/],
  ["membership", { recurring: { interval: "month" } }, /membership/],
  ["call", { call: {} }, /a call/],
  ["pwyw", { pwyw: true }, /price the buyer chooses/],
  ["plan", { plan: {} }, /payment plan/],
  ["delivery", { file: {} }, /file/],
  ["delivery", { link: "x" }, /link/],
  ["delivery", { course: {} }, /course/],
  ["delivery", { podcast: {} }, /podcast/],
  ["delivery", { bundle: {} }, /bundle/],
  ["delivery", { options: [{ file: {} }] }, /file/],
];
is("each product that cannot ship is named in it", cannot.filter(([why, change, words]) => shipProblem({ ...base, ...change }) !== why || !words.test(first)).map(([why]) => why), []);
is("a product that can ship has no problem", shipProblem(base), null);

part("Where it shows");
is("designers and photographers see it, with its line", [NICHE_FIT.designers["physical-product"], nicheCampaignLabels("designers").includes("Sell something you ship")], ["For prints or pieces you make and ship.", true]);
is("not for cooks, until food has its own warnings on labels and ingredients", NICHE_FIT.cooks["physical-product"], undefined);
is("the Funnels page counts and names it", [startersFeature().body.startsWith(`${FUNNEL_STARTERS.length} campaigns`), startersFeature().body.includes("“Sell something you ship”")], [true, true]);

part("What no campaign ever says");
const FORBIDDEN = /less pain|pain relief|\baches?\b|posture|detox|burn fat|fat burn|weight loss|lose weight|\bslim|anti-aging|younger|wrinkle|glowing|\bskin\b|\bcur(e|es|ed|ing)\b|\bheal(s|ed|ing)?\b|clinically|doctor|\bfda\b|proven|guaranteed results?|results? guaranteed|best[- ]?sell|top[- ]?sell|top[- ]rated|most popular|award|★|\bout of 5\b|\b\d(\.\d)? stars?\b|five[- ]stars?|testimonial|#1|number one|as seen on|limited time|ends soon|only \w+ left|hurry/i;
is("no promise of health, beauty or result, no rating, badge or testimonial, no haste, in brackets or out", FUNNEL_STARTERS.filter((s) => FORBIDDEN.test(raw(s))).map((s) => s.id), []);
is(
  "the rule catches what it is for",
  ["Better Posture, Less Pain", "Our best seller", "Rated 4.9 out of 5", "4 stars", "★★★★★", "A detox kit", "Cures headaches", "Look younger", "Most popular", "Award-winning", "Sale ends soon", "[Say it is a best seller]"].map((t) => FORBIDDEN.test(t)),
  Array(12).fill(true),
);
is("and not what it is not for", ["Secure checkout", "a healthy breakfast", "a manicure set", "star anise", "a five-pointed star print"].map((t) => FORBIDDEN.test(t)), [false, false, false, false, false]);
is(
  "no block that shows ratings, quotes, counts or a countdown",
  FUNNEL_STARTERS.filter((s) => s.bundle.pages.some((p) => p.blocks.some((b) => ["reviews", "quotes", "facts", "countdown"].includes(b.kind)))).map((s) => s.id),
  [],
);

done();
