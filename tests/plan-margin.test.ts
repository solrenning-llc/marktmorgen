import { paidStorageBytes } from '@/lib/storage-rules';
/**
 * No plan may lose money in its own worst case.
 *
 * Every brake in this system was set on its own, against the question "would
 * a real creator ever reach this?" — and every one of them passed that
 * question. Then the worst cases were added up for the first time and both
 * plans lost money: the $29 one by $31 and the $99 one by $15. A brake is
 * not a brake if the sum of all of them sits above the revenue they protect,
 * and no individual check would ever have noticed, because each number was
 * defensible alone.
 *
 * So the sum is the thing that is checked. These are the real published
 * rates, and they move only when the vendors' do:
 *
 *   Cloudflare R2 storage      $0.015 / GB / month   (files that are sold,
 *   Cloudflare R2 delivery     $0                     lib/vault.ts: sending a
 *                                                     file costs nothing; a
 *                                                     million downloads are
 *                                                     $0.36 in requests)
 *   Bunny Stream storage       $0.02  / GB / month   (lesson videos,
 *   Bunny Stream delivery      $0.005 / GB            lib/stream.ts: $0.01 in
 *                                                     each of the two regions
 *                                                     the library keeps its
 *                                                     files in, and the
 *                                                     volume network it sends
 *                                                     them over; read from
 *                                                     the library's own pages
 *                                                     on October 6, 2026)
 *   Vercel Blob storage        $0.023 / GB / month   (the host's own store,
 *   Vercel Blob data transfer  $0.05 to $0.11 / GB    where sold files were
 *                                                     kept until October 7,
 *                                                     2026)
 *   Resend                     $0.0009 / email
 *   Stripe                     2.9% + $0.30 on each subscription charge
 *   Stripe Billing             0.7% of each subscription charge (left out of
 *                                                     these sums until October
 *                                                     13, 2026)
 *
 * What changed on October 7, 2026, and what these figures now count on.
 *
 * A download used to cost five to eleven cents a gigabyte, and the brake on
 * free copies was the dearest line a $29 store had. A sold file now goes to
 * the store that charges nothing to send it, and the door to the dearer one
 * is shut wherever that store is set up and on the paid site always
 * (app/api/store/file), so a missing setting stops an upload instead of
 * bringing the cost back. No plan had been sold before that day, so no
 * paying store has a file in the dearer one. Keeping a file is still worked
 * out at the dearest of the three rates.
 *
 * Which left two things that cost by use. One is visits: every page of a
 * store that is opened is charged for by the host, by the file, by the
 * call and by the command sent to the database, and that was in none of
 * these sums until October 7, 2026, when a hundred thousand visits in a
 * month were found to cost more than the smallest plan had left. A visit is
 * now counted, covered up to a figure by each plan and priced past it
 * (lib/traffic-rules.ts), and what one costs is worked out in
 * tests/traffic-cost.ts from what the live site was measured to do. It
 * counts on one setting nothing here can see: Flat Rate CDN, in the host's
 * billing, which puts the bytes sent inside a fixed tier. It was on when
 * this was written.
 *
 * The other is lesson video, and it is
 * covered and priced by the hour watched (lib/watch-rules.ts). Its worst
 * case is here twice: the hours a plan covers have to fit inside the plan
 * with every other brake at its limit, and an hour past them has to bring in
 * well over what it costs. An hour is costed at the largest size kept, with
 * a quarter added for what a player fetches ahead of what is watched: 6.9
 * megabits for every second counted.
 *
 * Against that, the one clean measure there is. On the live library, on
 * October 7, 2026, a 1080p lesson played once through was counted as 24
 * seconds and took 12.3 megabytes from the video service: a little over 4
 * megabits a second, so the figure above has more than half again over it.
 * The player was also seen to count less than it sent, in a sitting that
 * replayed a video after it had ended (lib/watch.ts); that headroom is what
 * has to carry
 * such sittings, and an hour past the plan goes on paying for itself up to
 * 13.9 megabits for every second counted. These are the two numbers to
 * hold against the video service's own bill once real stores are watching.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMISSION_BPS,
  COMMISSION_LIVE,
  COMMISSION_PLANS_PUBLISHED,
  isSharedPrice,
  PLAN_PRICES,
  PRICES_WITH_COMMISSION,
  PRICES_WITHOUT_COMMISSION,
  PRO_MONTHLY_EMAILS,
  SCALE_MONTHLY_EMAILS,
  TIERS,
  commissionBps,
  commissionCents,
  monthlyEmails,
  type Cycle,
  type Tier,
} from "@/lib/plan";
import { FREE_PAUSE_ABOVE_BYTES } from "@/lib/delivery";
import { STORAGE_BRAKE_BYTES } from "@/lib/storage-quota";
import { DELIVERY_ALLOWANCE_BYTES } from "@/lib/delivery";
import { VIDEO_CENTS_PER_HOUR_OVER, VIDEO_HOURS_INCLUDED } from "@/lib/watch-rules";
import { PAID_VIDEO_HOURS, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { SETUP_STORAGE_BYTES, SETUP_VIDEO_HOURS, TRIAL_STORAGE_BYTES } from "@/lib/plan-standing";
import { CLOSING_DAYS, KEEP_NOTHING_FROM, WARN_WEEK_DAYS, keptRoomFor } from "@/lib/plan-closing-rules";
import { LONGEST_PAUSE_MONTHS, PAID_MONTHS_BEFORE_PAUSE } from "@/lib/plan-pause-rules";
import { SETUP_VISITS, TRIAL_VISITS, VISITS_INCLUDED, VISIT_CENTS_PER_THOUSAND_OVER } from "@/lib/traffic-rules";
import { visitCost } from "./traffic-cost";
import { ORDERS_INCLUDED, ORDER_CENTS_PER_THOUSAND_OVER, TRIAL_ORDERS, freeCopiesLimitFor } from "@/lib/order-rules";
import { coveredByShare } from "@/lib/orders";
import { SHARE_PROVED_IN_TEST_MODE, shareOf } from "@/lib/platform-share";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GB, STORAGE_PER_GB, FILE_DELIVERY_PER_GB, STREAM_STORAGE_PER_GB, PER_EMAIL, ORDER_COST,
  aiCeilingUsd, hourCost, lineKeptShare, netOf, providerFeeUsd, ordersCost, perPaymentCost, videoCost, visitsCost, worstCost, type Prices,
} from "./plan-cost-model";

/**
 * The two sets of prices: the one on sale, and the one decided on October 12,
 * 2026, which goes with a share of each sale (lib/plan.ts COMMISSION_LIVE).
 * Both are held to every sum here, so the decided set is proved before it is
 * switched on rather than after.
 *
 * Every figure below counts only the subscription. With a share of each sale,
 * a store that sells pays more than this, so the subscription alone is the
 * account that pays least: one with every limit reached and not a single sale.
 * That is why Store, with a share, is held to a lower floor than a plan with
 * none — 30% kept in the worst month, 15% paid yearly, never a loss — while
 * every plan without a share keeps the floors it was sold under.
 */
