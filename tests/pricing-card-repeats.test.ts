/**
 * 243 [CF6], the owner's complement of 31/10/2026 23h14: the pricing cards say
 * each figure once, the terms once under the three cards, and nothing on Store
 * is marked as included that only Studio and Scale have
 * (components/home-parts.tsx, app/pricing/page.tsx). The browser check of the
 * first screen at 1280 x 720 is in tests/e2e/pricing.mjs.
 *
 * What fails here:
 *   - a plan's figure (visits, orders, list emails, AI writing jobs, visitor
 *     answers, storage) said twice in what a card shows, outside its itemized
 *     list, which is closed until pressed;
 *   - a line with a check mark on Store for something only Studio and Scale have;
 *   - the terms, the "not open yet" line or the upload, storage and data-room
 *     paragraphs repeated in each card;
 *   - a figure no longer written anywhere on the card;
 *   - the plans no longer first on the page, before the tools and the comparison.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "@/components/home-parts";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { ANSWERS_MONTHLY } from "@/lib/answers-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { PLAN_TITLES, TIERS, monthlyEmails } from "@/lib/plan";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { VISITS_INCLUDED } from "@/lib/traffic-rules";
import { done, is, part } from "./check";

const n = (x: number) => new Intl.NumberFormat("en-US").format(x);
const html = renderToStaticMarkup(createElement(Pricing));
const cards = html.split(/(?=<div[^>]*data-pricing-card)/).slice(1).map((chunk) => chunk.split(/<section[^>]*data-plan-terms/)[0]);
const shown = (card: string) => card.replace(/<details[\s\S]*?<\/details>/g, " ").replace(/<template[\s\S]*?<\/template>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
const itemized = (card: string) => (card.match(/<details[\s\S]*?<\/details>/)?.[0] ?? "").replace(/<[^>]+>/g, " ");
/** How often a figure is said: the number, with or without the words it counts ("80 GB", "80 AI writing jobs"). */
/** A piece of text as a regular expression that matches only itself, every special character escaped (backslash included). */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (text: string, figure: string) => {
  const [number, ...unit] = figure.split(" ");
  const same = new RegExp(`(?<![\\d,.])${literal(number)}(?![\\d,])\\s+${literal(unit.join(" "))}`, "g");
  // A figure is also repeated when its number comes back with a unit word of the same thing ("up to 7,000 sends").
  const again = new RegExp(`(?<![\\d,.])${literal(number)}(?![\\d,])\\s+(?:${literal(unit[0] ?? "")}|sends|emails|jobs|answers)`, "g");
  return Math.max((text.match(same) ?? []).length, (text.match(again) ?? []).length);
};

part("Three cards, each saying each figure once");
is("three cards", cards.length, 3);
TIERS.forEach((tier, i) => {
  const text = shown(cards[i]);
  // Each figure with what it counts: Studio's 40 AI writing jobs and 40 GB are two figures, each said once.
  const figures = [`${n(VISITS_INCLUDED[tier])} visits`, `${n(ORDERS_INCLUDED[tier])} orders`, ...(monthlyEmails(tier) ? [`${n(monthlyEmails(tier))} list emails`] : []), ...(AI_MONTHLY[tier] ? [`${n(AI_MONTHLY[tier])} AI writing jobs`, `${n(ANSWERS_MONTHLY[tier])} visitor answers`] : []), `${PAID_STORAGE_BYTES[tier] / 1024 ** 3} GB`];
  for (const figure of figures) is(`${PLAN_TITLES[tier]}: ${figure} shown once`, count(text, figure), 1);
  is(`${PLAN_TITLES[tier]}: "0% of sales" once`, text.split("0% of sales").length - 1 + (text.split("0% of your sales").length - 1), 1);
  is(`${PLAN_TITLES[tier]}: no terms block, no "not open" line, no upload or data-room paragraph in the card`, [/First charge|Money back|Canceling/.test(text), /not open yet|not on sale yet|Not yet\./i.test(text), /upload starts|data room/i.test(text)], [false, false, false]);
  is(`${PLAN_TITLES[tier]}: the upload, storage and data-room details are in its itemized list`, [/upload steps/i.test(itemized(cards[i])), /stored files and videos/.test(itemized(cards[i])), /data room/.test(itemized(cards[i]))], [true, true, true]);
});

part("Store marks as included only what it has");
const store = cards[0];
const checked = [...store.matchAll(/<li class="flex gap-2">([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").trim());
is("no check-marked line about Studio and Scale", checked.filter((line) => /Studio and Scale|on Studio/.test(line)), []);
is("what Store does not have is said plainly, without a check mark", /data-not-on-plan[^>]*>The Store plan does not include email to your list or AI writing\. Studio and Scale do\./.test(store.replace(/&#x27;/g, "'")), true);
is("the upload allowance in plain words, in the same GB as storage", [/upload starts|newly authorized/.test(itemized(cards[0])), /up to \d[\d,]* files and 5 GB in all/.test(itemized(cards[0]))], [false, true]);

part("The terms once, under the three cards; the plans first on the page");
is("one terms block, after the cards", [(html.match(/data-plan-terms/g) ?? []).length, html.indexOf("data-plan-terms") > html.lastIndexOf("data-pricing-card")], [1, true]);
const page = readFileSync("app/pricing/page.tsx", "utf8");
is("the plans come before the tools and the comparison", page.indexOf('id="plans"') < page.indexOf('<PricingValue place="plans"'), true);
is("the closed-selling line is said once on the page, above the plans", (page.match(/not open yet/g) ?? []).length, 1);
// The link keeps the line's own color, which keeps 7:1 on the hero's sky (WebKit, 320 and 390, failed before).
is("the live demo is linked whether or not plans are open, in the line's own color", /PRICING_OPEN \? <> <Link className="underline \[color:inherit\]" href="\/demo">/.test(page) && /not open yet[^<]*<Link className="underline \[color:inherit\]" href="\/demo">/.test(page), true);
done();
