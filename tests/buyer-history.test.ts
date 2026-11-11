/**
 * 567 [GD1] (f), unit 3: the studio's inbox tells the creator whether the
 * person of a conversation asked this store for a refund, or opened a dispute
 * here, before (lib/buyer-history.ts). Read at the creator's request from the
 * creator's own Stripe account, on the address of that conversation only;
 * nothing new is kept. A reply that cannot be read, a list read in part, or a
 * payment whose charge is not given is "could not check", never "none": no
 * zero stands for a reading that did not happen. Subscriptions are said as not
 * checked, never as clean. Synthetic stores and Stripe replies, in-memory Redis.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setInboxSetting, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { REFUND_HISTORY_LIST, REFUND_HISTORY_PER_DAY, historyFrom, refundHistory } from "@/lib/buyer-history";
import { readInbox, startChat } from "@/lib/inbox";
import { POST as inboxRoute } from "@/app/api/store/inbox/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_buyer_history_only";

const OWNER = "mara@example.com";
const OTHER = "lee@example.com";
const BUYER = "Buyer@Example.com";
const ACCOUNT = "acct_1TestHistory0001";

type Row = Record<string, unknown>;
const charge = (refunded: boolean, amountRefunded: number, disputed: boolean, extra: Row = {}): Row => ({ id: "ch_1", object: "charge", refunded, amount_refunded: amountRefunded, disputed, ...extra });
const paid = (id: string, latest: unknown, extra: Row = {}): Row => ({
  id, object: "checkout.session", status: "complete", mode: "payment", payment_status: "paid",
  customer_details: { email: "buyer@example.com" },
  payment_intent: { id: `pi_${id}`, object: "payment_intent", latest_charge: latest },
  ...extra,
});
const list = (data: unknown[], hasMore = false): Row => ({ object: "list", data, has_more: hasMore });

/** What the synthetic Stripe answers, by the address asked for; and every call made. */
let replies: Record<string, { status: number; body: unknown }> = {};
let calls: { url: string; account: string | null; method: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.stripe.com/")) {
    const headers = new Headers(init?.headers);
    calls.push({ url, account: headers.get("Stripe-Account"), method: init?.method ?? "GET" });
    const email = new URL(url).searchParams.get("customer_details[email]") ?? "";
    const reply = replies[email] ?? { status: 200, body: list([]) };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }
  return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 });
}) as typeof fetch;

