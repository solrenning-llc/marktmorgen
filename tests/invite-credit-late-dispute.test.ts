/**
 * An invite credit still owed is put on a plan only on money the platform still has: before a credit goes to Stripe,
 * the payment it was earned on is read again (lib/creator-invite-credit.ts putOnPlan; Codex X5's review of #4514,
 * ALTO, part (a)).
 *
 * The defect this file was written around: once a share was written down, every later run skipped its invoice
 * (EXISTS) before reading refunds and disputes, and putOnPlan sent a credit still owed to Stripe as it was written.
 * So when the inviter was not paying yet (or the first try to send it failed), and the bank then took the payment back
 * by a dispute, the next run still put the share, and the invited creator's bonus, on their balances.
 *
 * Checked, with Stripe as a stand-in (nothing real is charged):
 *   - a share owed, then a lost dispute: nothing is sent, and the share is written down as earning nothing;
 *   - the invited creator's bonus owed (its first send failed), then a lost dispute on the payment that earned it: the
 *     bonus is not sent either;
 *   - a dispute still open: nothing is sent, the credit stays owed for a later run;
 *   - the invoice read again does not read, or is another invoice: nothing is sent, the run is not clean;
 *   - control: no dispute, the share is sent once.
 * What a credit already sent becomes after a late dispute (part (b)) is the owner's decision, not built here.
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
const PI = "pi_bea_late";
const INVOICE = "in_BeaLate0001";
const posts = new Map<string, number[]>();
let disputes: unknown = { object: "list", data: [], has_more: false };
/** What GET /invoices/<id> answers; null answers 500. */
let invoiceById: ((id: string) => unknown) | null = null;
/** Customers whose balance POST answers 500. */
const failing = new Set<string>();

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
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: url.searchParams.get("customer") === "cus_BeaLate01" ? [invoice()] : [], has_more: false });
  const one = path.match(/^\/invoices\/(in_[A-Za-z0-9]+)$/);
  if (method === "GET" && one) return invoiceById ? answer(invoiceById(one[1])) : answer({ error: { type: "api_error", message: "TEST ONLY down" } }, 500);
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  if (method === "GET" && path === "/disputes") return answer(disputes);
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (txns && method === "POST") {
    if (failing.has(txns[1])) return answer({ error: { type: "api_error", message: "TEST ONLY down" } }, 500);
    const form = new URLSearchParams(String(init?.body ?? ""));
    posts.set(txns[1], [...(posts.get(txns[1]) ?? []), Number(form.get("amount"))]);
    return answer({ id: `cbtxn_${Math.random().toString(36).slice(2, 10)}`, amount: Number(form.get("amount")) });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const list = (data: unknown[]) => ({ object: "list", data, has_more: false });
const lost = { id: "du_bea_late", object: "dispute", status: "lost", amount: 2900, currency: "usd", payment_intent: PI, balance_transactions: [{ id: "txn_out", object: "balance_transaction", amount: -2900, currency: "usd" }] };
const open = { ...lost, status: "needs_response" };

/**
 * Ana invited Bea, who paid her first $29 plan invoice INVITE_HOLD_DAYS + 4 days ago, with no dispute then. The first
 * run writes the share down; it stays owed when Ana pays nothing yet (`anaPays` false), and the bonus stays owed when
 * its first send fails (`bonusFails`).
 */
async function firstRun(anaPays: boolean, bonusFails: boolean): Promise<string> {
  redis.clear();
  posts.clear();
  failing.clear();
  disputes = list([]);
  invoiceById = (id) => (id === INVOICE ? invoice() : { error: "no such invoice" });
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana-late@example.com", "analate");
  const bea = await made("bea-late@example.com", "bealate");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("ana-late@example.com", { customerId: anaPays ? "cus_AnaLate01" : null, subscriptionId: anaPays ? "sub_AnaLate01" : null, active: anaPays, period: paidPeriod() });
  await setSubscription("bea-late@example.com", { customerId: "cus_BeaLate01", subscriptionId: "sub_BeaLate01", active: true, period: paidPeriod() });
  if (bonusFails) failing.add("cus_BeaLate01");
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  failing.clear();
  if (!anaPays) await setSubscription("ana-late@example.com", { customerId: "cus_AnaLate01", subscriptionId: "sub_AnaLate01", active: true, period: paidPeriod() });
  return bea.sid;
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const errors = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = errors;
  }
}

const stateOf = (id: string): [string, number] | null => {
  const raw = redis.run(["GET", creditKey(id)]);
  const credit = typeof raw === "string" ? (JSON.parse(raw) as { state: string; cents: number }) : null;
  return credit ? [credit.state, credit.cents] : null;
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_late_dispute_only_a_stand_in";

  part("Control: the share owed, no dispute: sent once on the next run");
  await firstRun(false, false);
  is("after the first run the share is owed, nothing sent to Ana", [stateOf(INVOICE)?.[0], posts.get("cus_AnaLate01") ?? []], ["owed", []]);
  const control = await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("no dispute: Ana's half sent once, the run clean", [control.failed, posts.get("cus_AnaLate01"), stateOf(INVOICE)?.[0]], [0, [-1450], "done"]);

  part("The share owed, then a lost dispute: nothing sent, the share earns nothing");
  await firstRun(false, false);
  disputes = list([lost]);
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("no credit sent to Ana", posts.get("cus_AnaLate01") ?? [], []);
  is("the share written down as earning nothing", stateOf(INVOICE), ["none", 0]);

  part("The bonus owed (its first send failed), then a lost dispute: not sent");
  const beaSid = await firstRun(true, true);
  is("after the first run the bonus is owed, nothing sent to Bea", [stateOf(`bonus_${beaSid}`)?.[0], posts.get("cus_BeaLate01") ?? []], ["owed", []]);
  disputes = list([lost]);
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("no bonus sent to Bea, and it earns nothing", [posts.get("cus_BeaLate01") ?? [], stateOf(`bonus_${beaSid}`)], [[], ["none", 0]]);

  part("A dispute still open: nothing sent, the share stays owed");
  await firstRun(false, false);
  disputes = list([open]);
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("nothing sent, still owed", [posts.get("cus_AnaLate01") ?? [], stateOf(INVOICE)?.[0]], [[], "owed"]);

  part("The invoice read again does not read, or is another one: nothing sent");
  await firstRun(false, false);
  invoiceById = null;
  const down = await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("Stripe down: nothing sent, still owed, the run not clean", [posts.get("cus_AnaLate01") ?? [], stateOf(INVOICE)?.[0], down.failed > 0], [[], "owed", true]);
  await firstRun(false, false);
  invoiceById = () => ({ ...invoice(), id: "in_SomeoneElse1" });
  const other = await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("another invoice's answer: nothing sent, still owed, the run not clean", [posts.get("cus_AnaLate01") ?? [], stateOf(INVOICE)?.[0], other.failed > 0], [[], "owed", true]);
  done();
}

void main();
