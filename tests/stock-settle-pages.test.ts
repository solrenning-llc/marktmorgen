/**
 * What a page's count of a limited product bills when it settles holds that ran out (Claude 5's MÉDIO on #4472,
 * 6914268559): pages that read the record at the same time all see the same lapsed holds, all ask Stripe, and each
 * sent its own STOCK_SELL a hold, two or three billed commands each, priced by no line ("each hold is settled once"
 * was not true for pages at the same time). An unknown cost is never zero.
 *
 * Checked against the real lib/stock.ts with the memory Redis (lib/redis-memory.ts, which bills a script's own calls
 * as Upstash does), Stripe mocked, nothing real:
 *   - one page settling MAX_CHECKS lapsed holds Stripe says are paid bills its one read and at most one HDEL and one
 *     STOCK_SELL, whatever the number of holds (STOCK_PAGE_SETTLE_COMMANDS_MOST in tests/plan-cost-registry.ts);
 *   - pages counting at the same time each stay inside that, so the total is at most that a page, paid by each page's
 *     own public request; the count is right, every unit sold once;
 *   - holds Stripe says expired are let go in the same bound, and a mix of both too;
 *   - a settling write that fails leaves the holds counted as used (never a unit too many) and the next page settles them;
 *   - STOCK_SELL refuses more checkouts than a page asks Stripe about.
 */
import { parseProduct } from "@/lib/catalog";
import { STOCK_SELL, stockLeft } from "@/lib/stock";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { STOCK_SELL_COMMANDS } from "./plan-cost-registry";

/** lib/stock.ts MAX_CHECKS: the most lapsed holds one count asks Stripe about. */
const MAX_CHECKS = 5;
/** A page's stock count at its worst: its one read, one HDEL of the holds let go, and one STOCK_SELL. */
const PAGE_MOST = 1 + 1 + STOCK_SELL_COMMANDS;

const creator = { statsId: "t".repeat(32), stripeAccountId: "acct_test_stocksettlepages" } as Store;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const key = (id: string) => `nl:stock:${creator.statsId}:${id}`;
const session = (i: number) => `cs_live_c3${String(i).padStart(56, "0")}`;

/** Stripe answers after a short wait, so pages started together all read the record before any settles it. */
const answers = new Map<string, "paid" | "expired">();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname !== "api.stripe.com" || !one) return new Response("{}", { status: 404 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const answer = answers.get(one[1]) ?? "expired";
  return new Response(JSON.stringify(answer === "paid" ? { id: one[1], status: "complete", payment_status: "paid" } : { id: one[1], status: "expired", payment_status: "unpaid" }));
}) as typeof fetch;

/** Every command a pipeline sends, plus the calls the memory model runs inside a script: what Upstash bills. */
async function billed<T>(work: () => Promise<T>): Promise<{ commands: number; value: T }> {
  const original = redis.pipeline;
  let commands = 0;
  redis.pipeline = async (batch) => {
    commands += batch.length;
    return original(batch);
  };
  const before = redis.scriptCalls;
  try {
    const value = await work();
    return { commands: commands + (redis.scriptCalls - before), value };
  } finally {
    redis.pipeline = original;
  }
}

async function lapsed(id: string, from: number, paid: number, expired: number): Promise<void> {
  const until = Date.now() - 60_000;
  for (let i = 0; i < paid + expired; i += 1) {
    answers.set(session(from + i), i < paid ? "paid" : "expired");
    await redis.pipeline([["HSET", key(id), session(from + i), JSON.stringify({ until })]]);
  }
}