// Since 18 October 2026 the two are one price list (lib/plan.ts), so one schedule is held.
const SCHEDULES: [string, Prices][] = [
  ["on sale", PRICES_WITHOUT_COMMISSION],
];
function floor(prices: Prices, tier: Tier, cycle: Cycle): number {
  const shared = COMMISSION_PLANS_PUBLISHED && prices === PRICES_WITH_COMMISSION && COMMISSION_BPS[tier] > 0 && tier === "creator";
  if (cycle === "month") return shared ? 0.3 : 0.45;
  return shared ? 0.15 : 0.4;
}

test("the email each plan may send is the number that is published", () => {
  assert.deepEqual(TIERS.map(monthlyEmails), [0, PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS]);
});

for (const [schedule, prices] of SCHEDULES) for (const tier of TIERS) {
  test(`${tier}, ${schedule}: every brake at its limit at once still turns a profit`, () => {
    const cost = worstCost(tier);
    const net = netOf(tier, "month", prices);
    assert.ok(
      cost < net,
      `${tier} costs $${cost.toFixed(2)} at its worst and brings in $${net.toFixed(2)}. ` +
        "A plan that loses money in its own worst case has no brakes, only decoration.",
    );
  });

  test(`${tier}, ${schedule}: the margin left in that worst case is a real one`, () => {
    const cost = worstCost(tier);
    const net = netOf(tier, "month", prices);
    const margin = (net - cost) / net;
    assert.ok(
      margin >= floor(prices, tier, "month"),
      `${tier} keeps ${(margin * 100).toFixed(0)}% in its worst case. Scraping past zero is not ` +
        "the goal: the brakes exist so the floor is comfortable, not survivable.",
    );
  });

  test(`${tier}, ${schedule}: no single brake is big enough to swallow the plan by itself`, () => {
    const net = netOf(tier, "month", prices);
    const lines: [string, number][] = [
      ["storage", (paidStorageBytes(tier) / GB) * STORAGE_PER_GB],
      ["free downloads", (FREE_PAUSE_ABOVE_BYTES / GB) * FILE_DELIVERY_PER_GB],
      ["video", videoCost(tier)],
      ["visits", visitsCost(tier)],
      ["orders", ordersCost(tier)],
      ["email", monthlyEmails(tier) * PER_EMAIL],
      ["AI drafts", aiCeilingUsd(tier)],
    ];
    for (const [name, cost] of lines) {
      assert.ok(
        cost <= net / 2,
        `${tier}: ${name} alone is $${cost.toFixed(2)} of $${net.toFixed(2)}. One line taking half ` +
          "the plan leaves nothing for the others.",
      );
    }
  });
}

