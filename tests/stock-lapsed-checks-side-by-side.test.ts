/**
 * A store page waits on Stripe for one answer about a product's lapsed holds,
 * not five in a row (AX274, slow phones and slow networks; Claude 3's
 * performance audit of 13 November 2026).
 *
 * stockLeft (lib/stock.ts) asks Stripe about up to MAX_CHECKS holds that ran
 * out, each for at most CHECK_MS. The public store page, a collection, a
 * product's page, the embedded card and the open cart all draw on it, so
 * asked one after another a degraded Stripe held each of those pages for
 * MAX_CHECKS × CHECK_MS (10 s) before the first byte. Asked side by side, the
 * wait is one CHECK_MS, and nothing else changes: the same holds are asked
 * about, at most MAX_CHECKS of them, and the same count comes back.
 *
 * Checked with Redis stubbed and Stripe mocked, no network:
 *   - the lapsed holds are asked about at once (all MAX_CHECKS in flight together);
 *   - a Stripe that never answers holds the count for about one CHECK_MS, not five;
 *   - controls: still at most MAX_CHECKS asked, the rest counted as used, and the same count;
 *   - a whole page of limited products shares one budget (stockBudget): never more than
 *     STOCK_STRIPE_IN_FLIGHT questions at once to the creator's account, and none started
 *     after STOCK_STRIPE_WAIT_MS; what is not asked counts as used, the count unknown.
 */
import { parseProduct } from "@/lib/catalog";
import { STOCK_STRIPE_IN_FLIGHT, STOCK_STRIPE_WAIT_MS, stockBudget, stockLeft } from "@/lib/stock";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** MAX_CHECKS and CHECK_MS in lib/stock.ts. */
const MAX_LAPSED = 5;
const CHECK_MS = 2_000;

type Mode = "open" | "hang";
let mode: Mode = "open";
let inFlight = 0;
let mostInFlight = 0;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname !== "api.stripe.com" || !one || (init?.method ?? "GET") !== "GET") return new Response("{}", { status: 404 });
  asked.push(one[1]);
  inFlight += 1;
  mostInFlight = Math.max(mostInFlight, inFlight);
  try {
    if (mode === "hang") {
      // Stripe accepts the connection and never answers; only the caller's own ceiling ends the wait.
      await new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Still open at Stripe: a known holder of the unit, so it stays counted and is asked about again next time.
    return new Response(JSON.stringify({ id: one[1], status: "open" }));
  } finally {
    inFlight -= 1;
  }
}) as typeof fetch;

const creator = { statsId: "q".repeat(32), stripeAccountId: "acct_1TestSideBySide" } as Store;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const key = (id: string) => `nl:stock:${creator.statsId}:${id}`;

async function fillWithLapsed(id: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await redis.pipeline([["HSET", key(id), `cs_test_side${id}${String(i).padStart(6, "0")}`, JSON.stringify({ until: Date.now() - 1000 })]]);
}

function reset(next: Mode): void {
  mode = next;
  inFlight = 0;
  mostInFlight = 0;
  asked.length = 0;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("A product's lapsed holds are asked about side by side");
  await fillWithLapsed("side1", MAX_LAPSED);
  reset("open");
  const left = await stockLeft(creator, limited("side1", 8));
  is("every lapsed hold is asked about at once, not one after another", mostInFlight, MAX_LAPSED);
  is("each is asked about once", asked.length, MAX_LAPSED);
  is("and the count is the same: each checkout still open holds its unit", left, 8 - MAX_LAPSED);

  part("A Stripe that never answers holds the page for one ceiling, not five");
  await fillWithLapsed("side2", MAX_LAPSED);
  reset("hang");
  const started = Date.now();
  const unknownLeft = await stockLeft(creator, limited("side2", 8));
  const waited = Date.now() - started;
  is("the count waits about one CHECK_MS, never MAX_CHECKS of them", waited < CHECK_MS * 2, true);
  is("and every unanswered hold still counts as used, the safe way to be wrong", unknownLeft, 8 - MAX_LAPSED);

  part("Controls: what is asked and what is counted do not change");
  await fillWithLapsed("side3", MAX_LAPSED + 3);
  reset("open");
  const many = await stockLeft(creator, limited("side3", 10));
  is("still at most MAX_CHECKS holds are asked about", asked.length, MAX_LAPSED);
  is("the holds past it count as used without asking", many, 10 - (MAX_LAPSED + 3));
  reset("open");
  is("an unlimited product asks nothing", [await stockLeft(creator, parseProduct({ id: "side4", title: "Free", summary: "", priceCents: 2000, link: "https://example.com/side4" }) as Listing), asked.length], [null, 0]);

  part("A page of 24 limited products shares one budget");
  const page = Array.from({ length: 24 }, (_, i) => limited(`page${i}`, 8));
  for (const product of page) await fillWithLapsed(product.id, MAX_LAPSED);
  reset("open");
  const shared = stockBudget();
  const pageLeft = await Promise.all(page.map((product) => stockLeft(creator, product, undefined, shared)));
  is("never more than STOCK_STRIPE_IN_FLIGHT questions at once to the creator's account", [mostInFlight <= STOCK_STRIPE_IN_FLIGHT, mostInFlight > 1], [true, true]);
  is("every product still counted, each still-open checkout holding its unit", pageLeft.every((left) => left === 8 - MAX_LAPSED), true);

  for (const product of page) await fillWithLapsed(`${product.id}h`, MAX_LAPSED);
  reset("hang");
  const sharedHang = stockBudget();
  const hangStarted = Date.now();
  const hung = await Promise.all(page.map((product) => stockLeft(creator, limited(`${product.id}h`, 8), undefined, sharedHang)));
  const hangWaited = Date.now() - hangStarted;
  is("a Stripe that never answers holds the whole page for its budget, not a ceiling per wave", hangWaited < STOCK_STRIPE_WAIT_MS + 1_000, true);
  is("questions not asked in time are never asked late", asked.length <= STOCK_STRIPE_IN_FLIGHT * Math.ceil(STOCK_STRIPE_WAIT_MS / CHECK_MS), true);
  is("and every hold not answered counts as used: never more units than are free", hung.every((left) => left === 8 - MAX_LAPSED), true);

  done();
}

void main();
