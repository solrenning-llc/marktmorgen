/**
 * Issue #4422 (Codex X8): an invite credit whose balance transaction POST answers without a transaction id must not be
 * marked done or taken off the owed list. Nothing confirms the credit reached Stripe, so it stays owed; the next run
 * reads the balance history and, finding nothing, sends again with the same idempotency key. Stripe is a stand-in.
 * Receipt: https://docs.stripe.com/api/customer_balance_transactions/create
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { inviteCode, recordInvite, creditKey, OWED_KEY } from "@/lib/creator-invites";
import { settleInvites } from "@/lib/creator-invite-credit";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);
const PAST = INVITE_HOLD_DAYS + 4;
const INVITED = PAST + 20;
const invoices = new Map<string, Record<string, unknown>[]>();
// What the POST answers next: a reply with no receipt, one with an odd id, then a real one.
let reply: (amount: number) => unknown = () => ({});
const posts: { credit: string; key: string | null }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: invoices.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  // The history never shows the credit: only the POST's own answer could confirm it.
  if (txns && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (txns && method === "POST") {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const headers = new Headers(init?.headers);
    posts.push({ credit: form.get("metadata[nimbus_invite_credit]") ?? "", key: headers.get("idempotency-key") });
    return answer(reply(Number(form.get("amount"))));
  }
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") return answer({ id: customer[1], object: "customer", balance: 0, currency: "usd" });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const record = (id: string) => JSON.parse(String(redis.run(["GET", creditKey(id)]))) as { state: string; txn?: string };

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_issue4422_receipt_only";
  redis.clear();
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana@example.com", "ana");
  const bea = await made("bea@example.com", "bea");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, period: paidPeriod() });
  await setSubscription("bea@example.com", { customerId: "cus_Bea0001", subscriptionId: "sub_Bea0001", active: true, period: paidPeriod() });
  invoices.set("cus_Bea0001", [{
    id: "in_BeaFirst01", object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
    created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: "pi_bea_first" } }], has_more: false },
  }]);

  const errors = console.error;
  console.error = () => {};
  try {
    part("The POST answers 200 with no receipt");
    reply = () => ({});
    const first = await settleInvites(Date.now() + 60_000, NOW);
    is("nothing is counted as added", first.added, 0);
    is("the run is not complete and counts the failures", [first.complete, first.failed >= 1], [false, true]);
    is("the credit stays owed", record("in_BeaFirst01").state, "owed");
    is("the credit stays on the owed list", redis.run(["SISMEMBER", OWED_KEY, "in_BeaFirst01"]), 1);

    part("The POST answers with an id that is not a balance transaction's");
    reply = () => ({ id: "", object: "customer_balance_transaction" });
    const second = await settleInvites(Date.now() + 60_000, NOW);
    is("still nothing added, still owed and listed", [second.added, record("in_BeaFirst01").state, redis.run(["SISMEMBER", OWED_KEY, "in_BeaFirst01"])], [0, "owed", 1]);

    part("The next run gets a real receipt");
    reply = (amount) => ({ id: "cbtxn_Bea000000001", object: "customer_balance_transaction", amount });
    const third = await settleInvites(Date.now() + 60_000, NOW);
    is("the credit is now done with its receipt", [record("in_BeaFirst01").state, record("in_BeaFirst01").txn], ["done", "cbtxn_Bea000000001"]);
    is("and leaves the owed list", redis.run(["SISMEMBER", OWED_KEY, "in_BeaFirst01"]), 0);
    is("the run counts it", third.added >= 1, true);
    const keys = posts.filter((p) => p.credit === "in_BeaFirst01").map((p) => p.key);
    is("every send carried the same idempotency key", [keys.length, new Set(keys).size, keys[0]], [3, 1, "nimbus-invite-in_BeaFirst01"]);
  } finally {
    console.error = errors;
  }
  done();
}

void main();
