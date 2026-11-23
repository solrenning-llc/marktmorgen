/**
 * A call's time is let go only on Stripe's expiry receipt for its own checkout (board #5285, row #4455: the rule-30
 * siblings Claude 5 named on #4455, where payment requests already check `closed.id`). lib/calls.ts closes a call's
 * checkout at Stripe in two places and then lets its time go: releaseOwnHold (through expireCheckout) deletes the hold
 * from the diary, and holdAndCheckout, when the hold could not be written (through closeUnheld), lets the owner's
 * claim on that time go. An answer of `status: "expired"` that names another session says nothing about this
 * checkout, which may still be open and be paid, so the time must stay held.
 *
 * Against the real code with the Redis stand-in and a Stripe stand-in whose expire answer can name another session;
 * synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, releaseOwnHold } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { claimsKey, hostId } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";
import { runCallLockWaitsAtOnce } from "./calls-lock-wait";

const HOUR = 3_600_000;
const NY = "America/New_York";
const HOLD_SCRIPT = "-- marktmorgen:call-hold-if-locked:v1\n";

/** When set, the expire answer names this session instead of the one in the path. */
let answerFor: string | null = null;
let opened = 0;
const expired: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_callexpireown${String(opened).padStart(6, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const closing = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
  if (method === "POST" && closing) {
    expired.push(decodeURIComponent(closing[1]));
    return answer({ id: answerFor ?? closing[1], object: "checkout.session", status: "expired" });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** Replaces the hold script's reply, to make the hold unwritten as when the lock was lost. */
let holdReply: unknown = undefined;
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  const replies = await run(commands);
  return commands.map((c, i) => (c[0] === "EVAL" && holdReply !== undefined && String(c[1]).startsWith(HOLD_SCRIPT) ? holdReply : replies[i]));
};
runCallLockWaitsAtOnce();

const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []],
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

async function callStore(email: string, handle: string, account: string): Promise<{ store: Store; call: CallListing; full: Product & { call: CallSetup } }> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  return { store, call, full };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  const w = await callStore("expireown@example.invalid", "expireown", "acct_1CallExpireOwnA");
  const diary = `nl:call:busy:${w.store.callsId}`;
  const T = weekdayAt(9, 600);

  part("A hold released by its buyer (releaseOwnHold)");
  const session = "cs_test_callexpireownheld01";
  await run([["HSET", diary, String(T), JSON.stringify({ e: T + HOUR, until: Date.now() + 30 * 60_000, session })]]);
  answerFor = "cs_test_callexpireownother1";
  await releaseOwnHold(w.store, session);
  is("control: Stripe was asked to close this checkout", expired.includes(session), true);
  is("an expired receipt for another checkout leaves the hold in the diary", (await run([["HGET", diary, String(T)]]))[0] !== null, true);
  answerFor = null;
  await releaseOwnHold(w.store, session);
  is("control: its own receipt lets the hold go", (await run([["HGET", diary, String(T)]]))[0], null);

  part("A checkout whose hold could not be written (holdAndCheckout, closeUnheld)");
  const owner = claimsKey(hostId(w.store.email));
  await run([["DEL", diary], ["DEL", owner]]);
  holdReply = 0;
  answerFor = "cs_test_callexpireownother2";
  const before = expired.length;
  const refused = await holdAndCheckout({ store: w.store, product: w.full, start: T, buyerTz: NY, origin: "https://marktmorgen.com" });
  holdReply = undefined;
  answerFor = null;
  is("refused, and the checkout it opened is asked to close", [refused.ok, expired.length - before], [false, 1]);
  is("an expired receipt for another checkout keeps the owner's claim on that time", Number((await run([["HLEN", owner]]))[0]) > 0, true);

  await run([["DEL", diary], ["DEL", owner]]);
  holdReply = 0;
  const control = await holdAndCheckout({ store: w.store, product: w.full, start: T, buyerTz: NY, origin: "https://marktmorgen.com" });
  holdReply = undefined;
  is("control: refused again, and its own receipt lets the owner's claim go", [control.ok, Number((await run([["HLEN", owner]]))[0])], [false, 0]);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
