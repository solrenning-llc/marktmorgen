/**
 * A closing store's daily visits are priced (Claude 7 on #3501, MÉDIO cost, 6891502895 and 6892785667).
 *
 * closeOne (lib/plan-closing.ts) visits a closing store once a day from its plan's end to the walk. Since #3501 a
 * visit past its start first checks, with one GET (stateSaver's check), that the closing state is still the one it
 * read before it acts on it, and the lost-day branch checks the same way before it stops renewals. No line of
 * tests/plan-cost-registry.ts priced those visits: the closure line counted deletes, followers, exports, list
 * downloads and the last steps only.
 *
 * Now closure carries CLOSING_VISIT_DAYS visits at closingVisitCost (CLOSING_VISIT_COMMANDS commands, the check
 * included, and the store's record read back), and a store held past those days is a company exposure with no
 * reviewed ceiling (CLOSING_HELD_VISITS, unknown, never zero). This test drives whole closings through the real
 * closeOne and counts every command each visit sends: a visit held for want of a way to write to the creator, one held
 * for want of the company's postal address, one whose notice could not be sent, and the lost-day branch's visits.
 * Each stays inside CLOSING_VISIT_COMMANDS, and a visit past the start sends the check's GET.
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), a measure stand-in, and a Stripe and email
 * stand-in that answers nothing (no real service is reached; no store has a Stripe account, so no member or buyer
 * is acted on and what is counted is the visit's own commands).
 */
