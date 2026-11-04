import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * A PROPOSAL, not a change (18 October 2026), superseded the same day at
 * 11:21 by the owner's decision to set prices instead (lib/plan.ts): at the
 * price list every plan keeps 60% at today's limits, so no cut is proposed
 * any more and the tables below show it. For each base plan, the
 * smallest set of cuts to the printed limits (visits, orders, video hours,
 * storage, AI drafts and answers, emails) that would bring it to 60% at the
 * sizing reading of lib/receiving-costs.ts; the Store assistant's input cap
 * that would; and the AI captions price that would. No figure in code is
 * changed by any of this: every "today" figure below is read from the
 * constants the product enforces.
 *
 * `node scripts/limits-proposal.mjs` writes docs/limits-proposal-2026-10-18.md
 * from renderLimitsProposal(); tests/limits-proposal.test.ts fails when the
 * file on disk is not what this renders.
 */
import { PLAN_PRICES, PLAN_TITLES, TIERS, monthlyEmails, type Cycle, type Tier } from "@/lib/plan";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { VISITS_INCLUDED } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { ANSWERS_MONTHLY } from "@/lib/answers-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import {
  ADD_ON_ROOM_CENTS, ASSISTANT_FACTS_BYTES, ASSISTANT_INPUT_BYTES, ASSISTANT_MESSAGES_MONTHLY, ASSISTANT_MODEL, ASSISTANT_PRICE_CENTS, ASSISTANT_PRODUCTS, ASSISTANT_REQUEST_SHAPE, assistantMessageExtraMicroUsd,
} from "@/lib/store-assistant-rules";
import { CENTS_PER_MINUTE, MAX_AUTO_LANGUAGES, MAX_AUTO_MINUTES, MIN_CENTS } from "@/lib/auto-captions-rules";
import { SIZING_READING, unitUnder } from "./historical-margin-model";
import { COST_LINES, GB, STORAGE_PER_GB, perPaymentCost } from "./plan-cost-registry";

/** The printed lines, in the order cuts are proposed: least likely to be reached, and least generous at competitors, first. */
export const ORDER = ["ai", "video", "storage", "orders", "store-email", "transactional-email", "list-email", "visits"] as const;
export type Printed = (typeof ORDER)[number];
/** No printed figure is proposed below this share of today's. */
export const FLOOR_SHARE = 0.1;

const NAMES: Record<Printed, string> = {
  ai: "AI drafts / answers a month",
  video: "Video hours watched a month",
  storage: "Storage",
  orders: "Orders a month",
  "store-email": "Store emails a month",
  "transactional-email": "Access emails a month",
  "list-email": "List emails a month",
  visits: "Visits a month",
};

/** Today's figure of each printed line, as the product enforces it. AI is writing jobs and answers, cut together. */
export function figures(tier: Tier): Record<Printed, number[]> {
  return {
    ai: [AI_MONTHLY[tier], ANSWERS_MONTHLY[tier]],
    video: [PAID_VIDEO_HOURS[tier]],
    storage: [PAID_STORAGE_BYTES[tier]],
    orders: [ORDERS_INCLUDED[tier]],
    "store-email": [STORE_ALLOWANCES[tier].email],
    "transactional-email": [STORE_ALLOWANCES[tier].transactional],
    "list-email": [monthlyEmails(tier)],
    visits: [VISITS_INCLUDED[tier]],
  };
}