for (const [schedule, prices] of SCHEDULES) for (const tier of TIERS) {
  test(`${tier}, ${schedule}: paid by the year, the worst month still leaves a real margin`, () => {
    // A year paid at once is a discount, so each of its months brings in
    // less, against the same worst case. The floor is lower than the monthly
    // one and still far from scraping by; the plans that were on sale before
    // this was first added up sit at 44%, and none may go under 40%.
    const cost = worstCost(tier);
    const net = netOf(tier, "year", prices);
    const margin = (net - cost) / net;
    assert.ok(
      margin >= floor(prices, tier, "year"),
      `${tier}, yearly: costs $${cost.toFixed(2)} in its worst month against $${net.toFixed(2)} a month, ` +
        `which keeps ${(margin * 100).toFixed(0)}%.`,
    );
  });
}

// MR rule (AGENTS.md; owner, 3 November 2026, C2-63/C2-70; docs/codex-queue.md, 465 [MR2]): no unit loses money.
test("every plan keeps a net profit above the spend floor's room in its own worst month, monthly and yearly", () => {
  for (const tier of TIERS) for (const cycle of ["month", "year"] as const) {
    const months = cycle === "year" ? 12 : 1;
    const profit = months * (netOf(tier, cycle, PRICES_WITHOUT_COMMISSION) - worstCost(tier));
    assert.ok(profit > 0 && profit >= (cycle === "year" ? 1 : 0.25), `${tier}, ${cycle}: net profit $${profit.toFixed(4)}`);
  }
});

test("a lesson video kept by the video service never costs more to keep than the storage brake allows for", () => {
  // The storage brake counts a video at the service byte for byte with a
  // file in the file store (lib/storage-quota.ts), and the worst case above
  // is worked out at the dearest rate a file is kept at.
  assert.ok(STREAM_STORAGE_PER_GB <= STORAGE_PER_GB, "keeping a video at the service must not cost more than the rate storage is worked out at");
});

test("an hour of video past what a plan covers brings in well over what it costs", () => {
  // The one thing charged by use. What reaches us for an hour is the price
  // less the card fee's percentage (its thirty cents is on the invoice the
  // hour is added to, and is paid with the plan either way).
  const kept = (VIDEO_CENTS_PER_HOUR_OVER / 100) * lineKeptShare();
  const cost = hourCost();
  const margin = (kept - cost) / kept;
  assert.ok(
    margin >= 0.45,
    `an hour past the plan brings in $${kept.toFixed(4)} and costs $${cost.toFixed(4)}, which keeps ${(margin * 100).toFixed(0)}%. ` +
      "A price near what the hour costs is a slower loss.",
  );
});

test("a thousand visits past what a plan covers are not sold: at the published price they would not pay their way", () => {
  // Visits past a plan were billed at VISIT_CENTS_PER_THOUSAND_OVER until
  // 17 October 2026 and are not billed since (lib/traffic-rules.ts; the
  // usage job settles none, tests/plan-cost-registry.test.ts). Since
  // 18 October 2026, received in the one model of lib/receiving-costs.ts (the
  // fee on the amount charged with the buyer's tax on top, remittance and
  // reserves), the old price keeps under the 45% this held it to, so it must
  // stay unsold: the store rests past its figure instead.
  const kept = (VISIT_CENTS_PER_THOUSAND_OVER / 100) * lineKeptShare();
  const cost = 1000 * visitCost();
  const margin = (kept - cost) / kept;
  console.log(`a thousand visits past the plan would bring in $${kept.toFixed(4)} and cost $${cost.toFixed(4)}, keeping ${(margin * 100).toFixed(0)}% before tax`);
  const job = readFileSync(join(process.cwd(), "app/api/cron/usage/route.ts"), "utf8");
  assert.doesNotMatch(job, /settleAllVisits|visitsOwedCents/, "visits past a plan must not be billed while the price does not pay for them");
});

