/**
 * What an invite credit already on a plan becomes when the payment it was earned on is taken back by a dispute decided
 * after it was sent (the owner's decision of 19 November 2026 on #4514, part (b); Codex T, X6, G and N1, HIGH):
 *
 *   - the credit, and the invited creator's bonus earned with the same payment, wait INVITE_HOLD_DAYS (the cards' usual
 *     120-day dispute window) before they are added;
 *   - a dispute lost later takes back only what is still unused on the creator's balance: the part already used is not
 *     charged to them, their balance never ends owing, and nothing is charged to a card; the used part is the company's
 *     funded exposure (scope legacy_credits), bounded by lateDisputeExposureCeilingCents;
 *   - it is found by the daily reading of plan disputes (lib/plan-disputes.ts), and done once, whatever is retried.
 *
 * Stripe is a stand-in: nothing real is charged.
 */
import { readFileSync } from "node:fs";
import { claimHandle, setSubscription } from "@/lib/store";
import { inviteCode, recordInvite, creditKey } from "@/lib/creator-invites";
import { settleInvites } from "@/lib/creator-invite-credit";
import { clawBackInviteCredits, lateDisputeExposureCeilingCents } from "@/lib/creator-invite-clawback";
import { INVITE_DISPUTE_WINDOW_DAYS, INVITE_HOLD_DAYS, INVITE_SHARE_PERCENT, currentInviteTerms, inviteShare } from "@/lib/creator-invite-rules";
import { REFUND_DAYS } from "@/lib/plan";
import { SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { CLAWBACKS_PER_RUN } from "@/lib/creator-invite-clawback";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);
const PAST = INVITE_HOLD_DAYS + 4;
const INVITED = PAST + 20;
const PI = "pi_bea_claw";
const INVOICE = "in_BeaClaw00001";
const BEA_SUB = "sub_BeaClaw01";

type Row = { id: string; amount: number; metadata: Record<string, string> };
/** Each customer's balance (negative is credit) and its history, newest first, as Stripe keeps them. */
const balances = new Map<string, number>();
const history = new Map<string, Row[]>();
/** Every POST that reached the stand-in, by customer: the amounts. */
const posts = new Map<string, number[]>();
let disputes: unknown = { object: "list", data: [], has_more: false };
/** Customers whose balance GET answers 500. */
const unreadable = new Set<string>();
/** Customers whose next balance POST is applied, but answered 500 (a lost reply). */
const lostReply = new Set<string>();
/** Customers whose next balance POST is applied, but answered without a receipt (no cbtxn_ id). */
const noReceipt = new Set<string>();
/** Spent between a read and a write: taken off a customer's credit right after the next balance POST (an invoice). */
const spentAfterPost = new Map<string, number>();