import { createHash } from "node:crypto";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { CLOSING_DAYS, ERASE_WITHIN_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { BUYER_NOTICE_DAYS, BUYER_SEND_DAYS } from "@/lib/closing-buyers-rules";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { MAX_STORE_BYTES } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { COMMAND, DB_BYTE, PER_PAYMENT_LINES, closureCost } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
/** Every command list sent while `watched` is set. */
let watched: Commands[] | null = null;
redis.pipeline = (async (commands: Commands) => {
  watched?.push(commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

// Stripe and the email sender: nothing is reached, every call is refused.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
// A store that keeps more than one with no plan may, so it goes on to the closing's steps.
const hands: Hands = { measure: async () => 10 ** 12, list: async () => [], remove: async () => {} };
const DAY = 86_400_000;

const reg = registry as unknown as Record<string, unknown>;
const num = (name: string): number => (typeof reg[name] === "number" ? (reg[name] as number) : NaN);
const fn = (name: string): ((...args: unknown[]) => unknown) | null => (typeof reg[name] === "function" ? (reg[name] as (...args: unknown[]) => unknown) : null);

async function endedStore(handle: string): Promise<{ email: string; key: string; endedAt: number }> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, "Visit Shop", "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}plan01`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  const store = (await storeForEmail(email))!;
  return { email, key: storeRef(store), endedAt: Date.parse(store.planEndedAt) };
}

type Visit = { day: number; state: string; note?: string; commands: number; stateGets: number };
/** One visit of `key` at `now`, with every command it sent counted. */
async function visit(key: string, ref: string, now: number, day: number): Promise<Visit> {
  watched = [];
  const out = await closeOne(key, now, hands, Number.POSITIVE_INFINITY).catch((error: unknown) => ({ state: "threw", note: String(error) }));
  const sent = watched;
  watched = null;
  return {
    day,
    state: out.state,
    note: out.note,
    commands: sent.reduce((sum, list) => sum + list.length, 0),
    stateGets: sent.flat().filter((c) => c[0] === "GET" && c[1] === stateKey(ref)).length,
  };
}

async function main(): Promise<void> {
  redis.clear();
  const bound = num("CLOSING_VISIT_COMMANDS");
  const visits: Visit[] = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    // No sender: every visit past the start is held, every day of the closing and a week past it.
    const unsent = await endedStore("visitnosender");
    for (let day = 1; day <= CLOSING_DAYS + WARN_WEEK_DAYS + 7; day += 1) visits.push(await visit(unsent.email, unsent.key, unsent.endedAt + day * DAY, day));
    part("A store held for want of a way to write to the creator");
    const past = visits.filter((v) => v.day > 1);
    is("every visit past the start is held, as before", [...new Set(past.map((v) => `${v.state}: ${v.note}`))], ["held: no way to write to the creator"]);
    is("a visit past the start reads its state and checks it once more (stateSaver's check: one GET)", [...new Set(past.map((v) => v.stateGets))], [2]);
    is("each of its visits sends at most CLOSING_VISIT_COMMANDS commands", visits.filter((v) => !(v.commands <= bound)).map((v) => [v.day, v.commands]), []);

    // A sender, and the company's postal address or not.
    process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
    const noPostal = await endedStore("visitnopostal");
    const heldPostal: Visit[] = [];
    for (let day = 1; day <= CLOSING_DAYS + WARN_WEEK_DAYS + 7; day += 1) heldPostal.push(await visit(noPostal.email, noPostal.key, noPostal.endedAt + day * DAY, day));
    part("A store held for want of the company's postal address, and one whose notices could not be sent");
    is("its buyers' notice waits on the postal address", heldPostal.some((v) => v.note === "no company postal address for its buyers' notice"), true);
    process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";
    const unsentNotice = await endedStore("visitnotice");
    const notices: Visit[] = [];
    for (let day = 1; day <= CLOSING_DAYS + WARN_WEEK_DAYS + 7; day += 1) notices.push(await visit(unsentNotice.email, unsentNotice.key, unsentNotice.endedAt + day * DAY, day));
    is("a notice that could not be sent holds it", notices.some((v) => v.note === "the notice could not be sent"), true);
    is("a visit past the start sends the check's GET there too", notices.filter((v) => v.day > 1).every((v) => v.stateGets === 2), true);
    is("each of their visits sends at most CLOSING_VISIT_COMMANDS commands", [...heldPostal, ...notices].filter((v) => !(v.commands <= bound)).map((v) => [v.day, v.commands]), []);

    // The lost-day branch: in the final line, with no state and no address mark.
    const lost = await endedStore("visitlostday");
    await pipeline([["ZADD", FINAL_INDEX, lost.endedAt, lost.key]]);
    const lostVisits: Visit[] = [];
    for (let day = CLOSING_DAYS + 11; day <= CLOSING_DAYS + 11 + BUYER_NOTICE_DAYS + 4; day += 1) lostVisits.push(await visit(lost.key, lost.key, lost.endedAt + day * DAY, day));
    part("The lost-day branch: its day and its address mark both lost");
    is("it waits a notice's length after its buyers are told", lostVisits.some((v) => v.state === "waiting"), true);
    is("a waiting visit checks its state before it stops renewals (one GET more)", lostVisits.filter((v) => v.state === "waiting").every((v) => v.stateGets === 2), true);
    is("each of its visits sends at most CLOSING_VISIT_COMMANDS commands", lostVisits.filter((v) => !(v.commands <= bound)).map((v) => [v.day, v.commands]), []);

    // A closed store (its closing day done, "removed") stays in the final line until the walk deletes its records and
    // takes it out (lib/closed-store-data.ts, ZREM FINAL_INDEX), which comes within ERASE_WITHIN_DAYS of its closing
    // day; every day until then closeOne visits it again (markShut, refuseLatePlans and the removed branch). Claude 5
    // on #3501 (6907073223, 6914305400): those visits were priced in no day of CLOSING_VISIT_DAYS.
    const closed = await endedStore("visitremoved");
    const closedOn = closed.endedAt + (CLOSING_DAYS + 1) * DAY;
    await pipeline([
      ["ZADD", FINAL_INDEX, closed.endedAt, closed.key],
      ["SET", stateKey(closed.key), JSON.stringify({ of: closed.endedAt, day: closedOn, removed: closedOn, due: closedOn })],
    ]);
    // Stripe, for this store only: every search and list of its plan subscriptions answers empty and complete, so a
    // visit gets past refuseLatePlans as a closed store's does (nothing is reached; nothing is charged or stopped).
    const refusing = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.hostname === "api.stripe.com" && (init?.method ?? "GET") === "GET" && url.pathname.startsWith("/v1/subscriptions")) return Response.json({ object: "list", data: [], has_more: false, next_page: null });
      return refusing(input, init);
    }) as typeof fetch;
    process.env.STRIPE_SECRET_KEY = "sk_test_closing_visit_cost_only";
    const removedVisits: Visit[] = [];
    try {
      for (let day = 1; day <= ERASE_WITHIN_DAYS; day += 1) removedVisits.push(await visit(closed.key, closed.key, closedOn + day * DAY, day));
    } finally {
      globalThis.fetch = refusing;
      delete process.env.STRIPE_SECRET_KEY;
    }
    part("A closed store waits in the final line for the walk, visited each day until it");
    is("every visit until the walk finds it closed, its records left to the walk", [...new Set(removedVisits.map((v) => `${v.state}: ${v.note}`))], ["removed: its records are deleted by the next walk"]);
    is("it is visited on each of the ERASE_WITHIN_DAYS days before the walk must have come", removedVisits.length, ERASE_WITHIN_DAYS);
    console.log(`the most commands one closed store's visit sent: ${Math.max(...removedVisits.map((v) => v.commands))}`);
    is("each of its visits sends at most CLOSING_VISIT_COMMANDS commands", removedVisits.filter((v) => !(v.commands <= bound)).map((v) => [v.day, v.commands]), []);
    const most = Math.max(...visits.map((v) => v.commands), ...heldPostal.map((v) => v.commands), ...notices.map((v) => v.commands), ...lostVisits.map((v) => v.commands), ...removedVisits.map((v) => v.commands));
    console.log(`the most commands one visit sent: ${most} (bound ${bound})`);
  } finally {
    console.error = quiet;
  }

  part("Closure carries the closing's daily visits, the check included (tests/plan-cost-registry.ts)");
  const visitCost = fn("closingVisitCost");
  const days = num("CLOSING_VISIT_DAYS");
  const reply = num("CLOSING_VISIT_REPLY_BYTES");
  is("a named bound for a visit's commands", Number.isSafeInteger(bound) && bound > 0, true);
  is("the days a closing is visited: its days, a late last notice's week, an early buyers' notice, its day, a lost day's notice and the day after, and the days a closed store waits for the walk", days, CLOSING_DAYS + WARN_WEEK_DAYS + BUYER_SEND_DAYS + 1 + BUYER_NOTICE_DAYS + 1 + ERASE_WITHIN_DAYS);
  is("a visit reads its record back at the most", reply >= MAX_STORE_BYTES, true);
  is("one visit's cost: its commands and what it reads back", visitCost ? visitCost() : NaN, bound * COMMAND + reply * DB_BYTE);
  for (const tier of ["creator", "pro", "scale"] as const) {
    for (const trial of [false, true]) {
      const c = closureCost(tier, trial) as ReturnType<typeof closureCost> & { visits?: number };
      is(`${tier}${trial ? " (a free trial)" : ""}: closure carries every visit`, [typeof c.visits === "number" && c.visits > 0, c.visits === days * (visitCost ? (visitCost() as number) : NaN), c.total >= c.deletes + c.follows + c.exports + c.lists + c.prepare + (c.visits ?? NaN) - 1e-12], [true, true, true]);
    }
  }
  const line = PER_PAYMENT_LINES.find((l) => l.id === "closure");
  is("the closure line names the check it prices", Boolean(line?.sources.some((s) => s.file === "lib/plan-closing.ts" && s.names.includes("await save.check();") && s.names.includes("await saveFinal.check();"))), true);
  is("the closure line's figure is closureCost's", line?.monthlyUsd("creator"), closureCost("creator").total);

  part("A store held past its days is a company exposure with no reviewed ceiling: unknown, never zero");
  const held = reg.CLOSING_HELD_VISITS as Record<string, unknown> | undefined;
  const exposure = fn("closingHeldMonthlyExposure");
  is("its ceilings and complete figure are unknown", [held?.reviewedHeldStoreCeiling, held?.reviewedHeldDaysCeiling, held?.completeMonthlyCostUsd], [null, null, null]);
  is("a held store's month is modeled at a visit a day, its complete figure unknown", exposure ? exposure() : null, { modeledUsd: 31 * (visitCost ? (visitCost() as number) : NaN), completeUsd: null });
  done();
}

void main();
