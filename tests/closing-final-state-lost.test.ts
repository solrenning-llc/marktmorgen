/**
 * A store in its closing day whose closing state was lost is held, never taken as having its members' renewals
 * stopped (Claude 7's hunt, MÉDIO money). closeOne used to rebuild a missing or foreign state as
 * `{ of, renewals: now }`, so closingDay skipped stopRenewals: the store closed while its members' subscriptions
 * kept renewing on the creator's account. The state can go while the store is in the final line when two runs
 * overlap: one puts it in FINAL_INDEX, the other sees a plan again and deletes the state.
 *
 * Now its day is read back from the mark its closing day wrote on its address for this same ending (markShut): only
 * { of, day } is rebuilt and the closing day runs again. A member's refund already made, even more than 24 hours ago
 * when Stripe's idempotency key is forgotten, is found in the payment's own refund list and never made twice. With no
 * such mark the day is never guessed as today (that would give members back less): the renewals are stopped, the
 * buyers not told yet are told, and a notice's length later the earliest day its closing could have had is taken.
 * Synthetic store; Stripe and email through the journey's stand-ins plus a member's payment; in-memory Redis.
 */
import { createHash } from "node:crypto";
import { FINAL_INDEX, paidKey, workKey } from "@/lib/closing-holds";
import { creditKey } from "@/lib/closing-credit";
import { markShut, shutOf } from "@/lib/closing-plan-guard";
import { closeOne, type Hands } from "@/lib/plan-closing";
import { claimHandle, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { type Sent, type StripeWorld, standIns } from "./closing-journey";

const sent: Sent[] = [];
const stripe: StripeWorld = { sessions: [], memberships: [], posted: [] };
/** A member's payment on a store's own account: its charge, the refunds on it, and every refund asked for. */
type Payment = { intent: string; amount: number; refunded: number; list: Record<string, unknown>[] };
const payments = new Map<string, Payment>();
const refundPosts: { intent: string; amount: number; key: string }[] = [];
const listReads: string[] = [];
const journey = standIns(stripe, sent, null);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 1_000_000, currency: "usd" }] });
    const paying = [...payments.values()].find((p) => path === `/payment_intents/${p.intent}`);
    if (paying) return Response.json({ id: paying.intent, object: "payment_intent", latest_charge: { id: `ch_${paying.intent.slice(3)}`, object: "charge", payment_intent: paying.intent, amount: paying.amount, currency: "usd", amount_refunded: paying.refunded, disputed: false, balance_transaction: null } });
    if (path === "/refunds" && method === "POST") {
      const body = new URLSearchParams(String(init?.body));
      const intent = body.get("payment_intent") ?? "";
      const amount = Number(body.get("amount"));
      refundPosts.push({ intent, amount, key: new Headers(init?.headers).get("idempotency-key") ?? "" });
      const id = `re_${intent.slice(3)}${refundPosts.length}`;
      const row = { id, object: "refund", amount, currency: "usd", payment_intent: intent, status: "succeeded", metadata: { closing_refund: body.get("metadata[closing_refund]") } };
      const paid = payments.get(intent);
      if (paid) {
        paid.refunded += amount;
        paid.list.push(row);
      }
      return Response.json(row);
    }
    if (path === "/refunds") listReads.push(url.searchParams.get("payment_intent") ?? "");
    if (path === "/refunds") return Response.json({ object: "list", data: payments.get(url.searchParams.get("payment_intent") ?? "")?.list ?? [], has_more: false });
  }
  return journey(input, init);
}) as typeof fetch;
const DAY = 86_400_000;
/** The closing state's key, as lib/plan-closing.ts names it (stateKey). */
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };

