/**
 * #4717 (Codex X8): an invite credit was closed as done when the customer's balance history held a row with the
 * credit's mark that was a debit, in another currency or of another customer, so the creator never got the credit.
 * A row with the mark closes the credit only when it is that very credit; otherwise the credit stays owed and listed,
 * nothing is sent, and the next run reads again. Synthetic Stripe and Redis only.
 */
import { claimHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { inviteCode, recordInvite, creditKey, byKey, OWED_KEY } from "@/lib/creator-invites";
import { settleInvites, creditOnPlan } from "@/lib/creator-invite-credit";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);
const PAST = INVITE_HOLD_DAYS + 4;
const INVITED = PAST + 20;
const ID = "in_BeaFirst01";
let invoices: Record<string, unknown>[] = [];
let refundRows: Record<string, unknown>[] = [];
let historyRow: (cents: number) => Record<string, unknown>[] = () => [];
let customerReply: Record<string, unknown> = {};
let posts = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: invoices, has_more: false });
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: refundRows, has_more: false });
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") {
    const credit = JSON.parse(String(redis.run(["GET", creditKey(ID)]) ?? "null"));
    return answer({ object: "list", data: credit ? historyRow(credit.cents) : [], has_more: false });
  }
  if (txns && method === "POST") {
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (form.get("metadata[nimbus_invite_credit]") === ID) posts += 1;
    return answer({ id: "cbtxn_made0001", object: "customer_balance_transaction", amount: Number(form.get("amount")), currency: form.get("currency"), customer: txns[1] });
  }
  if (path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/) && method === "GET") return answer(customerReply);
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const invoice = (over: Record<string, unknown> = {}) => ({
  id: ID, object: "invoice", customer: "cus_Bea0001", status: "paid", amount_paid: 100000, post_payment_credit_notes_amount: 0, currency: "usd",
  created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
  payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: "pi_a" } }], has_more: false },
  ...over,
});
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_A1", object: "refund", amount: 10000, currency: "usd", status: "succeeded", payment_intent: "pi_a", charge: "ch_a", ...over });

async function scenario(): Promise<Store> {
  redis.clear(); posts = 0; invoices = [invoice()]; refundRows = []; historyRow = () => [];
  customerReply = { id: "cus_Bea0001", object: "customer", balance: 0, currency: "usd" };
  const made = async (email: string, handle: string) => { const r = await claimHandle(email, handle, handle, ""); if (!r.ok) throw new Error("no store"); return r.store; };
  const ana = await made("ana@example.com", "ana");
  const bea = await made("bea@example.com", "bea");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, period: paidPeriod() });
  await setSubscription("bea@example.com", { customerId: "cus_Bea0001", subscriptionId: "sub_Bea0001", active: true, period: paidPeriod() });
  return (await storeForEmail("bea@example.com"))!;
}
const quiet = async <T,>(f: () => Promise<T>) => { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } };
const credit = () => { const raw = redis.run(["GET", creditKey(ID)]); return raw ? JSON.parse(String(raw)) : null; };
const owed = () => redis.run(["SISMEMBER", OWED_KEY, ID]);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_history_exact";

  part("A balance history row that carries the credit's mark but is not the credit (#4717)");
  for (const [label, make] of [
    ["valid credit row (control)", (c: number) => [{ id: "cbtxn_h1", object: "customer_balance_transaction", amount: -c, currency: "usd", customer: "cus_Ana0001", metadata: { nimbus_invite_credit: ID } }]],
    ["a debit of the same size", (c: number) => [{ id: "cbtxn_h1", object: "customer_balance_transaction", amount: c, currency: "usd", customer: "cus_Ana0001", metadata: { nimbus_invite_credit: ID } }]],
    ["another currency", (c: number) => [{ id: "cbtxn_h1", object: "customer_balance_transaction", amount: -c, currency: "eur", customer: "cus_Ana0001", metadata: { nimbus_invite_credit: ID } }]],
    ["another customer", (c: number) => [{ id: "cbtxn_h1", object: "customer_balance_transaction", amount: -c, currency: "usd", customer: "cus_Other0001", metadata: { nimbus_invite_credit: ID } }]],
    ["an amount of another size", (c: number) => [{ id: "cbtxn_h1", object: "customer_balance_transaction", amount: -(c + 1), currency: "usd", customer: "cus_Ana0001", metadata: { nimbus_invite_credit: ID } }]],
    ["another kind of object", (c: number) => [{ id: "cbtxn_h1", object: "invoice", amount: -c, currency: "usd", customer: "cus_Ana0001", metadata: { nimbus_invite_credit: ID } }]],
  ] as const) {
    await scenario(); historyRow = make as never;
    await quiet(() => settleInvites(Date.now() + 60_000, NOW));
    const state = credit()?.state;
    is(`${label}: ` + (label.includes("control") ? "done, no POST" : "credit stays owed and listed, no POST"), [state, owed(), posts], label.includes("control") ? ["done", 0, 0] : ["owed", 1, 0]);
  }

  await scenario();
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("(control) an empty, complete history: the credit is sent once and done", [credit()?.state, owed(), posts], ["done", 0, 1]);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