test("a thousand orders past what a plan covers bring in more than they cost, with the spend floor's room", () => {
  // The third thing charged by use: what reaches us for a thousand orders, against a thousand of the dearest order
  // there is. MR rule (owner, 3 November 2026, C2-70; docs/codex-queue.md, 465 [MR2]): a profit with the room, no
  // longer a 45% floor; the share it keeps (about 42% since the stock work is priced) is for the monthly report.
  const kept = (ORDER_CENTS_PER_THOUSAND_OVER / 100) * lineKeptShare();
  const cost = 1000 * ORDER_COST;
  assert.ok(kept - cost > 0 && kept - cost >= 0.25, `a thousand orders past the plan bring in $${kept.toFixed(4)} and cost $${cost.toFixed(4)}.`);
});

test("an order that paid a share is covered by it several times over, so it is not counted", () => {
  // The smallest payment Stripe takes, at the smallest share there is: what
  // it pays has to be several times what the dearest order costs, or leaving
  // it out of the count (lib/orders.ts) would be a loss.
  const smallest = Math.min(...TIERS.map((tier) => COMMISSION_BPS[tier]).filter((bps) => bps > 0));
  const paid = shareOf(smallest, 50) / 100;
  assert.ok(paid >= 3 * ORDER_COST, `the smallest share is $${paid.toFixed(4)} against $${ORDER_COST.toFixed(4)} for an order`);
  // And an order that paid nothing, or paid while no share is taken, always counts.
  const store = { shared: true, subscriptionActive: true, trialEnds: 0, tier: "pro" as Tier };
  assert.equal(coveredByShare(store, 2700, 1e10, true), true);
  assert.equal(coveredByShare(store, 0, 1e10, true), false);
  assert.equal(coveredByShare(store, 2700, 1e10, false), false);
  assert.equal(coveredByShare({ ...store, trialEnds: 2e10 }, 2700, 1e10, true), false);
  assert.equal(coveredByShare({ ...store, tier: "scale" }, 2700, 1e10, true), false);
});

test("free copies stop at the month's orders: the plan's when paid, a trial's in a trial, none without a plan", () => {
  // A free copy costs its email and nobody pays for it. Since 17 October
  // 2026 nothing past a plan is billed, so a paid store's free copies stop at
  // its plan's orders like its paid orders (lib/order-admission.ts); one in
  // its trial stops giving them at TRIAL_ORDERS; one with no plan gives none
  // (lib/free.ts, isPaidUp).
  const base = { subscriptionId: "sub_1", planEndedAt: "" };
  const now = 1_000_000;
  assert.equal(freeCopiesLimitFor({ ...base, subscriptionActive: true, trialEnds: 0, tier: "pro" }, now), ORDERS_INCLUDED.pro);
  assert.equal(freeCopiesLimitFor({ ...base, subscriptionActive: true, trialEnds: now + 10 }, now), TRIAL_ORDERS);
  assert.equal(freeCopiesLimitFor({ ...base, subscriptionActive: false, trialEnds: 0 }, now), 0);
  assert.ok(TRIAL_ORDERS * ORDER_COST < 2, `a trial's orders can cost $${(TRIAL_ORDERS * ORDER_COST).toFixed(2)} with nothing paid`);
  const free = readFileSync(join(process.cwd(), "lib/free.ts"), "utf8");
  assert.match(free, /freeCopiesLimitFor\(store\)/, "lib/free.ts must hold free copies to the trial's orders");
  assert.match(free, /isPaidUp\(store\)/, "lib/free.ts must give no free copies without a plan");
});

test("every place an order is handed over counts it", () => {
  // An order nothing counts is an order nobody pays for on a plan with no share.
  for (const [file, mark] of [
    ["lib/purchase-email.ts", "countOrder(store, `checkout:"],
    ["lib/purchase-email.ts", "countOrder(store, `offer:"],
    ["lib/group-buy.ts", "countOrder(store, `place:"],
    ["lib/free.ts", "countOrder(store, `free:"],
    ["lib/paypal-sales.ts", "countOrder(store, `paypal:"],
  ] as const) {
    assert.ok(readFileSync(join(process.cwd(), file), "utf8").includes(mark), `${file} must count its orders (${mark})`);
  }
  const cron = readFileSync(join(process.cwd(), "app/api/cron/usage/route.ts"), "utf8");
  assert.doesNotMatch(cron, /settleAllOrders/, "the daily job never bills orders past a plan: they are not sold (lib/order-admission.ts)");
});