async function soldOf(id: string): Promise<{ sold: unknown; fields: number }> {
  const [sold, length] = (await redis.pipeline([["HGET", key(id), "#sold"], ["HLEN", key(id)]])) as [unknown, number];
  return { sold, fields: Number(length) - (sold === null ? 0 : 1) };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("One page settling MAX_CHECKS lapsed holds Stripe says are paid");
  const one = limited("ss_one", 20);
  await lapsed(one.id, 0, MAX_CHECKS, 0);
  const page = await billed(() => stockLeft(creator, one));
  is("the count is right", page.value, 20 - MAX_CHECKS);
  is(`its stock bills at most ${PAGE_MOST} commands, whatever the number of holds (measured ${page.commands})`, page.commands <= PAGE_MOST, true);
  is("every unit counted once, no field left", await soldOf(one.id), { sold: String(MAX_CHECKS), fields: 0 });
  const after = await billed(() => stockLeft(creator, one));
  is("the next page reads once and writes nothing", [after.value, after.commands], [20 - MAX_CHECKS, 1]);

  part("Eight pages counting the same lapsed holds at the same time");
  const shared = limited("ss_shared", 20);
  await lapsed(shared.id, 10, MAX_CHECKS, 0);
  const pages = 8;
  const together = await billed(() => Promise.all(Array.from({ length: pages }, () => stockLeft(creator, shared))));
  is("every page sees the right count", together.value, Array.from({ length: pages }, () => 20 - MAX_CHECKS));
  is(`the pages bill at most ${PAGE_MOST} commands each, ${pages * PAGE_MOST} in all (measured ${together.commands})`, together.commands <= pages * PAGE_MOST, true);
  is("every unit sold once, however many pages settled it", await soldOf(shared.id), { sold: String(MAX_CHECKS), fields: 0 });

  part("Holds Stripe says expired, and a mix of both");
  const gone = limited("ss_gone", 20);
  await lapsed(gone.id, 20, 0, MAX_CHECKS);
  const let_ = await billed(() => stockLeft(creator, gone));
  is("all handed back", let_.value, 20);
  is(`inside ${PAGE_MOST} commands (measured ${let_.commands})`, let_.commands <= PAGE_MOST, true);
  is("nothing counted as sold", await soldOf(gone.id), { sold: null, fields: 0 });
  const mixed = limited("ss_mixed", 20);
  await lapsed(mixed.id, 30, 3, 2);
  const mix = await billed(() => Promise.all(Array.from({ length: 4 }, () => stockLeft(creator, mixed))));
  is("three sold, two handed back, on every page", mix.value, [17, 17, 17, 17]);
  is(`four pages at once inside ${PAGE_MOST} commands each (measured ${mix.commands})`, mix.commands <= 4 * PAGE_MOST, true);
  is("the three counted once", await soldOf(mixed.id), { sold: "3", fields: 0 });

  part("A settling write that fails never sells a unit too many");
  const failing = limited("ss_failing", 6);
  await lapsed(failing.id, 40, MAX_CHECKS, 0);
  const original = redis.pipeline;
  redis.pipeline = async (batch) => {
    if (batch.some((command) => command[0] === "EVAL" || command[0] === "HDEL")) throw new Error("synthetic write failure");
    return original(batch);
  };
  let refused: number | null;
  try {
    refused = await stockLeft(creator, failing);
  } finally {
    redis.pipeline = original;
  }
  is("the paid holds still count as used", refused, 1);
  is("and the next page settles them", [await stockLeft(creator, failing), await soldOf(failing.id)], [1, { sold: String(MAX_CHECKS), fields: 0 }]);

  part("STOCK_SELL itself");
  const direct = limited("ss_direct", 20);
  await lapsed(direct.id, 50, 2, 0);
  const two = await billed(() => redis.pipeline([["EVAL", STOCK_SELL, 1, key(direct.id), session(50), session(51)]]));
  is("two checkouts in one script: both counted, the EVAL, one HDEL and one HINCRBY", [two.value, two.commands], [[2], STOCK_SELL_COMMANDS]);
  const again = await billed(() => redis.pipeline([["EVAL", STOCK_SELL, 1, key(direct.id), session(50), session(51)]]));
  is("told again: the EVAL and its HDEL, nothing counted", [again.value, again.commands, (await soldOf(direct.id)).sold], [[0], 2, "2"]);
  const many = Array.from({ length: MAX_CHECKS + 1 }, (_, i) => session(60 + i));
  is("more checkouts than a page asks Stripe about: refused", await redis.pipeline([["EVAL", STOCK_SELL, 1, key(direct.id), ...many]]), [-1]);

  done();
}

void main();