const lineUsd = (tier: Tier, id: string) => COST_LINES.find((line) => line.id === id)!.monthlyUsd(tier);
/** What the plan's storage adds to what a store keeps after its plan ends (tests/plan-cost-registry.ts, retained-files). */
const retainedStorageUsd = (tier: Tier) => (PAID_STORAGE_BYTES[tier] / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
const months = (cycle: Cycle) => (cycle === "year" ? 12 : 1);
const centsUp = (usd: number) => Math.ceil(Math.round(usd * 1e7) / 1e5);

/** A plan's usage at full use, in cents, with each printed line's figures scaled by its share (1 is today). */
export function usageCents(tier: Tier, cycle: Cycle, share: Partial<Record<Printed, number>>): number {
  let monthly = COST_LINES.reduce((sum, line) => sum + line.monthlyUsd(tier), 0);
  for (const id of ORDER) monthly -= lineUsd(tier, id) * (1 - (share[id] ?? 1));
  // A store's signals that are not a page are SIGNALS_PER_VISIT for each visit of its figure (lib/traffic-rules.ts,
  // signalLimitFor): they follow the visits line wherever it is put (4 November 2026).
  monthly -= lineUsd(tier, "signals") * (1 - (share.visits ?? 1));
  // Only the plan's storage is taken off what is kept after the end; anything else a cut might save there is left in, so a proposal never counts on it.
  const after = perPaymentCost(tier) - retainedStorageUsd(tier) * (1 - (share.storage ?? 1));
  return centsUp(months(cycle) * monthly + after);
}

/** Round a proposed figure down to something a page can print: two significant figures, half a GiB, whole hours. */
export function tidy(id: Printed, value: number): number {
  if (id === "storage") return Math.max(GB / 2, Math.floor(value / (GB / 2)) * (GB / 2));
  if (id === "video") return Math.max(1, Math.floor(value));
  if (value < 10) return Math.max(1, Math.floor(value));
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.floor(value / step) * step;
}

export type Proposal = {
  tier: Tier; cycle: Cycle; priceCents: number;
  todayNetBps: number; roomCents: number;
  /** The figures proposed, line by line; a line left as it is keeps today's. */
  proposed: Record<Printed, number[]>;
  cut: Printed[];
  feasible: boolean;
  netBps: number;
  /** With every printed line at its floor, and at zero: whether a printed cut can ever be enough. */
  atFloorBps: number; atZeroBps: number;
  /** The one factor that, applied to every printed line alike, would reach 60% (null when even zero would not). */
  uniformShare: number | null;
};

function shareOf(today: number[], proposed: number[]): number {
  const i = today.findIndex((n) => n > 0);
  return i < 0 ? 1 : proposed[i] / today[i];
}

export function propose(tier: Tier, cycle: Cycle, priceCents: number): Proposal {
  const unit = (share: Partial<Record<Printed, number>>) => unitUnder(priceCents, usageCents(tier, cycle, share), SIZING_READING, true);
  const today = figures(tier);
  const all = (s: number) => Object.fromEntries(ORDER.map((id) => [id, s])) as Record<Printed, number>;
  const atFloor = unit(all(FLOOR_SHARE));
  const atZero = unit(all(0));
  const fits = (s: Record<Printed, number>) => unit(s).meetsFloor;
  // A proposal is judged at the figures a page would print, rounded down (and never below one hour or half a GiB).
  const tidyShares = (s: Record<Printed, number>) => Object.fromEntries(ORDER.map((id) => [id, s[id] >= 1 ? 1 : shareOf(today[id], today[id].map((n) => (n > 0 ? tidy(id, n * s[id]) : n)))])) as Record<Printed, number>;
  const fitsTidied = (s: Record<Printed, number>) => unit(tidyShares(s)).meetsFloor;
  // The smallest set, in ORDER: each line down to its floor until the next one, cut only as far as needed, closes the gap.
  const share: Record<Printed, number> = all(1);
  const cut: Printed[] = [];
  let feasible = fits(share);
  for (const id of ORDER) {
    if (feasible) break;
    if (today[id].every((n) => n === 0)) continue;
    cut.push(id);
    share[id] = FLOOR_SHARE;
    if (fitsTidied(share)) {
      let lo = FLOOR_SHARE, hi = 1;
      for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; share[id] = mid; if (fitsTidied(share)) lo = mid; else hi = mid; }
      share[id] = lo;
      feasible = true;
    }
  }
  const proposed = Object.fromEntries(ORDER.map((id) => [id, today[id].map((n) => (cut.includes(id) && n > 0 ? tidy(id, n * share[id]) : n))])) as Record<Printed, number[]>;
  const tidied = Object.fromEntries(ORDER.map((id) => [id, shareOf(today[id], proposed[id])])) as Record<Printed, number>;
  const result = unit(tidied);
  let uniformShare: number | null = null;
  if (atZero.meetsFloor) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (fits(all(mid))) lo = mid; else hi = mid; }
    uniformShare = lo;
  }
  return {
    tier, cycle, priceCents, todayNetBps: unit({}).netBps, roomCents: unit({}).usageRoomCents,
    proposed, cut, feasible: feasible && result.meetsFloor, netBps: result.netBps, atFloorBps: atFloor.netBps, atZeroBps: atZero.netBps, uniformShare,
  };
}

