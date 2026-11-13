/**
 * An invited creator's plan payment earns its inviter a credit only on money the platform kept: a payment taken back
 * by a dispute earns nothing, and one whose dispute is still open earns nothing yet (lib/creator-invite-credit.ts;
 * rule 24, money).
 *
 * The defect this file was written around: the earning read only /refunds. A plan invoice stays `paid` after its
 * charge is disputed, so once INVITE_HOLD_DAYS had passed, a payment the bank took back (lost, or prevented with its
 * money gone) still earned the inviter their share and the invited creator their bonus, written down for good and then
 * put on their Stripe balances: platform money given out on money the platform no longer had.
 *
 * Checked, with Stripe as a stand-in (nothing real is charged):
 *   - a lost dispute: no share, no bonus, nothing on any balance;
 *   - a prevented dispute whose money left: the same; a prevented one blocked with no money moved: the full share;
 *   - a dispute still open (needs_response, under_review, or an inquiry still open): nothing written this run, and the
 *     run is not a failure; once it is won, the full share is earned;
 *   - an inquiry closed with no chargeback (warning_closed): the full share;
 *   - a dispute list or row that does not read: the store fails this run and nothing is written;
 *   - control: no dispute, the full share.
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
const PI = "pi_bea_first";
const balance = new Map<string, { amount: number }[]>();
const invoices = new Map<string, Record<string, unknown>[]>();
let disputes: unknown = { object: "list", data: [], has_more: false };
let disputeQueries: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: invoices.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  if (method === "GET" && path === "/disputes") {
    disputeQueries.push(url.searchParams.toString());
    return answer(disputes);
  }
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (txns && method === "POST") {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const row = { id: `cbtxn_${Math.random().toString(36).slice(2, 10)}`, amount: Number(form.get("amount")) };
    balance.set(txns[1], [...(balance.get(txns[1]) ?? []), row]);
    return answer(row);
  }
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") return answer({ id: customer[1], object: "customer", balance: 0, currency: "usd" });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const list = (data: unknown[]) => ({ object: "list", data, has_more: false });
const move = (amount: number) => ({ id: `txn_${amount < 0 ? "out" : "in"}`, object: "balance_transaction", amount, currency: "usd" });
const dispute = (status: string, over: Record<string, unknown> = {}) =>
  ({ id: "du_bea_first", object: "dispute", status, amount: 2900, currency: "usd", payment_intent: PI, balance_transactions: [move(-2900)], ...over });

/** A fresh world: Ana invited Bea, and Bea paid her first $29 plan invoice INVITE_HOLD_DAYS + 4 days ago. */
async function fresh(): Promise<{ beaSid: string }> {
  redis.clear();
  balance.clear();
  disputeQueries = [];
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
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: PI } }], has_more: false },
  }]);
  return { beaSid: bea.sid };
}

/** Two runs (earn, then put on the plan): what the run said, the share written down and both balances. */
async function settle(): Promise<{ failed: number; share: [string, number] | null; ana: number[]; bea: number[] }> {
  const errors = console.error;
  console.error = () => {};
  let first;
  try {
    first = await settleInvites(Date.now() + 60_000, NOW);
    await settleInvites(Date.now() + 60_000, NOW);
  } finally {
    console.error = errors;
  }
  const raw = redis.run(["GET", creditKey("in_BeaFirst01")]);
  const share = typeof raw === "string" ? (JSON.parse(raw) as { state: string; cents: number }) : null;
  return {
    failed: first.failed,
    share: share ? [share.state, share.cents] : null,
    ana: (balance.get("cus_Ana0001") ?? []).map((t) => t.amount),
    bea: (balance.get("cus_Bea0001") ?? []).map((t) => t.amount),
  };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_disputes_only_a_stand_in";

  part("Control: no dispute earns the full share and the bonus");
  await fresh();
  disputes = list([]);
  const control = await settle();
  is("no dispute: Ana's half on her plan, the run clean", [control.failed, control.share, control.ana], [0, ["done", 1450], [-1450]]);
  is("the disputes of the invoice's own payment were asked", disputeQueries.some((q) => new URLSearchParams(q).get("payment_intent") === PI), true);

  part("A payment the bank took back earns nothing");
  await fresh();
  disputes = list([dispute("lost")]);
  is("a lost dispute: no share and no bonus on any balance", await settle(), { failed: 0, share: ["none", 0], ana: [], bea: [] });
  await fresh();
  disputes = list([dispute("prevented")]);
  is("a prevented dispute whose money left: no share and no bonus", await settle(), { failed: 0, share: ["none", 0], ana: [], bea: [] });

  part("A dispute that took nothing earns the full share");
  await fresh();
  disputes = list([dispute("prevented", { balance_transactions: [] })]);
  const blocked = await settle();
  is("a prevented dispute blocked with no money moved: the full share", [blocked.share, blocked.ana], [["done", 1450], [-1450]]);
  await fresh();
  disputes = list([dispute("warning_closed", { balance_transactions: [] })]);
  const inquiry = await settle();
  is("an inquiry closed with no chargeback: the full share", [inquiry.share, inquiry.ana], [["done", 1450], [-1450]]);

  part("A dispute still open earns nothing yet, then the full share once it is won");
  for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review"]) {
    await fresh();
    disputes = list([dispute(status)]);
    is(`a dispute in ${status}: nothing written, not a failure`, await settle(), { failed: 0, share: null, ana: [], bea: [] });
  }
  disputes = list([dispute("won", { balance_transactions: [move(-2900), move(2900)] })]);
  const won = await settle();
  is("the same dispute won: the full share then", [won.share, won.ana], [["done", 1450], [-1450]]);

  part("A dispute answer that does not read: the store fails this run, nothing written");
  for (const [what, page] of [
    ["no data", { object: "list", has_more: false }],
    ["has_more true", { object: "list", data: [], has_more: true }],
    ["not a list", { object: "dispute", data: [], has_more: false }],
    ["a status Stripe does not give", list([dispute("g_future")])],
    ["an amount in text", list([dispute("lost", { amount: "2900" })])],
    ["a prevented dispute whose money does not read", list([dispute("prevented", { balance_transactions: undefined })])],
    ["a row that is not a dispute", list([{ ...dispute("lost"), object: "refund" }])],
  ] as [string, unknown][]) {
    await fresh();
    disputes = page;
    is(`disputes with ${what}: the run fails, nothing written or paid`, await settle(), { failed: 1, share: null, ana: [], bea: [] });
  }
  done();
}

void main();
