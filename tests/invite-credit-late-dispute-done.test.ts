/**
 * PENDING THE OWNER'S DECISION (part (b) of Codex X5's review of #4514): what an invite credit already put on a plan
 * becomes when the payment it was earned on is taken back by a dispute later.
 *
 * Today a credit is "written once, for good": once it is on the customer's balance at Stripe it is never taken back
 * (lib/creator-invite-credit.ts). Codex X5 asks for an idempotent compensation (a debit on the same customer balance,
 * keyed by the credit's id) when a lost dispute arrives after the credit was sent. That changes what the credit
 * promises the creator, so it is a change of terms for the owner, not a code fix: this file only records the case,
 * and fails until the owner decides and it is built.
 *
 * Checked, with Stripe as a stand-in: a share sent, then a lost dispute on its payment; the next runs make exactly one
 * compensation of the same amount, under a key from the credit's id, and the credit is no longer "done".
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { inviteCode, recordInvite, creditKey } from "@/lib/creator-invites";
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
const PI = "pi_bea_done";
const INVOICE = "in_BeaDone0001";
const posts: { customer: string; amount: number; key: string }[] = [];
let disputes: unknown = { object: "list", data: [], has_more: false };

const invoice = () => ({
  id: INVOICE, object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
  created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
  payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: PI } }], has_more: false },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: url.searchParams.get("customer") === "cus_BeaDone01" ? [invoice()] : [], has_more: false });
  if (method === "GET" && path === `/invoices/${INVOICE}`) return answer(invoice());
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  if (method === "GET" && path === "/disputes") return answer(disputes);
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (txns && method === "POST") {
    const form = new URLSearchParams(String(init?.body ?? ""));
    posts.push({ customer: txns[1], amount: Number(form.get("amount")), key: new Headers(init?.headers).get("idempotency-key") ?? "" });
    return answer({ id: `cbtxn_${posts.length}abcdef`, amount: Number(form.get("amount")) });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const errors = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = errors;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_late_done_only_a_stand_in";
  redis.clear();
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana-done@example.com", "anadone");
  const bea = await made("bea-done@example.com", "beadone");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("ana-done@example.com", { customerId: "cus_AnaDone01", subscriptionId: "sub_AnaDone01", active: true, period: paidPeriod() });
  await setSubscription("bea-done@example.com", { customerId: "cus_BeaDone01", subscriptionId: "sub_BeaDone01", active: true, period: paidPeriod() });

  part("A share already on Ana's plan, then a lost dispute on its payment");
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  const raw = redis.run(["GET", creditKey(INVOICE)]);
  is("the share was sent and is done", [typeof raw === "string" ? (JSON.parse(raw) as { state: string }).state : null, posts.filter((p) => p.customer === "cus_AnaDone01").map((p) => p.amount)], ["done", [-1450]]);
  disputes = { object: "list", data: [{ id: "du_bea_done", object: "dispute", status: "lost", amount: 2900, currency: "usd", payment_intent: PI, balance_transactions: [{ id: "txn_out", object: "balance_transaction", amount: -2900, currency: "usd" }] }], has_more: false };
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  const back = posts.filter((p) => p.customer === "cus_AnaDone01" && p.amount > 0);
  is("exactly one compensation of the same amount, keyed by the credit's id", [back.map((p) => p.amount), back.every((p) => p.key.includes(INVOICE))], [[1450], true]);
  const after = redis.run(["GET", creditKey(INVOICE)]);
  is("the credit is no longer done", typeof after === "string" ? (JSON.parse(after) as { state: string }).state !== "done" : false, true);
  done();
}

void main();