const invoice = () => ({
  id: INVOICE, object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
  created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
  parent: { type: "subscription_details", subscription_details: { subscription: BEA_SUB } },
  payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: PI } }], has_more: false },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const down = () => answer({ error: { type: "api_error", message: "TEST ONLY down" } }, 500);
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: url.searchParams.get("customer") === "cus_BeaClaw01" ? [invoice()] : [], has_more: false });
  const one = path.match(/^\/invoices\/(in_[A-Za-z0-9]+)$/);
  if (method === "GET" && one) return answer(one[1] === INVOICE ? invoice() : { error: "no such invoice" });
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  if (method === "GET" && path === "/disputes") return answer(disputes);
  if (method === "GET" && path === `/subscriptions/${BEA_SUB}`) return answer({ id: BEA_SUB, object: "subscription", metadata: { store: "beaclaw" }, customer: "cus_BeaClaw01" });
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") {
    if (unreadable.has(customer[1])) return down();
    return answer({ id: customer[1], object: "customer", balance: balances.get(customer[1]) ?? 0, currency: "usd" });
  }
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") {
    const rows = (history.get(txns[1]) ?? []).map((r) => ({ id: r.id, object: "customer_balance_transaction", amount: r.amount, currency: "usd", metadata: r.metadata }));
    return answer({ object: "list", data: rows, has_more: false });
  }
  if (txns && method === "POST") {
    const id = txns[1];
    const form = new URLSearchParams(String(init?.body ?? ""));
    const amount = Number(form.get("amount"));
    const metadata: Record<string, string> = {};
    for (const [k, v] of form) {
      const m = k.match(/^metadata\[(.+)\]$/);
      if (m) metadata[m[1]] = v;
    }
    posts.set(id, [...(posts.get(id) ?? []), amount]);
    const row = { id: `cbtxn_${Math.random().toString(36).slice(2, 10)}`, amount, metadata };
    history.set(id, [row, ...(history.get(id) ?? [])]);
    balances.set(id, (balances.get(id) ?? 0) + amount);
    const spent = spentAfterPost.get(id);
    if (spent) {
      spentAfterPost.delete(id);
      balances.set(id, (balances.get(id) ?? 0) + spent);
    }
    if (lostReply.has(id)) {
      lostReply.delete(id);
      return down();
    }
    if (noReceipt.has(id)) {
      noReceipt.delete(id);
      return answer({ object: "customer_balance_transaction", amount });
    }
    return answer({ id: row.id, object: "customer_balance_transaction", amount });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const list = (data: unknown[]) => ({ object: "list", data, has_more: false });
const dispute = (status: string, id = "du_BeaClaw01", invoiceId = INVOICE) => ({
  id, object: "dispute", status, amount: 2900, currency: "usd", payment_intent: PI, created: nowS - 2 * DAY,
  charge: { id: "ch_bea_claw", invoice: { id: invoiceId, subscription: BEA_SUB, lines: { data: [{ period: { start: nowS - 30 * DAY, end: nowS } }] } } },
  balance_transactions: status === "lost" ? [{ id: "txn_out", object: "balance_transaction", amount: -2900, currency: "usd" }] : [],
});

/**
 * Ana invited Bea, who paid her first $29 plan invoice INVITE_HOLD_DAYS + 4 days ago with no dispute then: the run
 * sends Ana's share to her balance and Bea's bonus to hers. Answers Bea's store id.
 */
async function sent(opts: { anaPays?: boolean; anaNoReceipt?: boolean } = {}): Promise<string> {
  redis.clear();
  for (const m of [balances, history, posts, spentAfterPost]) m.clear();
  unreadable.clear();
  lostReply.clear();
  noReceipt.clear();
  if (opts.anaNoReceipt) noReceipt.add("cus_AnaClaw01");
  disputes = list([]);
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana-claw@example.com", "anaclaw");
  const bea = await made("bea-claw@example.com", "beaclaw");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  const anaPays = opts.anaPays ?? true;
  await setSubscription("ana-claw@example.com", { customerId: anaPays ? "cus_AnaClaw01" : null, subscriptionId: anaPays ? "sub_AnaClaw01" : null, active: anaPays, period: paidPeriod() });
  await setSubscription("bea-claw@example.com", { customerId: "cus_BeaClaw01", subscriptionId: BEA_SUB, active: true, period: paidPeriod() });
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
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

const recordOf = (id: string): Record<string, unknown> | null => {
  const raw = redis.run(["GET", creditKey(id)]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
};
const clawed = (id: string) => recordOf(id)?.clawed;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_clawback_only_a_stand_in";

  part("The hold is the cards' dispute window");
  is("120 days, never less than the refund window and a week", [INVITE_DISPUTE_WINDOW_DAYS, INVITE_HOLD_DAYS >= INVITE_DISPUTE_WINDOW_DAYS, INVITE_HOLD_DAYS >= REFUND_DAYS + 7], [120, true, true]);
  const terms = readFileSync("app/terms/page.tsx", "utf8");
  is("the Terms no longer say credit already added stays yours", terms.includes("credit already added\n          stays yours") || terms.includes("credit already added stays yours"), false);
  is("the Terms say a late dispute takes back only unused credit, and never charges a card", /taken back by a dispute[\s\S]{0,400}not yet used[\s\S]{0,400}never charged/.test(terms), true);

  part("Control: the share and the bonus reached Ana and Bea");
  let bonusId = `bonus_${await sent()}`;
  const share = inviteShare(2900, currentInviteTerms());
  is("Ana's share and Bea's bonus are on their balances, both done", [posts.get("cus_AnaClaw01"), recordOf(INVOICE)?.state, recordOf(bonusId)?.state], [[-share], "done", "done"]);
  const bonus = -(posts.get("cus_BeaClaw01")?.[0] ?? 0);
  is("the bonus is a credit", bonus > 0, true);

  part("A lost dispute, the credit unused: all of it is taken back, once");
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("Ana's share debited back whole, Bea's bonus too", [posts.get("cus_AnaClaw01"), posts.get("cus_BeaClaw01")], [[-share, share], [-bonus, bonus]]);
  is("both balances back at zero, never owing", [balances.get("cus_AnaClaw01"), balances.get("cus_BeaClaw01")], [0, 0]);
  is("each record says what was taken back", [clawed(INVOICE), clawed(bonusId)], [share, bonus]);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("asked again: nothing more is sent", [posts.get("cus_AnaClaw01")?.length, posts.get("cus_BeaClaw01")?.length], [2, 2]);

  part("A lost dispute, the credit partly used: only what is left is taken back");
  bonusId = `bonus_${await sent()}`;
  balances.set("cus_AnaClaw01", -500);
  balances.set("cus_BeaClaw01", 0);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("Ana: 500 debited, her balance at zero; Bea, all used: nothing", [posts.get("cus_AnaClaw01")?.slice(1), balances.get("cus_AnaClaw01"), posts.get("cus_BeaClaw01")?.slice(1)], [[500], 0, []]);
  is("the records say what was taken back, the rest is the company's", [clawed(INVOICE), clawed(bonusId)], [500, 0]);

  part("More credit on the balance than this one: never more than the credit itself");
  bonusId = `bonus_${await sent()}`;
  balances.set("cus_AnaClaw01", -10_000);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("only the share is taken back", [posts.get("cus_AnaClaw01")?.slice(1), balances.get("cus_AnaClaw01")], [[share], -10_000 + share]);

  part("The debit applied but its reply lost: found in the history, never sent twice");
  bonusId = `bonus_${await sent()}`;
  lostReply.add("cus_AnaClaw01");
  await quiet(() => clawBackInviteCredits(INVOICE, nowS)).catch(() => undefined);
  is("one debit reached Stripe, the share not marked yet", [posts.get("cus_AnaClaw01")?.slice(1), clawed(INVOICE)], [[share], undefined]);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("the next try finds it: no second debit, the share marked with it", [posts.get("cus_AnaClaw01")?.slice(1), clawed(INVOICE), balances.get("cus_AnaClaw01")], [[share], share, 0]);

  part("A balance that does not read: nothing debited, nothing marked, asked again later");
  bonusId = `bonus_${await sent()}`;
  unreadable.add("cus_AnaClaw01");
  let threw = false;
  await quiet(() => clawBackInviteCredits(INVOICE, nowS)).catch(() => { threw = true; });
  is("it throws, nothing debited to Ana, the share not marked", [threw, posts.get("cus_AnaClaw01")?.length, clawed(INVOICE)], [true, 1, undefined]);

  part("Credit spent between the read and the debit: the balance is put back to zero, never owing");
  bonusId = `bonus_${await sent()}`;
  spentAfterPost.set("cus_AnaClaw01", 1_000);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("Ana's balance ends at zero, not owing", balances.get("cus_AnaClaw01"), 0);
  is("what was taken back is what is not used: the share less what was spent", clawed(INVOICE), share - 1_000);

  part("Found by the daily reading of plan disputes");
  bonusId = `bonus_${await sent()}`;
  disputes = list([dispute("needs_response")]);
  await quiet(() => syncPlanDisputes(Date.now() + 60_000, nowS));
  is("an open dispute takes nothing back", [posts.get("cus_AnaClaw01")?.length, clawed(INVOICE)], [1, undefined]);
  disputes = list([dispute("lost")]);
  await quiet(() => syncPlanDisputes(Date.now() + 60_000, nowS));
  is("lost: the share and the bonus are taken back", [clawed(INVOICE), clawed(bonusId), balances.get("cus_AnaClaw01")], [share, bonus, 0]);
  await quiet(() => syncPlanDisputes(Date.now() + 60_000, nowS));
  is("the next day: nothing more", posts.get("cus_AnaClaw01")?.length, 2);


  part("A share sent whose receipt was lost (still owed here), then a lost dispute: taken back too (Claude 4's MEDIUM on #4514)");
  bonusId = `bonus_${await sent({ anaNoReceipt: true })}`;
  is("control: the send landed, but the share is still owed here", [posts.get("cus_AnaClaw01"), balances.get("cus_AnaClaw01"), recordOf(INVOICE)?.state], [[-share], -share, "owed"]);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("the landed share is taken back, and written done with what was taken", [posts.get("cus_AnaClaw01"), balances.get("cus_AnaClaw01"), recordOf(INVOICE)?.state, clawed(INVOICE)], [[-share, share], 0, "done", share]);
  await quiet(() => settleInvites(Date.now() + 60_000, NOW));
  is("the next invite run sends nothing more to Ana, and her balance stays at zero", [posts.get("cus_AnaClaw01")?.length, balances.get("cus_AnaClaw01")], [2, 0]);

  part("A share never sent (its inviter not paying yet): nothing is debited");
  bonusId = `bonus_${await sent({ anaPays: false })}`;
  balances.set("cus_AnaClaw01", -5_000);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("no customer yet: nothing debited, the share still owed and not marked", [posts.get("cus_AnaClaw01") ?? [], recordOf(INVOICE)?.state, clawed(INVOICE)], [[], "owed", undefined]);
  // She starts paying, with other credit on her balance; the share was still never sent.
  await setSubscription("ana-claw@example.com", { customerId: "cus_AnaClaw01", subscriptionId: "sub_AnaClaw01", active: true, period: paidPeriod() });
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("paying now: nothing debited from her other credit, the share still owed and not marked", [posts.get("cus_AnaClaw01") ?? [], balances.get("cus_AnaClaw01"), recordOf(INVOICE)?.state, clawed(INVOICE)], [[], -5_000, "owed", undefined]);

  part("A share written as earning nothing is never debited, whatever amount its record carries");
  bonusId = `bonus_${await sent({ anaPays: false })}`;
  await setSubscription("ana-claw@example.com", { customerId: "cus_AnaClaw01", subscriptionId: "sub_AnaClaw01", active: true, period: paidPeriod() });
  redis.run(["SET", creditKey(INVOICE), JSON.stringify({ ...recordOf(INVOICE), state: "none" })]);
  balances.set("cus_AnaClaw01", -5_000);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("nothing debited, the record left as it was", [posts.get("cus_AnaClaw01") ?? [], balances.get("cus_AnaClaw01"), clawed(INVOICE)], [[], -5_000, undefined]);

  part("A bonus earned with another payment is not taken back for this one");
  bonusId = `bonus_${await sent()}`;
  const other = recordOf(bonusId)!;
  redis.run(["SET", creditKey(bonusId), JSON.stringify({ ...other, at: (other.at as number) - DAY })]);
  await quiet(() => clawBackInviteCredits(INVOICE, nowS));
  is("the share is taken back, the bonus is left", [clawed(INVOICE), clawed(bonusId), posts.get("cus_BeaClaw01")?.length], [share, undefined, 1]);

  part("A clawback that fails keeps its dispute open: the next run takes it back");
  bonusId = `bonus_${await sent()}`;
  unreadable.add("cus_AnaClaw01");
  disputes = list([dispute("lost")]);
  const failing = await quiet(() => syncPlanDisputes(Date.now() + 60_000, nowS));
  is("not taken back, the run not clean, the dispute still open", [clawed(INVOICE), failing.failed > 0, String(redis.run(["HGET", SEEN_KEY, "du_BeaClaw01"])).startsWith("open:")], [undefined, true, true]);
  unreadable.clear();
  await quiet(() => syncPlanDisputes(Date.now() + 60_000, nowS));
  is("the next run takes it back", [clawed(INVOICE), balances.get("cus_AnaClaw01")], [share, 0]);

  part("At most CLAWBACKS_PER_RUN lost disputes are taken back in one run; the rest stay open for the next");
  await sent();
  disputes = list(Array.from({ length: CLAWBACKS_PER_RUN + 1 }, (_, i) => dispute("lost", `du_BeaMany${String(i).padStart(2, "0")}`, `in_BeaMany${String(i).padStart(5, "0")}`)));
  const many = await quiet(() => syncPlanDisputes(Date.now() + 60_000, nowS));
  const marks = Array.from({ length: CLAWBACKS_PER_RUN + 1 }, (_, i) => String(redis.run(["HGET", SEEN_KEY, `du_BeaMany${String(i).padStart(2, "0")}`])));
  is("one over the ceiling: one left open and counted as failed, the rest final", [many.failed, marks.filter((m) => m.startsWith("open:")).length, marks.filter((m) => m === "final").length], [1, 1, CLAWBACKS_PER_RUN]);

  part("The used part is a funded exposure with a calculated ceiling");
  const t = currentInviteTerms();
  is("one late dispute costs at most its share and its bonus", lateDisputeExposureCeilingCents(2900, t), inviteShare(2900, t) + t.bonusCents);
  is("the share is the terms' percent", INVITE_SHARE_PERCENT > 0, true);
  done();
}

void main();
