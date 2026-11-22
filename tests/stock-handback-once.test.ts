/**
 * A stock hold is handed back once (Codex X5's and Codex L's MÉDIO on #4409): releaseStockHold and
 * releaseCartStockHolds read the hold, close the old checkout at Stripe and answer true, which lets the checkout
 * route skip holdAdmission. With no claim, parallel requests carrying the same nl_stock_hold cookie all read the old
 * hold, all get the session back as "expired" and all answer true, so one admitted hold became several, beyond
 * HOLDS_PER_ADDRESS. Each held checkout now carries exactly one hand-back, taken by the first answer that proves
 * Stripe closed it (nl:stock:back:, SET NX, only while its hold is live); a repeat, by the product checkout or the
 * cart, may still clean the fields but answers false; an unknown Redis reply answers false.
 *
 * Synthetic only: the Redis stub and a mocked Stripe whose expire answers wait at a barrier until both requests
 * have read the hold.
 */
import { parseProduct } from "@/lib/catalog";
import { releaseCartStockHolds, releaseStockHold } from "@/lib/stock";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const creator = { statsId: "h".repeat(32), stripeAccountId: "acct_test_handback1" } as Store;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const a = limited("printA", 3);
const b = limited("printB", 3);

/** Expire answers wait here until `waitFor` requests have arrived, so every request has read the hold first. */
let waitFor = 0;
let arrived = 0;
let open: (() => void) | null = null;
let gate: Promise<void> = Promise.resolve();
function barrier(n: number): void {
  waitFor = n; arrived = 0;
  gate = new Promise<void>((resolve) => { open = resolve; });
}
const expired: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && expire && (init?.method ?? "GET") === "POST") {
    arrived += 1;
    if (arrived >= waitFor) open?.();
    await gate;
    expired.push(expire[1]);
    return new Response(JSON.stringify({ id: expire[1], status: "expired" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const hold = (product: Listing, session: string, until = Date.now() + 30 * 60 * 1000) =>
  redis.pipeline([["HSET", `nl:stock:${creator.statsId}:${product.id}`, session, JSON.stringify({ until })]]);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("Two requests with the same cookie, through the product checkout: one hand-back");
  await hold(a, "cs_test_handbacktwin0001");
  barrier(2);
  const twins = await Promise.all([releaseStockHold(creator, a, "cs_test_handbacktwin0001"), releaseStockHold(creator, a, "cs_test_handbacktwin0001")]);
  is("control: both read the hold and both asked Stripe to close it", expired.filter((s) => s === "cs_test_handbacktwin0001").length, 2);
  is("exactly one answers true; the other goes through holdAdmission", twins.filter(Boolean).length, 1);
  barrier(1);
  is("asked again later, the same checkout hands nothing back", await releaseStockHold(creator, a, "cs_test_handbacktwin0001"), false);

  part("One through the product checkout and one through the cart: still one hand-back");
  await hold(a, "cs_test_handbackmixed001");
  await hold(b, "cs_test_handbackmixed001");
  barrier(2);
  const mixed = await Promise.all([releaseStockHold(creator, a, "cs_test_handbackmixed001"), releaseCartStockHolds(creator, [a, b], "cs_test_handbackmixed001")]);
  is("exactly one of the two answers true", mixed.filter(Boolean).length, 1);

  part("Two carts with the same cookie: one hand-back");
  await hold(a, "cs_test_handbackcarts001");
  await hold(b, "cs_test_handbackcarts001");
  barrier(2);
  const carts = await Promise.all([releaseCartStockHolds(creator, [a, b], "cs_test_handbackcarts001"), releaseCartStockHolds(creator, [a, b], "cs_test_handbackcarts001")]);
  is("exactly one answers true", carts.filter(Boolean).length, 1);

  part("A hold that already ran out hands nothing back");
  await hold(a, "cs_test_handbacklapsed01", Date.now() - 1000);
  barrier(1);
  is("its checkout is closed, but no admission is skipped", await releaseStockHold(creator, a, "cs_test_handbacklapsed01"), false);

  part("An unknown reply to the claim answers false");
  await hold(a, "cs_test_handbackunknown1");
  barrier(1);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipeline(commands);
    return commands.some(([name, key]) => name === "SET" && String(key).startsWith("nl:stock:back:")) ? replies.map(() => undefined) : replies;
  }) as typeof redis.pipeline;
  const unknown = await releaseStockHold(creator, a, "cs_test_handbackunknown1").catch(() => false);
  redis.pipeline = pipeline as typeof redis.pipeline;
  is("a claim whose answer did not come back is not a hand-back", unknown, false);

  part("Control: a single hand-back still works");
  await hold(b, "cs_test_handbacksingle01");
  barrier(1);
  is("one request, one live hold: true", await releaseStockHold(creator, b, "cs_test_handbacksingle01"), true);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