/** Since 18 October 2026 one price list (lib/plan.ts): published and on sale are the same. */
export function proposals(): Proposal[] {
  return TIERS.flatMap((tier) => (["month", "year"] as const).map((cycle) => propose(tier, cycle, PLAN_PRICES[tier][cycle])));
}

/** The Store assistant at an input cap: whether its month keeps 60%, and with its 25-cent room. */
export function assistantAt(inputBytes: number): { meets: boolean; withRoom: boolean; netBps: number; aiCents: number } {
  const hold = aiRequestHoldMicroUsd(ASSISTANT_MODEL, { ...ASSISTANT_REQUEST_SHAPE, inputBytes })!;
  const aiCents = Math.ceil((ASSISTANT_MESSAGES_MONTHLY * (hold + assistantMessageExtraMicroUsd())) / 10_000);
  const u = unitUnder(ASSISTANT_PRICE_CENTS, aiCents, SIZING_READING, true);
  return { meets: u.meetsFloor, withRoom: u.meetsFloor && u.usageRoomCents - aiCents >= ADD_ON_ROOM_CENTS, netBps: u.netBps, aiCents };
}
/** The largest input cap, in bytes, that keeps 60% (with the room when asked). */
export function assistantInputCap(withRoom: boolean): number {
  let lo = 0, hi = 16 * ASSISTANT_INPUT_BYTES;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); const a = assistantAt(mid); if (withRoom ? a.withRoom : a.meets) lo = mid; else hi = mid - 1; }
  return lo;
}

/** AI captions: the worst net over every length and number of languages, at a price per minute and a minimum. */
export function captionsWorstBps(perMinute: number, minimum: number): number {
  let worst = Infinity;
  for (let languages = 1; languages <= MAX_AUTO_LANGUAGES; languages += 1) for (let minutes = 1; minutes <= MAX_AUTO_MINUTES; minutes += 1) {
    const price = Math.max(minimum, minutes * languages * perMinute);
    worst = Math.min(worst, unitUnder(price, minutes * (languages + 1) * 10, SIZING_READING, true).netBps);
  }
  return worst;
}
/** Whether a price per minute alone, with no minimum, keeps 60% on the longest video: a longer one spreads the fixed fees thinner, so this is where the price per minute is tested. */
export function perMinuteHolds(perMinute: number): boolean {
  for (let languages = 1; languages <= MAX_AUTO_LANGUAGES; languages += 1) {
    if (!unitUnder(MAX_AUTO_MINUTES * languages * perMinute, MAX_AUTO_MINUTES * (languages + 1) * 10, SIZING_READING, true).meetsFloor) return false;
  }
  return true;
}
/** The lowest price per minute (whole cents) that keeps 60% on the longest video, and the lowest minimum (25-cent steps) that then keeps every shorter one. */
export function captionsPrice(): { perMinute: number; minimum: number } {
  let perMinute = 1;
  while (!perMinuteHolds(perMinute)) perMinute += 1;
  let minimum = 25;
  while (captionsWorstBps(perMinute, minimum) < 6_000) minimum += 25;
  return { perMinute, minimum };
}
/** The lowest minimum (25-cent steps) that keeps every length at 60% for a price per minute that holds on the longest video. */
export function captionsMinimumFor(perMinute: number): number {
  let minimum = 25;
  while (captionsWorstBps(perMinute, minimum) < 6_000) minimum += 25;
  return minimum;
}
/** Prices per minute shown with the minimum each needs, from the lowest that holds. */
export function captionsOptions(): { perMinute: number; minimum: number }[] {
  const lowest = captionsPrice().perMinute;
  return [lowest, 450, 500, 600, 800, 1_000].filter((p, i, all) => p >= lowest && all.indexOf(p) === i).map((perMinute) => ({ perMinute, minimum: captionsMinimumFor(perMinute) }));
}
/** At today's price per minute, whether raising only the minimum charge could keep 60%: no, when the longest video misses on its price per minute. */
export function captionsTodayAnyMinimum(): boolean {
  return perMinuteHolds(CENTS_PER_MINUTE);
}

