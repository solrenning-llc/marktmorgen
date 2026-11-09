/**
 * The second independent pre-review's proofs for claude5/plan-lifecycle-truth
 * (@6bd4225ec8), kept as regression checks: G-1 (a plan left past due ends 63
 * days after its renewal was first unpaid, however many renewals follow),
 * A-1 (the cancel's mark is the moment of the cancel; an older renewal still
 * open is said), M-1 (the email's end date is that same clock), M-2 (the
 * brake keeps no address after a store is deleted), L-2 (startedFrom agrees
 * with stateOf on a past-due plan whose latest invoice is void).
 *
 * Regra 23, changes to the proofs as received:
 * - F2's first check asked stateOf alone to end a monthly plan whose latest
 *   invoice is at most 31 days old. stateOf sees only that invoice; the clock
 *   the review asks for (G-1) is the store's first unpaid day, which only the
 *   writers that hold the store know (lib/no-try-rules.ts, noTryEnded, applied
 *   by setSubscription). The check now asks that clock, and that stateOf alone
 *   still never ends such a plan on day 0 (M-a of the first review).
 * - F3's last check asked stateOf alone for the end on the email's day; it now
 *   runs the daily job on that day for a store that recorded the renewal unpaid
 *   when the email went, which is the reading that ends the plan.
 * - F4 deleted an account's first store, which deleteStore refuses ("first"):
 *   the store, and so its reference, was still there. It now deletes an extra
 *   store, and closes the first one (closeStoreRecord, the closing day's end).
 */
import { cancelAndStopUnpaidRenewal, startedFrom, stateOf } from "@/lib/billing";
import { failedPlan, failedPlanEmail } from "@/lib/billing-reminders";
import { reserveMissingEnds, syncSubscriptions, MISSING_ENDS_KEY } from "@/lib/billing-sync";
import { claimHandle, closeStoreRecord, createStore, deleteStore, ensureStatsId, setSubscription, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { noTryEnded } from "@/lib/no-try-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev_lifecycle2";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const period = paidPeriod((NOW - 3 * DAY) * 1000);
const items = { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 6900, currency: "usd", lookup_key: "marktmorgen_creator_month", recurring: { interval: "month", interval_count: 1 } } }] };
const SUB = "sub_Prerev2Month1";