test("a store nobody can charge cannot be visited past the visits it has", () => {
  // A visit past the plan is paid for by a line on an invoice. A store in
  // its free trial has no invoice yet, and one with no plan has none at
  // all, so the visits themselves are the limit there: its pages rest at
  // them (lib/traffic.ts; tests/traffic.test.ts holds where and for whom).
  for (const page of ["app/[handle]/page.tsx", "app/[handle]/p/[product]/page.tsx"]) {
    assert.match(readFileSync(join(process.cwd(), page), "utf8"), /if \(await isResting\(store\)\) return <StoreResting store=\{store\} \/>;/, `${page} must rest with its store`);
  }
  assert.ok(TRIAL_VISITS <= VISITS_INCLUDED.creator, "a trial of any plan has no more than the smallest plan's visits: it has paid for none");
});

test("lesson pages supply the store's video allowance", () => {
  // The actual admission behavior, including failed reads and exact exhaustion,
  // is exercised in video-admission.test.ts. Keep this route wiring check.
  const page = readFileSync(join(process.cwd(), "app/[handle]/course/[product]/[lesson]/page.tsx"), "utf8");
  assert.match(page, /lessonVideo\(lesson\.video, videoLimitFor\(store\), windowId\(store\), store\)/, "the lesson page must supply the store's allowance and its window");
});

test("a store that pays nothing can cost next to nothing", () => {
  // Not a plan, so not in the sums above; set against zero instead. What a
  // store with no plan may keep, at the dearest rate a file is kept at, and
  // the hours its video may be watched, at the most an hour can cost.
  const kept = (SETUP_STORAGE_BYTES / GB) * STORAGE_PER_GB;
  const watched = SETUP_VIDEO_HOURS * hourCost();
  // And the visits its pages are shown for before they rest.
  const visited = SETUP_VISITS * visitCost();
  assert.ok(kept + watched + visited < 0.4, `a store with no plan can cost $${(kept + watched + visited).toFixed(2)} a month`);
  // A free trial lasts two weeks with a card on file. All it may keep,
  // every hour it may play and every visit it may have, in one month:
  const trial = (TRIAL_STORAGE_BYTES / GB) * STORAGE_PER_GB + (TRIAL_VIDEO_SECONDS / 3600) * hourCost() + TRIAL_VISITS * visitCost();
  assert.ok(trial < 8, `a trial at every limit costs $${trial.toFixed(2)} in a month`);
});

test("a store whose plan ended stops costing more than a store with no plan, on a day that is set", () => {
  // What a store keeps goes on costing after its plan ends, and until
  // lib/plan-closing.ts that had no end. Now what it keeps past the room of
  // a store with no plan is removed CLOSING_DAYS after the plan ended, and
  // never later than a week past that for a last notice that went out late
  // (tests/plan-closing.test.ts holds the days and what is done on them).
  const months = (CLOSING_DAYS + WARN_WEEK_DAYS) / 30;
  // The dearest store there can be: it pays for one month, runs every limit
  // of its plan in it, cancels, and leaves all a paid plan may keep here
  // until its day. That one month has to have paid for all of it.
  // Since 18 October 2026 that is all it keeps, its students' room and its
  // community's pictures too (tests/plan-cost-registry.ts, PER_PAYMENT_LINES).
  for (const [schedule, prices] of SCHEDULES) for (const tier of TIERS) {
    const kept = perPaymentCost(tier);
    assert.ok(kept >= (paidStorageBytes(tier) / GB) * STORAGE_PER_GB * months, `${tier}: what is kept after the end is at least the plan's storage to its day`);
    const cost = worstCost(tier) + kept;
    const net = netOf(tier, "month", prices);
    assert.ok(
      cost < net,
      `${tier}, ${schedule}: one month at every limit, and then everything kept to its day, costs $${cost.toFixed(2)} against the $${net.toFixed(2)} that month brought in. ` +
        "The days a store has after its plan ends are paid for by its last month, or by nobody.",
    );
  }
  // A free trial that filled all a trial may keep, and never paid: a card
  // was on file, and this is the whole of what it can leave behind.
  const trial = (TRIAL_STORAGE_BYTES / GB) * STORAGE_PER_GB * months;
  assert.ok(trial < 3, `keeping an unpaid trial's files to its day costs $${trial.toFixed(2)} once`);
  // After the day, either is a store with no plan: the test above.
  const closing = readFileSync(join(process.cwd(), "lib/plan-closing.ts"), "utf8");
  assert.match(closing, /if \(!closes && held <= keptRoomFor\(endedAt\)\)/, "the room a closing store is held to must be the one lib/plan-closing-rules.ts gives: none for a plan ended from 18 October 2026");
  // And since that day such a store closes whatever it keeps: nothing of it is kept past its day but what goes by itself (lib/closed-store-data.ts).
  assert.match(closing, /const closes = closesStore\(endedAt\)/);
  assert.equal(keptRoomFor(KEEP_NOTHING_FROM), 0, "a plan that ends from that day keeps nothing past its day");
  const job = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string }[] };
  assert.ok(job.crons.some((cron) => cron.path === "/api/cron/closing"), "and the job that does it must be scheduled, or the day never comes");
});