async function shop(owner: string, handle: string, account: string | null): Promise<Store> {
  await claimHandle(owner, handle, `${handle} shop`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(owner, { chat: true, saved: [] });
  if (account) await setStripeAccount(owner, account, true);
  return (await storeForEmail(owner))!;
}

const route = async (owner: string, body: Record<string, unknown>) => {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const response = await inboxRoute(new NextRequest("https://marktmorgen.com/api/store/inbox", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

async function main(): Promise<void> {
  part("The limits");
  is("a few checks a store a day, more than one", REFUND_HISTORY_PER_DAY >= 5 && REFUND_HISTORY_PER_DAY <= 50, true);
  is("the newest 100 checkouts a spelling, Stripe's largest page", REFUND_HISTORY_LIST, 100);

  part("Counted from what Stripe answered");
  const mixed = list([
    paid("cs_full", charge(true, 4900, false)),
    paid("cs_part", charge(false, 1000, false)),
    paid("cs_disp", charge(false, 0, true)),
    paid("cs_both", charge(true, 4900, true)),
    paid("cs_clean", charge(false, 0, false)),
  ]);
  is("each kind counted once", historyFrom([mixed], BUYER), { state: "known", checked: 5, refunded: 2, partly: 1, disputed: 2, more: false, unchecked: 0 });
  is("nothing bought here", historyFrom([list([])], BUYER), { state: "known", checked: 0, refunded: 0, partly: 0, disputed: 0, more: false, unchecked: 0 });
  is("the same checkout under both spellings counted once", historyFrom([list([paid("cs_full", charge(true, 4900, false))]), list([paid("cs_full", charge(true, 4900, false))])], BUYER),
    { state: "known", checked: 1, refunded: 1, partly: 0, disputed: 0, more: false, unchecked: 0 });
  is("more than one page: said as the newest only", historyFrom([list([paid("cs_clean", charge(false, 0, false))], true)], BUYER),
    { state: "known", checked: 1, refunded: 0, partly: 0, disputed: 0, more: true, unchecked: 0 });
  is("a subscription is not checked, and said so", historyFrom([list([{ ...paid("cs_sub", null), mode: "subscription", payment_intent: null }])], BUYER),
    { state: "known", checked: 0, refunded: 0, partly: 0, disputed: 0, more: false, unchecked: 1 });
  is("a payment not made yet is not checked, and said so", historyFrom([list([paid("cs_wait", null, { payment_status: "unpaid" })])], BUYER),
    { state: "known", checked: 0, refunded: 0, partly: 0, disputed: 0, more: false, unchecked: 1 });
  is("a free checkout is no purchase to count", historyFrom([list([{ ...paid("cs_free", null), payment_status: "no_payment_required", payment_intent: null }])], BUYER),
    { state: "known", checked: 0, refunded: 0, partly: 0, disputed: 0, more: false, unchecked: 0 });

  part("What cannot be read is not counted as clean");
  const unknown = { state: "unknown" };
  is("no listing", historyFrom([], BUYER), unknown);
  is("a listing that is not a list", historyFrom([{ object: "list", data: {}, has_more: false }], BUYER), unknown);
  is("a listing that does not say whether more follow", historyFrom([{ object: "list", data: [] }], BUYER), unknown);
  is("a reply that is not an object", historyFrom(["nope"], BUYER), unknown);
  is("a row that is not an object", historyFrom([list([null])], BUYER), unknown);
  is("a checkout not complete", historyFrom([list([paid("cs_open", charge(false, 0, false), { status: "open" })])], BUYER), unknown);
  is("another address's checkout", historyFrom([list([paid("cs_x", charge(true, 4900, false), { customer_details: { email: "someone@example.com" } })])], BUYER), unknown);
  is("a payment not expanded", historyFrom([list([paid("cs_x", null, { payment_intent: "pi_x" })])], BUYER), unknown);
  is("a paid payment without its charge", historyFrom([list([paid("cs_x", null)])], BUYER), unknown);
  is("a charge given only by its id", historyFrom([list([paid("cs_x", "ch_1")])], BUYER), unknown);
  is("refunded not a yes or no", historyFrom([list([paid("cs_x", charge("yes" as unknown as boolean, 0, false))])], BUYER), unknown);
  is("disputed not a yes or no", historyFrom([list([paid("cs_x", { ...charge(false, 0, false), disputed: null })])], BUYER), unknown);
  is("an amount refunded that is not a whole number", historyFrom([list([paid("cs_x", charge(false, 10.5, false))])], BUYER), unknown);
  is("a negative amount refunded", historyFrom([list([paid("cs_x", charge(false, -1, false))])], BUYER), unknown);
  is("a mode not known", historyFrom([list([paid("cs_x", charge(false, 0, false), { mode: "other" })])], BUYER), unknown);
  is("one bad row spoils the whole check", historyFrom([list([paid("cs_full", charge(true, 4900, false)), paid("cs_x", null)])], BUYER), unknown);

  part("Read from the creator's own account");
  redis.clear();
  const store = await shop(OWNER, "mara", ACCOUNT);
  const bare = await shop(OTHER, "lee", null);
  replies = { "Buyer@Example.com": { status: 200, body: mixed }, "buyer@example.com": { status: 200, body: list([paid("cs_full", charge(true, 4900, false))]) } };
  calls = [];
  is("both spellings read, counted once", await refundHistory(store, BUYER), { state: "known", checked: 5, refunded: 2, partly: 1, disputed: 2, more: false, unchecked: 0 });
  is("two reads, both GETs on the creator's account", calls.map((c) => [c.method, c.account]), [["GET", ACCOUNT], ["GET", ACCOUNT]]);
  const asked = new URL(calls[0]?.url ?? "https://api.stripe.com/").searchParams;
  is("complete checkouts of the address, the newest page, with each payment's charge",
    [asked.get("status"), asked.get("limit"), asked.getAll("expand[]")], ["complete", "100", ["data.payment_intent.latest_charge"]]);
  calls = [];
  is("one spelling: one read", (await refundHistory(store, "buyer@example.com")).state, "known");
  is("one read", calls.length, 1);
  is("a store with no Stripe account has nothing to read", await refundHistory(bare, BUYER), { state: "none" });
  replies = { "buyer@example.com": { status: 500, body: { error: { type: "api_error" } } } };
  is("Stripe refused: could not check", await refundHistory(store, "buyer@example.com"), unknown);
  replies = { "buyer@example.com": { status: 200, body: { object: "list", data: [paid("cs_x", null)], has_more: false } } };
  is("a charge not given: could not check", await refundHistory(store, "buyer@example.com"), unknown);

  part("The studio's inbox asks for it");
  redis.clear();
  const mara = await shop(OWNER, "mara", ACCOUNT);
  await shop(OTHER, "lee", ACCOUNT);
  replies = { "buyer@example.com": { status: 200, body: mixed } };
  is("a chat starts", (await startChat({ store: mara, email: "buyer@example.com", name: "", text: "Hello there", ip: "10.0.0.1" })).ok, true);
  const [conversation] = await readInbox(mara.statsId!);
  const before = new Set(redis.keys());
  const told = await route(OWNER, { action: "history", id: conversation.id });
  is("told, for this conversation's address", told, { status: 200, body: { ok: true, history: { state: "known", checked: 5, refunded: 2, partly: 1, disputed: 2, more: false, unchecked: 0 } } });
  const keysAfter = redis.keys().filter((key) => !before.has(key));
  is("nothing kept but the day's count of checks", keysAfter.every((key) => key.startsWith("nl:rl:")), true);
  is("the address is not in any key's name", keysAfter.some((key) => key.toLowerCase().includes("buyer")), false);
  is("another store cannot ask about this conversation", (await route(OTHER, { action: "history", id: conversation.id })).status, 404);
  is("an unknown conversation", (await route(OWNER, { action: "history", id: "zzzzzzzzzzzz" })).status, 404);
  replies = { "buyer@example.com": { status: 500, body: { error: { type: "api_error" } } } };
  is("could not check: said, not shown as none", await route(OWNER, { action: "history", id: conversation.id }), { status: 503, body: { ok: false, error: "unknown" } });

  part("A day's checks are bounded before Stripe is asked");
  replies = { "buyer@example.com": { status: 200, body: mixed } };
  for (let n = 2; n < REFUND_HISTORY_PER_DAY; n += 1) await route(OWNER, { action: "history", id: conversation.id });
  calls = [];
  is("past the day's checks: refused", await route(OWNER, { action: "history", id: conversation.id }), { status: 429, body: { ok: false, error: "limited" } });
  is("and Stripe is not asked", calls.length, 0);

  done();
}

void main();