// ----------------------------------------------------------------- the document

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pctOf = (bps: number) => `${bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;
const count = (n: number) => n.toLocaleString("en-US");
function figureWords(id: Printed, values: number[]): string {
  if (id === "storage") return `${(values[0] / GB).toLocaleString("en-US", { maximumFractionDigits: 1 })} GiB`;
  if (id === "ai") return `${count(values[0])} / ${count(values[1])}`;
  return count(values[0]);
}

/** Competitors' published limits, each with its source and the day it was read. Nothing is said that their page does not show. */
export const COMPETITORS = [
  {
    name: "ClickFunnels Launch ($97 a month, $970 a year)",
    figures: "10,000 contacts; 50,000 emails a month; unlimited visitors advertised; 1M AI words advertised (period not established); no figure for orders, storage or video hours established.",
    source: "support.myclickfunnels.com/docs/clickfunnels-pricing/, page updated 12 October 2026, read 17 October 2026 (docs/clickfunnels-implementation-baseline.md, S01).",
  },
  {
    name: "Kajabi Basic $179, Growth $249, Pro $499 a month",
    figures: "Contacts 2,500 / 25,000 / 100,000; marketing emails \"Unlimited\" on all three; products 5 / 50 / unlimited; AI credits 0 / 500 / 1,000. The page shows no figure for bandwidth, video hours or storage. (Its annual column shows $143 / $199 / $399 a month next to \"billed annually\" at $179 / $249 / $499; the page does not say which applies.)",
    source: "kajabi.com/pricing, read 18 October 2026.",
  },
  {
    name: "Stan Creator $29 ($300 a year), Creator Pro $99 ($948 a year)",
    figures: "0% transaction fees; the FAQ says unlimited products to unlimited customers on either plan; Creator Pro includes \"unlimited emails\" (email broadcasts and flows on Creator Pro only). No figure for contacts, storage, visits, orders, video hours or AI.",
    source: "Stan's own article \"Stan Store Pricing\", stan.store/blog/stan-store-pricing/, last updated July 22, 2026, read 18 October 2026 (docs/value-presentation-2026-10-18.md).",
  },
] as const;

/** How each printed line compares, in the competitor readings above. */
export const COMPARE: Record<Printed, string> = {
  ai: "Kajabi: 0 / 500 / 1,000 AI credits; ClickFunnels Launch: 1M AI words (other units). Competitors give none on their entry plans.",
  video: "No competitor above publishes a figure for video watched.",
  storage: "No competitor above publishes a figure.",
  orders: "No competitor above publishes a figure for orders.",
  "store-email": "No competitor above publishes a figure for these.",
  "transactional-email": "No competitor above publishes a figure for these.",
  "list-email": "ClickFunnels Launch 50,000 a month; Kajabi \"Unlimited\"; Stan Creator Pro \"unlimited emails\". Competitors are far more generous.",
  visits: "ClickFunnels advertises unlimited visitors; Kajabi shows no bandwidth figure. Competitors do not limit it.",
};

export function renderLimitsProposal(plansOnSale: boolean, captionsOnSale: boolean): string {
  const out: string[] = [];
  out.push("# Limits proposal, 18 October 2026 — a PROPOSAL, nothing here is in force");
  out.push("");
  out.push("<!-- Generated by `node scripts/limits-proposal.mjs` from tests/limits-proposal-table.ts. Do not edit by hand: tests/limits-proposal.test.ts fails when this file is stale. -->");
  out.push("");
  out.push("Superseded the same day: on 18 October 2026 at 11:21 the owner decided to change prices rather than cut limits (lib/plan.ts, docs/value-presentation-2026-10-18.md). This document now shows that at the price list no cut is needed. No limit in code is changed by this document. It answered one question for the owner: under the aligned receiving model (lib/receiving-costs.ts, docs/margin-alignment-2026-10-18.md), what is the smallest set of cuts to the PRINTED limits (visits, orders, video hours, storage, AI drafts and answers, emails) that would bring each base plan to 60% net at the sizing reading, every allowance used in full, the commission counted as zero?");
  out.push("");
  out.push("## How the cuts are chosen");
  out.push("");
  out.push(`Lines are cut in this order, each down to at most ${FLOOR_SHARE * 100}% of today's figure (never below one hour of video or half a GiB of storage) before the next one is touched, and the last one only as far as needed: ${ORDER.map((id) => NAMES[id]).join(" → ")}. First come the lines a store is least likely to reach in full and where competitors give less or nothing (AI on entry plans, video watched, storage); then orders and the emails that go with them; then list emails and visits, which competitors give far more generously or do not limit at all. A proposed figure is rounded down to two significant figures (storage to half a GiB, video to whole hours) and the plan is computed again at the rounded figures. Each line's cost is linear in its figure; only storage's share of what a store keeps after its plan ends is taken off with it, so the proposal never counts on a saving it cannot show.`);
  out.push("");
  for (const title of ["The price list since 18 October 2026, 11:21 (no commission)"]) {
    const rows = proposals();
    out.push(`## ${title}`);
    out.push("");
    out.push(`| Line | ${rows.map((p) => `${PLAN_TITLES[p.tier]} ${p.cycle === "year" ? "yearly" : "monthly"} ($${p.priceCents / 100})`).join(" | ")} |`);
    out.push(`| --- | ${rows.map(() => "---").join(" | ")} |`);
    out.push(`| Net today | ${rows.map((p) => pctOf(p.todayNetBps)).join(" | ")} |`);
    for (const id of ORDER) {
      out.push(`| ${NAMES[id]} | ${rows.map((p) => {
        const today = figures(p.tier)[id];
        if (today.every((n) => n === 0)) return "none today";
        return p.cut.includes(id) && p.feasible ? `${figureWords(id, today)} → **${figureWords(id, p.proposed[id])}**` : figureWords(id, today);
      }).join(" | ")} |`);
    }
    out.push(`| Net with the cuts | ${rows.map((p) => (p.feasible ? `**${pctOf(p.netBps)}**` : "not reachable")).join(" | ")} |`);
    out.push(`| Every printed line at ${FLOOR_SHARE * 100}% / at zero | ${rows.map((p) => `${pctOf(p.atFloorBps)} / ${pctOf(p.atZeroBps)}`).join(" | ")} |`);
    out.push(`| Or every printed line cut alike to | ${rows.map((p) => (p.uniformShare === null ? "none reaches 60%" : `${pctOf(Math.floor(p.uniformShare * 10_000))} of today`)).join(" | ")} |`);
    out.push("");
    const unreachable = rows.filter((p) => !p.feasible);
    if (unreachable.length) {
      out.push(`Not reachable by printed cuts within the ${FLOOR_SHARE * 100}% floor: ${unreachable.map((p) => `${PLAN_TITLES[p.tier]} ${p.cycle === "year" ? "yearly" : "monthly"} (${p.atZeroBps >= 6_000 ? "only below the floor" : `even with every printed line at zero it keeps ${pctOf(p.atZeroBps)}: its hidden lines and receiving alone take more than the floor leaves`})`).join("; ")}.`);
      out.push("");
    }
  }
  out.push("## How each line compares");
  out.push("");
  out.push("| Line | Competitors' published figures |");
  out.push("| --- | --- |");
  for (const id of ORDER) out.push(`| ${NAMES[id]} | ${COMPARE[id]} |`);
  out.push("");
  out.push("Sources:");
  out.push("");
  for (const c of COMPETITORS) out.push(`- **${c.name}**: ${c.figures} Source: ${c.source}`);
  out.push("");
  const meets = assistantInputCap(false), room = assistantInputCap(true);
  const rest = ASSISTANT_INPUT_BYTES - ASSISTANT_FACTS_BYTES;
  const perProduct = ASSISTANT_FACTS_BYTES / ASSISTANT_PRODUCTS;
  const factsAt = (cap: number) => Math.max(0, cap - rest);
  out.push("## Store assistant: the input cap that would keep 60%");
  out.push("");
  out.push(`Today each reply may send the model ${count(ASSISTANT_INPUT_BYTES)} bytes (lib/store-assistant-rules.ts, ASSISTANT_INPUT_BYTES), of which ${count(ASSISTANT_FACTS_BYTES)} are the store's facts; at ${usd(ASSISTANT_PRICE_CENTS)} a month and ${count(ASSISTANT_MESSAGES_MONTHLY)} replies the add-on keeps ${pctOf(assistantAt(ASSISTANT_INPUT_BYTES).netBps)}${assistantAt(ASSISTANT_INPUT_BYTES).withRoom ? ", with its room: no cut to the input is proposed" : ""}. The rows below are the largest caps the price would carry.`);
  out.push("");
  out.push(`| Input cap | Of which the store's facts | About how many of the ${ASSISTANT_PRODUCTS} products read, at today's average of ${Math.round(perProduct)} bytes each | Net |`);
  out.push("| --- | --- | --- | --- |");
  out.push(`| ${count(ASSISTANT_INPUT_BYTES)} (today) | ${count(ASSISTANT_FACTS_BYTES)} | ${ASSISTANT_PRODUCTS} | ${pctOf(assistantAt(ASSISTANT_INPUT_BYTES).netBps)} |`);
  out.push(`| ${count(meets)} (the largest that keeps 60%) | ${count(factsAt(meets))} | ${Math.floor(factsAt(meets) / perProduct)} | ${pctOf(assistantAt(meets).netBps)} |`);
  out.push(`| ${count(room)} (the largest that keeps 60% with the add-on's ${ADD_ON_ROOM_CENTS}¢ room, what assistantMeetsFloor asks) | ${count(factsAt(room))} | ${Math.floor(factsAt(room) / perProduct)} | ${pctOf(assistantAt(room).netBps)} |`);
  out.push("");
  out.push(assistantAt(ASSISTANT_INPUT_BYTES).withRoom ? "Nothing is cut: today's cap already keeps 60% with its room at the price set on 18 October 2026." : "The conversation and the rules keep their share; only the catalog text shrinks, so a buyer asking about a product past the cut is told more products exist and is answered less well.");
  out.push("");
  const price = captionsPrice();
  out.push("## AI captions: the price that would keep 60%");
  out.push("");
  out.push(`Today: ${CENTS_PER_MINUTE}¢ a minute for each language, never less than ${usd(MIN_CENTS)}, against the service's 10¢ a minute a language and 10¢ more should it count the spoken language apart. At its worst over every length (1 to ${MAX_AUTO_MINUTES} minutes) and 1 to ${MAX_AUTO_LANGUAGES} languages, it keeps ${pctOf(captionsWorstBps(CENTS_PER_MINUTE, MIN_CENTS))}. ${captionsTodayAnyMinimum() ? "A higher minimum alone would be enough." : `No minimum charge alone can fix it: at ${CENTS_PER_MINUTE}¢ a minute the longest video misses on its own (${pctOf(unitUnder(MAX_AUTO_MINUTES * CENTS_PER_MINUTE, MAX_AUTO_MINUTES * 20, SIZING_READING, true).netBps)} at ${MAX_AUTO_MINUTES} minutes in one language).`}`);
  out.push("");
  out.push(`The lowest price per minute that keeps 60% on the longest video is ${usd(price.perMinute)} a minute a language, but so close to the edge that the minimum charge would have to be ${usd(price.minimum)}. A little higher, the minimum falls to something a page could print${captionsWorstBps(CENTS_PER_MINUTE, MIN_CENTS) >= 6_000 ? ` (since 18 October 2026 the price is ${usd(CENTS_PER_MINUTE)} a minute a language and never less than ${usd(MIN_CENTS)}, which keeps every length at 60%)` : ""}:`);
  out.push("");
  out.push("| Price a minute a language | Minimum charge that keeps every length at 60% |");
  out.push("| --- | --- |");
  for (const o of captionsOptions()) out.push(`| ${usd(o.perMinute)} | ${usd(o.minimum)} |`);
  out.push("");
  out.push(`Captions are on sale today: **${captionsOnSale ? "yes" : "no"}** — they are charged only to a store with an active subscription (lib/auto-captions.ts), and no subscription can be started while the plans are closed (PLANS_ON_SALE ${plansOnSale ? "true" : "false"}, app/api/billing/checkout/route.ts). Withdrawing them until a price is decided changes nothing a customer has today.`);
  out.push("");
  out.push("## For the owner");
  out.push("");
  out.push("- Every proposed figure would be a cut to a limit the customer sees, which the owner ruled out on 18 October 2026. The same day (11:21) he chose a price change instead: at the price list every plan, the Store assistant and AI captions keep 60% with no cut, and no figure above is proposed (docs/value-presentation-2026-10-18.md). Nothing here opens a sale.");
  out.push("- Cuts were deep because receiving a payment and using a plan in full take more than the 17.24% of revenue the floor leaves after a 27.5% tax; that is why the prices are about twenty times the cost of a plan's full use.");
  out.push("");
  return HISTORICAL_MARGIN_NOTICE + out.join("\n");
}