test("historical video invoices retain their old allowance and rate", () => {
  // Published in the studio, the Terms and the price list (tests/watch.test.ts
  // holds the pages to these two numbers). Stated here so the figure cannot
  // be raised without this file's sums being run against it.
  assert.deepEqual(PAID_VIDEO_HOURS, {creator:4,pro:32,scale:64});
  assert.equal(VIDEO_HOURS_INCLUDED, 400);
  assert.equal(VIDEO_CENTS_PER_HOUR_OVER, 3);
});

test("the free-download brake is smaller than the allowance that is published", () => {
  // The published figure covers paid and free together. Free copies — which
  // nobody paid for — cannot be allowed to eat the whole of it.
  assert.ok(
    FREE_PAUSE_ABOVE_BYTES < DELIVERY_ALLOWANCE_BYTES,
    "giving things away must not be able to consume the whole month's delivery on its own",
  );
});

test("a buyer's download is bounded by nothing, and that is on purpose", () => {
  // Stated here so that nobody ever "fixes" it. Somebody paid the creator for
  // that file. It is also why a sold file is kept where sending it costs
  // nothing: the one delivery that may never be refused is the one that must
  // not be able to run up a bill.
  const delivery = readFileSync(join(process.cwd(), "lib/delivery.ts"), "utf8");
  assert.match(
    delivery,
    /What it deliberately does NOT do is stop a delivery/,
    "the reasoning for never blocking a paid download must stay written down",
  );
});

test("a break from the plan is paid for by the months before it, at its longest", () => {
  // The dearest store a break can leave behind: it pays for the months a
  // break needs before it (lib/plan-pause-rules.ts), runs every limit of its
  // plan in each, takes the longest break with everything a paid plan may
  // keep still kept, and then does not come back, so what it keeps runs on
  // past the break until its last two notices are out (lib/plan-pause.ts
  // holds the closing back while the break runs, and lets it go on after).
  // What those months paid has to cover all of it, with a quarter to spare;
  // on Store with a share, whose subscription is the smallest because its
  // sales pay the rest, it has to cover it with something to spare, and it
  // does by about 4% in a case that needs every limit, a break, and a store
  // that never sells or comes back.
  const months = PAID_MONTHS_BEFORE_PAUSE;
  const afterMonths = (WARN_WEEK_DAYS * 2) / 30;
  for (const [schedule, prices] of SCHEDULES) for (const tier of TIERS) {
    const kept = (paidStorageBytes(tier) / GB) * STORAGE_PER_GB * (LONGEST_PAUSE_MONTHS + afterMonths);
    const cost = months * worstCost(tier) + kept;
    const net = months * netOf(tier, "month", prices);
    const margin = (net - cost) / net;
    assert.ok(
      margin >= (floor(prices, tier, "month") < 0.45 ? 0.03 : 0.25),
      `${tier}, ${schedule}: ${months} months at every limit, a ${LONGEST_PAUSE_MONTHS}-month break and the days after it cost $${cost.toFixed(2)} against the $${net.toFixed(2)} those months brought in, keeping ${(margin * 100).toFixed(0)}%.`,
    );
  }
});

/**
 * The most one customer can ever cost us, with the Refund Policy of
 * 12 October 2026: the first payment is refunded in full within REFUND_DAYS;
 * a yearly plan is refunded for the months not started, the months used
 * kept at the monthly price; a renewal is not refunded. Stripe keeps its
 * processing fee on a refund and never returns the fee for a dispute. The fee
 * is the one model's (lib/receiving-costs.ts): the dearer provider's, on the
 * amount charged with the buyer's tax on top.
 */
const STRIPE_FEE = (grossCents: number) => providerFeeUsd(grossCents);

/**
 * What a store's files cost after its plan ends, until its closing day: all a
 * paid plan may keep, for CLOSING_DAYS and the week a late notice adds. Every
 * way a plan can end — cancelled, refunded, unpaid — ends in this, and until
 * October 12, 2026 none of the refund sums below counted it.
 */
