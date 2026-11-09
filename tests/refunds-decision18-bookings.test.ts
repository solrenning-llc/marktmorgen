/**
 * A booking whose full refund could not be confirmed on a reading (lib/calls.ts, unconfirmed; the owner's decision 18)
 * keeps its time and is never taken for paid, nor dropped for good: the coordinator's second pre-review of
 * claude5/refunds-d18-central @342e5883a0 (proofs H and I, kept with credit). Synthetic only.
 *   H. a booking marked unconfirmed (refunded in full, refund not confirmable on this reading) is confirmed anyway by
 *      catchUpBookings (public booking page and studio, after()): emails go out and the meeting is made;
 *   I. sendCallReminders takes an unconfirmed booking's reminder off the queue for good (done.push, no pop), so when
 *      the refund turns out to have failed the paying buyer never gets it.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Store } from "@/lib/store";
import { catchUpBookings, isConfirmed, paidCalls } from "@/lib/calls";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_refunds_d18_bookings";
process.env.RESEND_API_KEY = "re_test_prerev_d18b";
const NOW = Math.floor(Date.now() / 1000);
let refundsDown = true;
const refundState = "succeeded";
let chargeRefunded = true;
let emails = 0;
let sessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return answer({ id: `e${emails}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
  if (path.startsWith("/checkout/sessions/")) return answer(sessions[0] ?? {});
  if (path === "/refunds" && url.searchParams.get("charge")) {
    if (refundsDown) return answer({ error: { type: "api_error", message: "down" } }, 500);
    return answer({ object: "list", data: [{ id: "re_PrerevD18b01", object: "refund", status: refundState, amount: 4900, created: NOW - 600, charge: "ch_PrerevD18b01" }], has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const weekly = { kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[0, 1440]], [[0, 1440]], [[0, 1440]], [[0, 1440]], [[0, 1440]], [[0, 1440]]], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;

async function main(): Promise<void> {
  redis.clear();
  const email = "prerevd18b@example.com";
  await claimHandle(email, "prerevd18b", "Prerev", "");
  await ensureStatsId(email);
  await setStripeAccount(email, "acct_1TestPrerevD18b", true);
  await setSubscription(email, { customerId: "cus_prerevd18b01", subscriptionId: "sub_prerevd18b01", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const start = (NOW + 20 * 3600) * 1000;
  const session = "cs_test_prerevd18bbooking0001";
  const row = () => ({
    id: session, object: "checkout.session", status: "complete", payment_status: "paid", created: NOW - 3600, amount_total: 4900, currency: "usd",
    customer_details: { email: "buyer@example.com", name: "Buyer" },
    metadata: { kind: "call", store: "prerevd18b", product: made.product.id, start: String(start), end: String(start + 3_600_000) },
    payment_intent: { id: "pi_PrerevD18b01", object: "payment_intent", latest_charge: { object: "charge", id: "ch_PrerevD18b01", amount: 4900, amount_refunded: chargeRefunded ? 4900 : 0, refunded: chargeRefunded, disputed: false } },
  });
  sessions = [row()];

  part("H: catchUpBookings and an unconfirmed booking");
  const paid = await paidCalls(store);
  is("the booking reads unconfirmed (refund not confirmable)", paid.map((c) => c.unconfirmed), [true]);
  emails = 0;
  await catchUpBookings(store, paid, "https://marktmorgen.com");
  is("an unconfirmed booking is not confirmed (no emails, no meeting) by the catch-up", [await isConfirmed(session), emails], [false, 0]);

  part("I: reminders for an unconfirmed booking stay queued for a later reading");
  emails = 0;
  redis.clear();
  await claimHandle(email, "prerevd18b", "Prerev", "");
  await ensureStatsId(email);
  await setStripeAccount(email, "acct_1TestPrerevD18b", true);
  await setSubscription(email, { customerId: "cus_prerevd18b01", subscriptionId: "sub_prerevd18b01", active: true, tier: "pro", period: paidPeriod() });
  const again = await addProduct(email, "Strategy call", "", "49", null);
  if (!again.ok) throw new Error("no product");
  await setProductCall(email, again.product.id, weekly);
  const s2 = (await storeForEmail(email)) as Store;
  made.product.id = again.product.id;
  sessions = [row()];
  const member = reminderMember(s2.callsId as string, "prerevd18b", session, "24", start);
  await redis.pipeline([["ZADD", REMINDER_QUEUE, Date.now() - 1000, member]]);
  refundsDown = true;
  await sendCallReminders(async () => s2, Date.now() + 20_000, "https://marktmorgen.com");
  const kept = (await redis.pipeline([["ZSCORE", REMINDER_QUEUE, member]]))[0];
  is("unknown on this run: the reminder is kept for the next run, not dropped for good", kept !== null, true);
  is("and no reminder went to someone who may have had the money back", emails, 0);
  // The refund turns out to have failed: Stripe no longer marks the charge refunded, and the paying buyer is reminded.
  chargeRefunded = false;
  refundsDown = false;
  sessions = [row()];
  await sendCallReminders(async () => s2, Date.now() + 20_000, "https://marktmorgen.com");
  // This synthetic store has no admitted order for the booking, so its email meter refuses the send and the reminder
  // stays queued for a retry (lib/call-reminders.ts); what matters here is that it is now read as paid and still there.
  is("once the refund failed, the booking reads paid and its reminder is still there to send", [(await paidCalls(s2)).map((c) => c.unconfirmed), (await redis.pipeline([["ZSCORE", REMINDER_QUEUE, member]]))[0] !== null], [[false], true]);
  done();
}

void main();
