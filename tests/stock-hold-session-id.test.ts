/**
 * A Stripe reply is about the checkout asked for only when it names it (Claude 5's find while reviewing #4455;
 * rule 24). The stock holds (lib/stock.ts) and the call holds (lib/calls.ts) let a unit or a time go on any reply whose
 * status was "expired", without reading whose: an answer about another checkout (a cached or misrouted reply, a
 * proxy's, another account's) handed back the last unit while the checkout that held it could still be paid, so it
 * could be sold twice, and a call's time booked twice. Now only a reply whose id is the session asked about counts;
 * any other is unknown, and nothing is handed back on it.
 *
 * What fails here:
 *   - a hold handed back, by the product checkout or the cart, on another session's "expired";
 *   - a lapsed hold let go by the stock count on another session's "expired" (or marked sold on its payment);
 *   - expiredFor true for any reply but the session's own "expired";
 *   - an expiry POST in lib/stock.ts or lib/calls.ts read without expiredFor;
 *   - the session's own "expired" no longer handing the hold back (control).
 * Synthetic only: the Redis stub and a mocked Stripe.
 */
import { readFileSync } from "node:fs";
import { parseProduct } from "@/lib/catalog";
import { expiredFor, ownSessionReply } from "@/lib/stripe-session-reply";
import { releaseCartStockHolds, releaseStockHold, stockLeft } from "@/lib/stock";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const creator = { statsId: "s".repeat(32), stripeAccountId: "acct_test_sessionid1" } as Store;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const a = limited("printA", 1);
const b = limited("printB", 1);
const OTHER = "cs_test_someoneelses0000001";

/** "own": the session asked about; "other": another session's id; "none": no id at all. */
let answer: "own" | "other" | "none" = "own";
let paidAnswer = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  const read = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  const asked = expire?.[1] ?? read?.[1];
  if (url.hostname === "api.stripe.com" && asked && (expire ? (init?.method ?? "GET") === "POST" : true)) {
    const id = answer === "own" ? asked : answer === "other" ? OTHER : undefined;
    const body = paidAnswer ? { id, status: "complete", payment_status: "paid" } : { id, status: "expired" };
    return new Response(JSON.stringify(body));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const key = (product: Listing) => `nl:stock:${creator.statsId}:${product.id}`;
const hold = (product: Listing, session: string, until = Date.now() + 30 * 60 * 1000) =>
  redis.pipeline([["HSET", key(product), session, JSON.stringify({ until })]]);
const holds = async (product: Listing, session: string) => (await redis.pipeline([["HEXISTS", key(product), session]]))[0];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("Whose reply it is");
  is("the session's own expired", expiredFor({ id: "cs_test_mine00000001", status: "expired" }, "cs_test_mine00000001"), true);
  is("another session's expired", expiredFor({ id: OTHER, status: "expired" }, "cs_test_mine00000001"), false);
  is("an expired with no id", expiredFor({ status: "expired" }, "cs_test_mine00000001"), false);
  is("its own, still open", expiredFor({ id: "cs_test_mine00000001", status: "open" }, "cs_test_mine00000001"), false);
  is("not an object", [expiredFor(null, "cs_test_mine00000001"), expiredFor([], "cs_test_mine00000001"), expiredFor("expired", "cs_test_mine00000001")], [false, false, false]);
  is("a reply about another session is no reply about this one", [ownSessionReply({ id: OTHER }, "cs_test_mine00000001"), ownSessionReply({ id: "cs_test_mine00000001", status: "open" }, "cs_test_mine00000001")], [null, { id: "cs_test_mine00000001", status: "open" }]);

  part("The product checkout and the cart hand nothing back on another session's expired");
  for (const kind of ["other", "none"] as const) {
    answer = kind;
    const one = `cs_test_productholds${kind}01`;
    await hold(a, one);
    is(`product: ${kind === "other" ? "another session's id" : "no id"}: nothing handed back`, [await releaseStockHold(creator, a, one), await holds(a, one)], [false, 1]);
    const cart = `cs_test_cartholds${kind}0001`;
    await hold(a, cart);
    await hold(b, cart);
    is(`cart: ${kind === "other" ? "another session's id" : "no id"}: nothing handed back`, [await releaseCartStockHolds(creator, [a, b], cart), await holds(a, cart), await holds(b, cart)], [false, 1, 1]);
    await redis.pipeline([["DEL", key(a)], ["DEL", key(b)]]);
  }

  part("The stock count lets a lapsed hold go only on its own checkout's answer");
  answer = "other";
  const lapsed = "cs_test_lapsedholdother01";
  await hold(a, lapsed, Date.now() - 1000);
  is("another session's expired: the unit stays held, nothing left to sell", [await stockLeft(creator, a), await holds(a, lapsed)], [0, 1]);
  paidAnswer = true;
  await stockLeft(creator, a);
  const kept = JSON.parse(String((await redis.pipeline([["HGET", key(a), lapsed]]))[0])) as { paid?: boolean };
  is("another session's payment: not marked sold on it either", kept.paid === true, false);
  paidAnswer = false;
  answer = "own";
  is("its own expired: let go, the unit is for sale again", [await stockLeft(creator, a), await holds(a, lapsed)], [1, 0]);

  part("Every expiry read goes through expiredFor");
  const stock = readFileSync("lib/stock.ts", "utf8");
  const calls = readFileSync("lib/calls.ts", "utf8");
  is("no status compared with \"expired\" directly in lib/stock.ts", /\.status\s*[!=]==\s*"expired"/.test(stock), false);
  is("nor in lib/calls.ts", /\.status\s*[!=]==\s*"expired"/.test(calls), false);
  is("lib/stock.ts's three expiry POSTs and lib/calls.ts's two read the reply with expiredFor", [(stock.match(/expiredFor\(/g) ?? []).length, (calls.match(/expiredFor\(/g) ?? []).length], [3, 2]);

  part("Control: the session's own expired still hands the hold back");
  answer = "own";
  await hold(b, "cs_test_ownexpiredhold01");
  is("one request, its own reply: true", await releaseStockHold(creator, b, "cs_test_ownexpiredhold01"), true);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