const keptToClosing = (tier: Tier) => (paidStorageBytes(tier) / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);

test("the one exposure is the first payment refunded in full: bounded, once per account, and said in writing", () => {
  // A customer pays, runs every brake to its limit, asks the payment back,
  // and leaves everything a paid plan may keep until the closing day. This is
  // the guarantee's whole price, taken once per account (lib/plan.ts REFUND_DAYS).
  for (const [schedule, prices] of SCHEDULES) {
    const month = worstCost("creator") + STRIPE_FEE(prices.creator.month) + keptToClosing("creator");
    const year = worstCost("creator") + STRIPE_FEE(prices.creator.year) + keptToClosing("creator");
    // Bounded, and once per account; since the prices of 18 October 2026 a refunded first year is dearer, because
    // the card fee Stripe keeps grows with the charge: it is a funded exposure (docs/funded-exposure-review.md).
    assert.ok(month < 15, `${schedule}: a first month given back can cost $${month.toFixed(2)} on one account`);
    assert.ok(year < 65, `${schedule}: a first year given back can cost $${year.toFixed(2)} on one account`);
  }
  const policy = readFileSync(join(process.cwd(), "app/refunds/page.tsx"), "utf8");
  assert.match(policy, /first payment on your account/, "the guarantee must say it is for the first payment, or every month is free for anyone who asks");
  assert.match(policy, /are not refunded, except where\s+applicable consumer law requires it/, "renewals must be said to be final");
  for (const page of ["lib/help-content.ts", "components/home-parts.tsx", "app/terms/page.tsx", "app/mission/page.tsx", "app/page.tsx"]) {
    const text = readFileSync(join(process.cwd(), page), "utf8");
    assert.ok(!/renewals included|Renewals and yearly payments too|every charge is refunded/i.test(text), `${page} still promises refunds on every charge`);
  }
});

for (const [schedule, prices] of SCHEDULES) for (const tier of TIERS) {
  test(`${tier}, ${schedule}: a yearly plan refunded in its first month, past the guarantee, still pays for that month and the days to closing`, () => {
    // A yearly plan that was not the first payment (a second store, or one
    // bought after a monthly one) can be refunded at any time. Kept: the month
    // started, at the monthly price, and Stripe's card fee on the year, which
    // the Refund Policy says is kept because Stripe does not give it back.
    const yearNet = prices[tier].year / 100 - STRIPE_FEE(prices[tier].year);
    const refunded = prices[tier].year / 100 - prices[tier].month / 100 - STRIPE_FEE(prices[tier].year);
    const kept = yearNet - refunded;
    const cost = worstCost(tier) + keptToClosing(tier);
    assert.ok(kept > cost, `${tier}, ${schedule}: keeps $${kept.toFixed(2)} against $${cost.toFixed(2)}`);
  });
}

test("a refunded year keeps Stripe's card fee, and every page that summarises it says so", () => {
  const policy = readFileSync(join(process.cwd(), "app/refunds/page.tsx"), "utf8");
  assert.match(policy, /card processing fee Stripe\s+charged on the yearly payment/);
  for (const page of ["app/terms/page.tsx", "lib/help-content.ts", "app/mission/page.tsx", "components/home-parts.tsx"]) {
    const text = readFileSync(join(process.cwd(), page), "utf8");
    assert.match(text, /card\s+(processing\s+)?fee/i, `${page} summarises the yearly refund without the card fee`);
  }
});

test("a yearly first payment asks the card's bank to authenticate, so a fraud dispute lands on the bank", () => {
  const billing = readFileSync(join(process.cwd(), "lib/billing.ts"), "utf8");
  assert.match(billing, /cycle === "year"\) body\.set\("payment_method_options\[card\]\[request_three_d_secure\]", "any"\)/);
});

test("while the share is off, nothing is taken from a sale and the prices on sale are today's", () => {
  if (COMMISSION_LIVE) return;
  assert.deepEqual(PLAN_PRICES, PRICES_WITHOUT_COMMISSION);
  for (const tier of TIERS) {
    assert.equal(commissionBps(tier), 0);
    assert.equal(commissionCents(tier, 100_000), 0);
  }
});

