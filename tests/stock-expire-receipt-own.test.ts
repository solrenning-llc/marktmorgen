/**
 * A stock hold is let go only on Stripe's expiry receipt for its own checkout (board #5285, row #4455: the rule-30
 * siblings Claude 5 named on #4455, where payment requests already check `closed.id`). releaseStockHold,
 * releaseCartStockHolds and the failure path of withCartStockHolds close a checkout at Stripe and then hand its units
 * back. An answer of `status: "expired"` that names another session says nothing about this checkout, which may
 * still be open and be paid, so it must hand nothing back and leave the hold where it is.
 *
 * Synthetic only: the Redis stub and a mocked Stripe whose expire answer can name another session.
 */
import { parseProduct } from "@/lib/catalog";
import { releaseCartStockHolds, releaseStockHold, stockLeft, withCartStockHolds } from "@/lib/stock";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { liveStockStore } from "./stock-live-store";

const creator = liveStockStore({ statsId: "r".repeat(32), stripeAccountId: "acct_test_expireown1" } as Store, "e1".repeat(16), "expire-own@example.invalid");
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;

/** When set, the expire answer names this session instead of the one in the path. */
let answerFor: string | null = null;
/** When set, a read of a checkout names this session; and the status that read gives. */
let readFor: string | null = null;
let readStatus = "expired";
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && expire && (init?.method ?? "GET") === "POST") {
    asked.push(expire[1]);
    return new Response(JSON.stringify({ id: answerFor ?? expire[1], status: "expired" }));
  }
  // A lapsed hold's checkout, read when stock is counted: its status, and the session the answer names.
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && one && (init?.method ?? "GET") === "GET") {
    return new Response(JSON.stringify({ id: readFor ?? one[1], status: readStatus, payment_status: readStatus === "complete" ? "paid" : "unpaid" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const field = async (product: Listing, session: string) =>
  (await redis.pipeline([["HGET", `nl:stock:${creator.statsId}:${product.id}`, session]]))[0];
const hold = (product: Listing, session: string) =>
  redis.pipeline([["HSET", `nl:stock:${creator.statsId}:${product.id}`, session, JSON.stringify({ until: Date.now() + 30 * 60 * 1000 })]]);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("A product checkout's hold");
  const a = limited("printA", 3);
  await hold(a, "cs_test_expireownprod01");
  answerFor = "cs_test_expireownother1";
  const wrong = await releaseStockHold(creator, a, "cs_test_expireownprod01");
  is("control: Stripe was asked to close this checkout", asked.includes("cs_test_expireownprod01"), true);
  is("an expired receipt for another checkout hands nothing back", wrong, false);
  is("and the hold stays where it was", (await field(a, "cs_test_expireownprod01")) !== null, true);
  answerFor = null;
  is("control: its own receipt hands it back", await releaseStockHold(creator, a, "cs_test_expireownprod01"), true);

  part("A cart checkout's holds");
  const b = limited("printB", 3);
  const c = limited("printC", 3);
  await hold(b, "cs_test_expireowncart01");
  await hold(c, "cs_test_expireowncart01");
  answerFor = "cs_test_expireownother2";
  is("an expired receipt for another checkout hands nothing back", await releaseCartStockHolds(creator, [b, c], "cs_test_expireowncart01"), false);
  is("and both holds stay", [(await field(b, "cs_test_expireowncart01")) !== null, (await field(c, "cs_test_expireowncart01")) !== null], [true, true]);
  answerFor = null;
  is("control: its own receipt hands them back", await releaseCartStockHolds(creator, [b, c], "cs_test_expireowncart01"), true);

  part("A cart checkout whose holds could not be written");
  const d = limited("printD", 3);
  const original = redis.pipeline.bind(redis);
  // The hand-over (STOCK_BIND) gets no answer, so the checkout is closed at Stripe and its holds wait on the receipt.
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:stock-bind:") && command.includes("cs_test_expireownbind01"))
      ? []
      : original(commands)) as typeof redis.pipeline;
  answerFor = "cs_test_expireownother3";
  const unbound = await withCartStockHolds(creator, [d], async () => ({ id: "cs_test_expireownbind01" }));
  redis.pipeline = original;
  is("nobody is sent to it", unbound, { ok: false, reason: "busy" });
  is("control: Stripe was asked to close it", asked.includes("cs_test_expireownbind01"), true);
  is("an expired receipt for another checkout lets none of its units go", await stockLeft(creator, d), 2);
  answerFor = null;

  part("Counting stock: a lapsed hold whose checkout is read at Stripe");
  const e = limited("printE", 3);
  const lapsed = (session: string) =>
    redis.pipeline([["HSET", `nl:stock:${creator.statsId}:${e.id}`, session, JSON.stringify({ until: Date.now() - 60_000 })]]);
  await lapsed("cs_test_expireownread001");
  readFor = "cs_test_expireownother4";
  readStatus = "expired";
  is("a read naming another, expired checkout lets none of this one's units go", await stockLeft(creator, e), 2);
  is("and its hold stays", (await field(e, "cs_test_expireownread001")) !== null, true);
  await lapsed("cs_test_expireownread001");
  readStatus = "complete";
  is("a read naming another, paid checkout does not mark this one sold either: the unit stays held", await stockLeft(creator, e), 2);
  is("and its hold stays, not written as a sale", (await field(e, "cs_test_expireownread001")) !== null, true);
  readFor = null;
  readStatus = "expired";
  is("control: its own expired checkout lets the unit go", await stockLeft(creator, e), 3);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
