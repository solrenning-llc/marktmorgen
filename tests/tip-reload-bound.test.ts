/**
 * Reloading a paid tip's thank-you page (app/[handle]/tip/page.tsx) asked
 * the creator's Stripe account again on every reload, for the two days the
 * checkout's mark lives, bounded only by the store's window (review of #3331,
 * Claude 5, LOW 1). The page now remembers Stripe's "paid" answer in that same
 * mark, for what is left of its two days, and draws the thanks from it.
 *
 * Checked, with the real page and lib/store-tip-checkout.ts against the
 * in-memory Redis, Stripe stood in by a fetch stub:
 * - a paid gift asks Stripe once; every reload after it thanks the supporter
 *   with the same amount and no Stripe call (the bound);
 * - "paid" is never shown before Stripe said so once: an unpaid checkout, one
 *   that is not a gift, another store's, or a Stripe error is not remembered,
 *   and is asked again on the next reload, as before;
 * - the remembered answer keeps the mark's two days and never stretches them;
 * - a remembered answer read in any other shape is "waiting" with no Stripe
 *   call (CX-123 rule 24), and an unknown reply while remembering never
 *   changes what Stripe just said, and leaves the next reload as it was;
 * - the mark follows the store's own id, so a supporter coming back after the
 *   owner changed their login address is still thanked (Claude 2, LOW 1).
 *
 * Synthetic store; nothing real is called.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import TipPage from "@/app/[handle]/tip/page";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, setTips, storeForEmail } from "@/lib/store";
import { createTipCheckout, readTip, TIP_MARK_SECONDS } from "@/lib/store-tip-checkout";
import { answering } from "./security/next-headers";
import { store as redis, advance } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "tip-reload@example.com";
const HANDLE = "tipreload";
process.env.STRIPE_SECRET_KEY = "sk_test_tip_reload_only";

let nextId = 0;
const sessionIds: string[] = [];
let stripeReads: string[] = [];
let stripeSession: (id: string) => Record<string, unknown> | null = () => null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    const id = `cs_test_${String(++nextId).padStart(24, "r")}`;
    sessionIds.push(id);
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const id = decodeURIComponent(path.slice("/checkout/sessions/".length));
    stripeReads.push(id);
    const session = stripeSession(id);
    return session ? answer(session) : answer({ error: { message: "No such checkout.session" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, amount = 500, currency = "usd") => ({ id, status: "complete", payment_status: "paid", amount_total: amount, currency, metadata: { store: HANDLE, kind: "tip" } });

/** Every command lib/store-tip-checkout.ts sends about a tip mark, and the mark's key. */
const markCommands: string[][] = [];
const original = redis.pipeline.bind(redis);
redis.pipeline = async (list) => {
  for (const c of list) if (String(c[1] ?? "").startsWith("nl:tip:co:")) markCommands.push(c.map(String));
  return original(list);
};

/** The one command for a tip mark answered `reply` instead of Redis, when `match` says so. */
async function withReply<T>(match: (c: (string | number)[]) => boolean, reply: (real: unknown[]) => unknown, run: () => Promise<T>): Promise<T> {
  const before = redis.pipeline;
  redis.pipeline = async (list) => {
    const real = await before(list);
    return list.length === 1 && String(list[0][1]).startsWith("nl:tip:co:") && match(list[0]) ? (reply(real) as unknown[]) : real;
  };
  try {
    return await run();
  } finally {
    redis.pipeline = before;
  }
}
const isGet = (c: (string | number)[]) => c[0] === "GET";
const isTtl = (c: (string | number)[]) => c[0] === "TTL" || c[0] === "PTTL";
const isRemember = (c: (string | number)[]) => c[0] === "SET";