test("the commission variant decided on 18 October 2026: the same price list, no share published or taken", () => {
  // The owner's price decision (lib/plan.ts): with the commission counted as zero, a lower price that goes with a
  // share of each sale cannot keep 60%, so the variant is the one price list and no store can be on a shared price.
  assert.deepEqual(PRICES_WITH_COMMISSION, PRICES_WITHOUT_COMMISSION);
  assert.equal(COMMISSION_PLANS_PUBLISHED, false);
  assert.equal(COMMISSION_LIVE, false);
  for (const tier of TIERS) for (const cycle of ["month", "year"] as const) assert.equal(isSharedPrice(tier, cycle, PRICES_WITH_COMMISSION[tier][cycle]), false);
  // The rates once proposed are kept for the machinery, and nothing reads them while the switches are off.
  assert.deepEqual(COMMISSION_BPS, { creator: 625, pro: 275, scale: 0 });
  // Each year is ten months for twelve.
  for (const tier of TIERS) assert.equal(PRICES_WITH_COMMISSION[tier].year, PRICES_WITH_COMMISSION[tier].month * 10);
});

test("a share is rounded down, and never taken from nothing", () => {
  // The arithmetic the checkout will use, held at the decided rates.
  const at = (tier: Tier, cents: number) => Math.floor((Math.floor(cents) * COMMISSION_BPS[tier]) / 10_000);
  assert.deepEqual([at("creator", 4_900), at("creator", 15), at("pro", 4_900), at("scale", 4_900)], [306, 0, 134, 0]);
  for (const bad of [0, -500, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(commissionCents("creator", bad), 0);
});

/**
 * What has to be true before the share is switched on, as far as code can
 * see it (lib/plan.ts COMMISSION_LIVE says why each one). Stripe's written
 * yes cannot be seen from here; the rest can.
 */
function notYetReady(): string[] {
  const missing: string[] = [];
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
  // 1. Every place that opens a charge on a creator's account sets the fee.
  const charging = [
    "lib/store-checkout.ts",
    "lib/cart-checkout.ts",
    "lib/calls.ts",
    "lib/call-packages.ts",
    "lib/store-tip-checkout.ts",
    "lib/upsell.ts",
  ];
  for (const file of charging) {
    const text = read(file);
    assert.match(text, /onAccount\(\s*"POST"[\s\S]{0,160}?"\/(checkout\/sessions|payment_intents)"/, `${file} no longer opens a charge; update this list`);
    if (!/applyShare(ToPayment)?\(/.test(text)) missing.push(`${file} opens a charge with no share set on it`);
  }
  // 2. A refund gives back the share of what was refunded, every day, and so does a discount.
  if (!/application_fees\/\$\{[^}]+\}\/refunds/.test(read("lib/share-settle.ts"))) missing.push("a refund does not give back the share");
  const crons = (JSON.parse(read("vercel.json")) as { crons: { path: string }[] }).crons;
  if (!crons.some((c) => c.path === "/api/cron/shares")) missing.push("the job that gives back what is not owed is not scheduled");
  // 3. No page says that nothing is taken from a sale once something is. Every
  // such sentence lives in lib/fee-words.ts, in a version for each side of
  // the switch, and tests/fee-words.test.ts holds that no other file says it
  // and that the version for after the switch never does; the blog's worked
  // sums against Gumroad are worked out there too (gumroadSums).
  const blog = read("lib/blog.ts");
  if (/Your own Stripe with a \$29|smaller than \$29|on the \$29 plan/.test(blog)) missing.push("lib/blog.ts still works its sums at the price without a share");
  // 4. A store that subscribed before keeps its price, with no share.
  if (!/\n  shared: boolean;/.test(read("lib/store.ts"))) missing.push("a store that subscribed before has nothing marking it as kept on its price");
  // 5. And it has all been seen to work against Stripe's test mode (lib/platform-share.ts).
  if (!SHARE_PROVED_IN_TEST_MODE) missing.push("the share has not been run against Stripe's test mode on the platform that will take it");
  return missing;
}

test("the share cannot be switched on before the checkout, the refunds and the pages are ready for it", () => {
  const missing = notYetReady();
  if (COMMISSION_LIVE) {
    assert.deepEqual(missing, [], "switched on with these still missing");
  } else {
    // Off: the list is what switching it on will take. It is checked to find
    // something, so a scan that silently stopped matching cannot pass as "ready".
    // Off, the one thing left is what code cannot see: the run against Stripe's test mode.
    assert.deepEqual(missing, ["the share has not been run against Stripe's test mode on the platform that will take it"]);
    // What code can do ahead of the switch is done, and stays done: every
    // charge sets the share, the job that gives back is scheduled, and a
    // store that subscribed before is kept on its price.
    const built = missing.filter((m) => /opens a charge|does not give back|not scheduled|kept on its price/.test(m));
    assert.deepEqual(built, [], "built ahead of the switch, and must stay built");
  }
});
