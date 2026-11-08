/**
 * One click waits on Stripe for at most one wave of checks (Claude 5's
 * review of #1732, 6 November 2026, LEVE in lib/stock.ts withCartStockHolds).
 *
 * A count refused only for holds that ran out has those holds settled once
 * the locks are let go (stockLeft asks Stripe about each, at most MAX_CHECKS,
 * each for at most CHECK_MS), and is counted again. When the write that
 * settles them is refused while reads still answer, the second count finds
 * the same holds: it must answer "busy" at once, not ask Stripe a second
 * time, so one click never waits longer than CART_STOCK_STRIPE_WAIT_MS.
 * Checked with Redis stubbed and Stripe mocked:
 *
 *   - the settling write refused: "busy", one wave of Stripe checks, nothing opened;
 *   - the settling write accepted: the first click opens (Claude 4's F2 on #1732);
 *   - a unit held by a checkout still open: "Sold out", Stripe not asked.
 */
import { parseProduct } from "@/lib/catalog";
import { withStockHold } from "@/lib/stock";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** MAX_CHECKS in lib/stock.ts: the holds that ran out one count asks Stripe about. */
const MAX_LAPSED = 5;
const gets: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && one && method === "GET") {
    gets.push(one[1]);
    return new Response(JSON.stringify({ id: one[1], status: "expired" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const creator = { statsId: "r".repeat(32), stripeAccountId: "acct_1TestRecount1" } as Store;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const key = (id: string) => `nl:stock:${creator.statsId}:${id}`;
const lapsed = (id: string, i: number) => `cs_test_lapsed${id}${String(i).padStart(6, "0")}`;

/** Fills a product's stock with holds that ran out a second ago, each a checkout Stripe says expired. */
async function fillWithLapsed(id: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await redis.pipeline([["HSET", key(id), lapsed(id, i), JSON.stringify({ until: Date.now() - 1000 })]]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);

  part("The write that settles the lapsed holds is refused, reads still answer");
  await fillWithLapsed("recount1", MAX_LAPSED);
  // Upstash out of memory, or a write error while reads still answer: only the HDEL that lets a lapsed hold go is refused.
  redis.pipeline = async (batch) => {
    if (batch.some((command) => command[0] === "HDEL" && String(command[2] ?? "").startsWith("cs_test_lapsed"))) throw new Error("OOM command not allowed");
    return original(batch);
  };
  let opened = 0;
  gets.length = 0;
  try {
    const result = await withStockHold(creator, limited("recount1", MAX_LAPSED), async () => {
      opened += 1;
      return { id: "cs_test_recountopen0001" };
    });
    is("the click is told to press again, never Sold out", result, { ok: false, reason: "busy" });
    is("nothing is opened", opened, 0);
    is("Stripe is asked about the lapsed holds once, never a second wave", gets.length, MAX_LAPSED);
  } finally {
    redis.pipeline = original;
  }

  part("Controls: what is known decides as before");
  await fillWithLapsed("recount2", MAX_LAPSED);
  gets.length = 0;
  const freed = await withStockHold(creator, limited("recount2", MAX_LAPSED), async () => {
    opened += 1;
    return { id: "cs_test_recountopen0002" };
  });
  is("the settling write accepted: the first click opens", [freed.ok, opened], [true, 1]);
  is("after one wave of Stripe checks", gets.length, MAX_LAPSED);

  await redis.pipeline([["HSET", key("recount3"), "cs_test_recountheld0001", JSON.stringify({ until: Date.now() + 60_000 })]]);
  gets.length = 0;
  const held = await withStockHold(creator, limited("recount3", 1), async () => {
    opened += 1;
    return { id: "cs_test_recountopen0003" };
  });
  is("a unit held by a checkout still open: Sold out", held, { ok: false, reason: "soldout" });
  is("and Stripe is not asked", [gets.length, opened], [0, 1]);

  part("Stripe cannot be read about the lapsed holds: an unknown count is never Sold out (Claude 6's LOW on #1732)");
  // stockLeft throws when a lapsed hold's checkout cannot be read; the click is told to press again, as for a count
  // that does not settle, never "Sold out" on that guess.
  await fillWithLapsed("recount4", MAX_LAPSED);
  const stripe = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  try {
    const unknown = await withStockHold(creator, limited("recount4", MAX_LAPSED), async () => {
      opened += 1;
      return { id: "cs_test_recountopen0004" };
    });
    is("Stripe down while the lapsed holds are asked about: press again, never Sold out", unknown, { ok: false, reason: "busy" });
    is("and nothing is opened", opened, 1);
  } finally {
    globalThis.fetch = stripe;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