async function drawn(sessionId: string): Promise<string> {
  answering(new NextRequest(`https://marktmorgen.com/@${HANDLE}/tip?session_id=${sessionId}`, { headers: { "x-forwarded-for": "203.0.113.10" } }));
  const node = await TipPage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve({ session_id: sessionId }) });
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return await new Response(stream).text();
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Tip Reload", "Pots.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_tipreload001", subscriptionId: "sub_tipreload001", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_tipreload000001", true);
  await setTips(OWNER, { on: true, heading: "", line: "", amounts: [] });
  const store = (await storeForEmail(OWNER))!;
  const open = async () => (await createTipCheckout(store, "https://marktmorgen.com", 500)).id;

  part("A paid gift asks Stripe once; reloads are thanked from the remembered answer");
  stripeSession = (id) => paid(id, 1_250, "eur");
  const a = await open();
  stripeReads = [];
  is("first return: thanked with what Stripe took (healthy path)", await readTip(store, a), { state: "paid", amount: 1_250, currency: "eur" });
  is("first return: one Stripe read", stripeReads, [a]);
  stripeReads = [];
  const reloads = [];
  for (let k = 0; k < 6; k++) reloads.push(await readTip(store, a));
  is("six reloads: the same thanks each time", reloads.every((r) => JSON.stringify(r) === JSON.stringify({ state: "paid", amount: 1_250, currency: "eur" })), true);
  is("six reloads: no Stripe call", stripeReads, []);
  const page = await drawn(a);
  is("the page reloaded: thanks the supporter, with the amount", page.includes("Thank you for your support") && page.includes("12.50"), true);
  is("the page reloaded: no Stripe call", stripeReads, []);

  part("\"Paid\" is never shown before Stripe said so once");
  const b = await open();
  stripeSession = (id) => ({ ...paid(id), status: "open", payment_status: "unpaid" });
  stripeReads = [];
  is("unpaid: not confirmed", (await readTip(store, b)).state, "waiting");
  is("unpaid, reloaded: asked again (not remembered)", [(await readTip(store, b)).state, stripeReads.length], ["waiting", 2]);
  stripeSession = (id) => paid(id);
  stripeReads = [];
  is("paid since: thanked once Stripe says so", [await readTip(store, b), stripeReads.length], [{ state: "paid", amount: 500, currency: "usd" }, 1]);
  const c = await open();
  stripeSession = (id) => ({ ...paid(id), metadata: { store: HANDLE, kind: "product" } });
  stripeReads = [];
  await readTip(store, c);
  is("not a gift: not confirmed, and asked again on reload", [(await readTip(store, c)).state, stripeReads.length], ["waiting", 2]);
  const d = await open();
  stripeSession = (id) => ({ ...paid(id), metadata: { store: "someone-else", kind: "tip" } });
  stripeReads = [];
  await readTip(store, d);
  is("another store's gift: not confirmed, and asked again on reload", [(await readTip(store, d)).state, stripeReads.length], ["waiting", 2]);
  const e = await open();
  stripeSession = () => null;
  stripeReads = [];
  await readTip(store, e);
  is("Stripe answers 404: not confirmed, and asked again on reload", [(await readTip(store, e)).state, stripeReads.length], ["waiting", 2]);

  part("The remembered answer keeps the mark's two days");
  stripeSession = (id) => paid(id);
  const f = await open();
  advance((TIP_MARK_SECONDS - 3_600) * 1000);
  stripeReads = [];
  is("paid near the end of the two days: thanked", (await readTip(store, f)).state, "paid");
  advance(1_800 * 1000);
  is("half an hour later: still thanked, no Stripe call", [(await readTip(store, f)).state, stripeReads.length], ["paid", 1]);
  advance(3_600 * 1000);
  stripeReads = [];
  is("past the two days from the checkout: nothing confirmed, nothing asked", [(await readTip(store, f)).state, stripeReads.length], ["waiting", 0]);

  part("A remembered answer read in any other shape is not confirmed, and never reaches Stripe (rule 24)");
  stripeSession = (id) => paid(id);
  const g = await open();
  await readTip(store, g);
  const shapes: [string, (real: unknown[]) => unknown][] = [
    ["no amount", () => ["paid:usd"]],
    ["an amount that is not a number", () => ["paid:abc:usd"]],
    ["a currency that is not one", () => ["paid:500:US"]],
    ["a negative amount", () => ["paid:-5:usd"]],
    ["an amount with a sign", () => ["paid:+5:usd"]],
    ["two replies for one command", (real) => [...real, "1"]],
    ["the answer inside a list", (real) => [real]],
    ["a number", () => [500]],
    ["no reply", () => []],
  ];
  for (const [label, reply] of shapes) {
    stripeReads = [];
    const outcome = await withReply(isGet, reply, () => readTip(store, g));
    is(`${label}: not confirmed, no Stripe call`, [outcome.state, stripeReads.length], ["waiting", 0]);
  }
  stripeReads = [];
  is("read exactly again: thanked, no Stripe call", [(await readTip(store, g)).state, stripeReads.length], ["paid", 0]);

  part("An unknown reply while remembering never changes what Stripe said, and the next reload is as before");
  // [what, which command, its reply, Stripe reads on the next reload]: an unknown time left writes nothing, so the
  // next reload asks Stripe as before; an unknown reply to the write itself may have been written, and either way
  // the next reload is thanked only from the exact remembered answer or from Stripe.
  const unknowns: [string, (c: (string | number)[]) => boolean, (real: unknown[]) => unknown, number][] = [
    ["time left answered as a word", isTtl, () => ["x"], 1],
    ["time left answered as gone", isTtl, () => [-2], 1],
    ["time left answered as no expiry", isTtl, () => [-1], 1],
    ["time left answered as no reply", isTtl, () => [], 1],
    ["time left answered as two replies", isTtl, (real) => [...real, 5], 1],
    ["remembering answered as a number", isRemember, () => [1], 0],
    ["remembering answered as no reply", isRemember, () => [], 0],
  ];
  for (const [label, match, reply, next] of unknowns) {
    stripeSession = (id) => paid(id);
    const h = await open();
    stripeReads = [];
    const first = await withReply(match, reply, () => readTip(store, h));
    is(`${label}: thanked, Stripe having said so`, [first.state, stripeReads.length], ["paid", 1]);
    stripeReads = [];
    is(`${label}: the next reload is thanked, with ${next} Stripe read`, [(await readTip(store, h)).state, stripeReads.length], ["paid", next]);
  }
  stripeSession = (id) => paid(id);
  const i = await open();
  stripeReads = [];
  const thrown = await withReply(isTtl, () => { throw new Error("Redis down"); }, () => readTip(store, i));
  is("Redis failing while remembering: thanked, Stripe having said so", [thrown.state, stripeReads.length], ["paid", 1]);

  part("The mark follows the store's own id (owner changes their login address)");
  stripeSession = (id) => paid(id);
  const j = await open();
  const moved = { ...store, email: "tip-reload-moved@example.com" };
  stripeReads = [];
  is("same store, new login address: thanked", (await readTip(moved, j)).state, "paid");
  const other = { ...store, email: "someone-else@example.com", sid: "0".repeat(32), extra: false };
  stripeReads = [];
  is("another store: nothing confirmed, nothing asked", [(await readTip(other, j)).state, stripeReads.length], ["waiting", 0]);

  part("The checkout still writes its mark as before");
  is("each checkout opened wrote one mark for two days", markCommands.filter((c) => c[0] === "SET" && c[2] === "1").every((c) => c.slice(3).join(" ") === `EX ${TIP_MARK_SECONDS}`), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