// ---- Stripe stand-in: a monthly plan unpaid for two cycles; month 2's renewal is the latest invoice.
const metadata: Record<string, string> = { store: "prerev2-shop" };
let subStatus = "past_due";
const latest = { id: "in_Prerev2Month2", object: "invoice", status: "open", billing_reason: "subscription_cycle", collection_method: "charge_automatically", created: NOW - 3 * DAY, amount_due: 6900, next_payment_attempt: NOW + 2 * DAY as number | null, hosted_invoice_url: "https://invoice.stripe.com/i/x" };
let listed: Record<string, unknown>[] = [];
const sub = () => ({ id: SUB, object: "subscription", status: subStatus, customer: { id: "cus_Prerev2", email: "prerev2@example.com" }, metadata: { ...metadata }, cancel_at_period_end: true, cancel_at: null, trial_end: null, items, latest_invoice: { ...latest } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (method === "POST" && url.pathname === `/v1/subscriptions/${SUB}`) {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const mark = form.get("metadata[renewal_voided_before]");
    if (mark) metadata.renewal_voided_before = mark;
    return Response.json(sub());
  }
  if (method === "POST" && url.pathname === `/v1/invoices/${latest.id}/void`) {
    latest.status = "void"; latest.next_payment_attempt = null;
    subStatus = "active"; // Stripe reads the subscription from its latest invoice, now void (the case G1 was written for)
    return Response.json({ id: latest.id, object: "invoice", status: "void" });
  }
  if (url.pathname === "/v1/subscriptions") return Response.json({ object: "list", has_more: false, url: "/v1/subscriptions", data: listed });
  const one = /^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(url.pathname);
  if (one) { const row = listed.find((s) => s.id === one[1]); return row ? Response.json(row) : new Response("{}", { status: 500 }); }
  if (/^\/v1\/customers\//.test(url.pathname)) return Response.json({ id: "cus_x", object: "customer" });
  return new Response("{}", { status: 500 });
}) as typeof fetch;

async function main() {
  part("F1: the cancel's mark is the store's first unpaid day, older than month 2's renewal it voids");
  // The store wrote the renewal unpaid 33 days ago (month 1); month 2's cycle invoice is 3 days old.
  const unpaidSince = NOW - 33 * DAY;
  const { renewal, olderMayBeOpen } = await cancelAndStopUnpaidRenewal(SUB, unpaidSince);
  is("(control) our cancel voided the open renewal", renewal, "voided");
  is("the mark is the moment of the cancel, not the first unpaid day", Math.abs(Number(metadata.renewal_voided_before) - NOW) <= 5, true);
  is("(A-1) an earlier renewal may still be open: the cancel says so", olderMayBeOpen, true);
  const after = stateOf(sub());
  is("the period our cancel voided unpaid must still read unpaid (checkout closed, costs paused)", after.state === "active" && after.renewalUnpaid, true);

  part("F2: a monthly plan left past due at Stripe never reaches NO_TRY_WAIT_DAYS");
  // Each month Stripe makes a new cycle invoice, so the latest one is never older than ~31 days.
  let everEnded = false;
  for (let age = 0; age <= 31; age += 1) {
    const s = { ...sub(), status: "past_due", cancel_at_period_end: false, latest_invoice: { ...latest, status: "open", next_payment_attempt: null, created: NOW - age * DAY } };
    if (stateOf(s).state === "inactive") everEnded = true;
  }
  is("(M-a) stateOf alone never ends it on the latest invoice's age under 63 days", everEnded, false);
  const record = (since: number) => ({ subscriptionActive: true, subscriptionId: SUB, planEndedAt: "", renewalUnpaidSince: since });
  is("(G-1) the store's own clock ends it 63 days after its renewal was first unpaid", noTryEnded(record(NOW - 64 * DAY), SUB, NOW - 5 * DAY, NOW), true);
  is("(G-1) and not a day before", noTryEnded(record(NOW - 62 * DAY), SUB, NOW - 5 * DAY, NOW), false);
  redis.clear();
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() - 200 * DAY * 1000; // the renewal was first written unpaid 200 days ago
  await claimHandle("prerev2@example.com", "prerev2-shop", "P2", "");
  await ensureStatsId("prerev2@example.com");
  await setSubscription("prerev2@example.com", { customerId: "cus_Prerev2", subscriptionId: SUB, active: true, tier: "creator", cycle: "month", period, renewalUnpaid: true });
  Date.now = realNow;
  listed = [{ ...sub(), status: "past_due", cancel_at_period_end: false, metadata: { store: "prerev2-shop" }, latest_invoice: { ...latest, id: "in_Prerev2Month7", status: "open", next_payment_attempt: null, created: NOW - 20 * DAY } }];
  await syncSubscriptions(Date.now() + 20_000);
  const kept = (await storeForEmail("prerev2@example.com"))!;
  is("a store unpaid for 200 days with no try scheduled is ended by the daily job", kept.subscriptionActive, false);

  part("F3: the email's end date is when the plan ends");
  // The renewal of month 1 failed 21 days ago; the store recorded it unpaid then, and the email goes now.
  redis.clear();
  const first = NOW - 21 * DAY;
  Date.now = () => first * 1000;
  await claimHandle("prerev3@example.com", "prerev3-shop", "P3", "");
  await ensureStatsId("prerev3@example.com");
  await setSubscription("prerev3@example.com", { customerId: "cus_Prerev2", subscriptionId: SUB, active: true, tier: "creator", cycle: "month", period, renewalUnpaid: true });
  Date.now = realNow;
  const month1 = { ...sub(), status: "past_due", cancel_at_period_end: false, metadata: { store: "prerev3-shop" }, latest_invoice: { ...latest, status: "open", next_payment_attempt: null, created: first } };
  const due = failedPlan(month1, first)!;
  const promised = due.endsAt;
  const { text } = failedPlanEmail(due);
  is("(control) the email names a day the plan ends", /your plan ends/.test(text), true);
  is("(M-1) that day is 63 days after the renewal was first unpaid", promised, first + 63 * DAY);
  // On the promised day the latest invoice is the cycle made ~2 months after month 1's, still unpaid.
  listed = [{ ...month1, latest_invoice: { ...month1.latest_invoice, id: "in_Prerev2Month3", created: promised - 3 * DAY } }];
  Date.now = () => promised * 1000 + 60_000;
  try { await syncSubscriptions(Date.now() + 20_000); } finally { Date.now = realNow; }
  is("on that day, still unpaid, the plan has ended", (await storeForEmail("prerev3@example.com"))!.subscriptionActive, false);

  part("F4: the weekly brake keeps a store owner's address after the store is deleted");
  redis.clear();
  await claimHandle("gone@example.com", "gone-shop", "Gone", "");
  await ensureStatsId("gone@example.com");
  const s = (await storeForEmail("gone@example.com"))!;
  is("(control) room taken under the store's reference", await reserveMissingEnds([storeRef(s)]), true);
  is("(control) the reference is the owner's address", storeRef(s), "gone@example.com");
  is("(control) an account's first store is not deleted from the studio", (await deleteStore("gone@example.com")).ok, false);
  const made = await createStore("gone@example.com", "gone-extra", "Gone extra", "");
  if (!made.ok) throw new Error(`no extra store: ${JSON.stringify(made)}`);
  const extra = (await storeForId(made.store.sid))!;
  is("(control) room taken under the extra store's reference", await reserveMissingEnds([storeRef(extra)]), true);
  is("(control) the extra store is deleted", (await deleteStore(storeRef(extra))).ok, true);
  is("once a store is deleted, its reference is not kept in the brake", (await redis.pipeline([["ZSCORE", MISSING_ENDS_KEY, storeRef(extra)]]))[0], null);
  await closeStoreRecord(s);
  is("once a store's record is closed, its owner's address is not kept in the brake", (await redis.pipeline([["ZSCORE", MISSING_ENDS_KEY, "gone@example.com"]]))[0], null);

  part("F5 (L-2): a past-due plan whose latest invoice is void");
  const voidLatest = { ...sub(), status: "past_due", cancel_at_period_end: true, latest_invoice: { ...latest, status: "void", next_payment_attempt: null, created: NOW - 3 * DAY } };
  is("(control) stateOf reads it a live plan in its grace", stateOf(voidLatest).state, "active");
  is("startedFrom agrees with stateOf (else observeStoreSubscriptions.find throws for the store)", startedFrom(voidLatest) !== null, true);
  done();
}
main();