async function closingStore(owner: string, handle: string, account: string, member: string): Promise<{ key: string; ended: number }> {
  await claimHandle(owner, handle, "Lost State", "");
  await setStripeAccount(owner, account, true);
  const ended = Date.UTC(2026, 10, 2, 12, 0, 0);
  const realNow = Date.now;
  Date.now = () => ended;
  try {
    await setSubscription(owner, { active: false });
  } finally {
    Date.now = realNow;
  }
  const store = (await storeForEmail(owner))!;
  stripe.memberships.push({ id: member, account, status: "active", cancel_at_period_end: false, metadata: { store: store.handle } });
  const key = storeRef(store);
  // Its closing day has begun: it is in the final line.
  await redis.pipeline([["ZADD", FINAL_INDEX, ended, key]]);
  return { key, ended };
}

/** What its hold wrote down for a member: the last payment, half of its period past the store's real day. */
async function paidMember(owner: string, member: string, intent: string, invoice: string, day: number): Promise<string> {
  const folder = await storeFolder(storeRef((await storeForEmail(owner))!));
  const daySeconds = Math.floor(day / 1000);
  payments.set(intent, { intent, amount: 1_000, refunded: 0, list: [] });
  await redis.pipeline([
    ["HSET", paidKey(folder), member, JSON.stringify({ inv: invoice, pi: intent, amt: 1_000, tot: 1_000, cur: "usd", ps: daySeconds - 15 * 86_400, pe: daySeconds + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10, `m:${member}`, "member@example.com"],
    // Its buyers' emails, set when its members were held (startClosingCredit): its own key, kept with the state lost.
    ["SET", creditKey(folder), 10],
  ]);
  return folder;
}
const paidRow = async (folder: string, member: string) => JSON.parse(String((await redis.pipeline([["HGET", paidKey(folder), member]]))[0] ?? "{}")) as { r?: string; back?: number };
const stateOf = async (key: string) => {
  const [raw] = await redis.pipeline([["GET", stateKey(key)]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

const deleted = (account: string, member: string) => stripe.posted.some((p) => p.body === "DELETE" && p.account === account && p.path === `/subscriptions/${member}`);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_final_state_lost_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";

  part("Its state lost (the overlap of two runs), its day read back from its address mark");
  const lost = await closingStore("lost-state@example.com", "loststate", "acct_1LostStateShop", "sub_1LostStateMember");
  // The mark its closing day wrote when it began (closingDay), for this same ending.
  const realDay = lost.ended + 30 * DAY;
  await markShut((await storeForEmail("lost-state@example.com"))!, realDay, lost.ended);
  const lostFolder = await paidMember("lost-state@example.com", "sub_1LostStateMember", "pi_1LostStatePay", "in_1LostStateInv", realDay);
  const result = await closeOne(lost.key, realDay + 3 * DAY, hands, Number.POSITIVE_INFINITY);
  is("its member's renewal is stopped on its own account, never taken as stopped", deleted("acct_1LostStateShop", "sub_1LostStateMember"), true);
  is("its day is its real one, never today", (await stateOf(lost.key)).day, realDay);
  is("its member gets back the unused half of the period from its real day, once", refundPosts.filter((p) => p.intent === "pi_1LostStatePay").map((p) => p.amount), [500]);
  is("its members' payments, kept only for the closing, are gone with it", (await paidRow(lostFolder, "sub_1LostStateMember")).r, undefined);
  is("and its closing day finishes", result.state, "removed");
  is("the mark of when its closing day began is kept, never moved to today (a plan paid since would not be returned)", (await shutOf("loststate"))?.since, realDay);

  part("Its state lost after its member's refund was made, more than 24 hours before");
  const again = await closingStore("lost-again@example.com", "lostagain", "acct_1LostAgainShop", "sub_1LostAgainMember");
  const againDay = again.ended + 30 * DAY;
  await markShut((await storeForEmail("lost-again@example.com"))!, againDay, again.ended);
  const againFolder = await paidMember("lost-again@example.com", "sub_1LostAgainMember", "pi_1LostAgainPay", "in_1LostAgainInv", againDay);
  // Made on its closing day; the row was not written down before the state went. Two days on, Stripe has forgotten
  // the idempotency key `closing-refund:in_1LostAgainInv`, so a second POST would make a second refund.
  const made = payments.get("pi_1LostAgainPay")!;
  made.refunded = 500;
  made.list.push({ id: "re_1LostAgainMade", object: "refund", amount: 500, currency: "usd", payment_intent: "pi_1LostAgainPay", status: "succeeded", metadata: { closing_refund: "in_1LostAgainInv" } });
  const posts = refundPosts.length;
  const againResult = await closeOne(again.key, againDay + 2 * DAY, hands, Number.POSITIVE_INFINITY);
  is("its payment's own refunds are listed before anything is given back", listReads.includes("pi_1LostAgainPay"), true);
  is("no second refund is asked for", refundPosts.length - posts, 0);
  is("the payment gave back only what the first refund did", [made.refunded, made.list.length], [500, 1]);
  is("its members' payments, kept only for the closing, are gone with it", (await paidRow(againFolder, "sub_1LostAgainMember")).r, undefined);
  is("and its closing day finishes", againResult.state, "removed");

  for (const [label, handle, mark] of [["no address mark", "lostnomark", null], ["a mark for another ending", "lostother", "other"]] as const) {
    part(`Its state lost, with ${label}: the earliest day, after its buyers are told`);
    const owner = `${handle}@example.com`;
    const account = `acct_1${handle}Shop`;
    const member = `sub_1${handle}Member`;
    const intent = `pi_1${handle}Pay`;
    const gone = await closingStore(owner, handle, account, member);
    if (mark) await markShut((await storeForEmail(owner))!, gone.ended + 10 * DAY, gone.ended - 40 * DAY);
    // Its real day was later than the earliest one (a late notice moved it): members paid past the earliest.
    const earliest = gone.ended + 30 * DAY;
    await paidMember(owner, member, intent, `in_1${handle}Inv`, earliest);
    const lostAt = gone.ended + 41 * DAY;
    const lettersBefore = sent.filter((m) => m.to === "member@example.com").length;
    const first = await closeOne(gone.key, lostAt, hands, Number.POSITIVE_INFINITY);
    is("its member's renewal is stopped at once", deleted(account, member), true);
    is("its buyers not told yet are told first", sent.filter((m) => m.to === "member@example.com").length - lettersBefore, 1);
    is("nothing is given back, removed or written down as done before a notice's length", [first.state, refundPosts.filter((p) => p.intent === intent).length, (await stateOf(gone.key)).refunds, (await stateOf(gone.key)).day], ["waiting", 0, undefined, undefined]);
    const waiting = await closeOne(gone.key, lostAt + 3 * DAY, hands, Number.POSITIVE_INFINITY);
    is("still waiting three days on, and nobody is written to twice", [waiting.state, sent.filter((m) => m.to === "member@example.com").length - lettersBefore], ["waiting", 1]);
    const closed = await closeOne(gone.key, lostAt + 8 * DAY, hands, Number.POSITIVE_INFINITY);
    is("its day is the earliest it could have had, never today", (await stateOf(gone.key)).day, earliest);
    is("its member gets back the unused time from that day (more, never less), once", refundPosts.filter((p) => p.intent === intent).map((p) => p.amount), [500]);
    is("and its closing day finishes", closed.state, "removed");
    is("its address is marked from that day", (await shutOf(handle))?.since, earliest);
  }

  part("Control: a store whose state is there and whose renewals were stopped is not asked again");
  const kept = await closingStore("kept-state@example.com", "keptstate", "acct_1KeptStateShop", "sub_1KeptStateMember");
  await redis.pipeline([["SET", stateKey(kept.key), JSON.stringify({ of: kept.ended, day: kept.ended + 30 * DAY, renewals: kept.ended + 30 * DAY })]]);
  const normal = await closeOne(kept.key, kept.ended + 31 * DAY, hands, Number.POSITIVE_INFINITY);
  is("its renewals are not stopped again (the state says they were)", deleted("acct_1KeptStateShop", "sub_1KeptStateMember"), false);
  is("and it is not held for a lost state", normal.note === undefined || !/state/.test(normal.note), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
