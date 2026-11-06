/**
 * Codex C2 review evidence for #2722: every InvoicePayment variant must be
 * understood before its refund evidence can be treated as zero.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription } from "@/lib/store";
import { settleInvites } from "@/lib/creator-invite-credit";
import { ALL_KEY, byKey, creditKey } from "@/lib/creator-invites";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";

const DAY = 86_400;
const NOW_MS = Date.UTC(2026, 9, 16, 12);
const NOW = Math.floor(NOW_MS / 1000);
const invoiceByCustomer = new Map<string, Record<string, unknown>>();
const refundByPayment = new Map<string, unknown>();
const postedCredits: string[] = [];

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return answer({}, 404);
  if (method === "GET" && path === "/invoices") {
    const row = invoiceByCustomer.get(url.searchParams.get("customer") ?? "");
    return answer({ object: "list", data: row ? [row] : [], has_more: false });
  }
  if (method === "GET" && path === "/refunds") {
    const payment = url.searchParams.get("payment_intent") ?? url.searchParams.get("charge") ?? "";
    return answer(refundByPayment.get(payment));
  }
  if (method === "GET" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    return answer({ object: "list", data: [], has_more: false });
  }
  if (method === "POST" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    const form = new URLSearchParams(String(init?.body ?? ""));
    postedCredits.push(form.get("metadata[nimbus_invite_credit]") ?? "");
    return answer({ id: `cbtxn_${postedCredits.length}abcdef`, object: "customer_balance_transaction" });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

function invoice(id: string, customer: string, payment: Record<string, unknown>): void {
  const paidAt = NOW - (INVITE_HOLD_DAYS + 4) * DAY;
  invoiceByCustomer.set(customer, {
    id,
    object: "invoice",
    status: "paid",
    amount_paid: 2_900,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    created: paidAt,
    status_transitions: { paid_at: paidAt },
    parent: { type: "subscription_details" },
    payments: { object: "list", data: [{ payment }], has_more: false },
  });
}

async function invitedStore(
  inviterSid: string,
  handle: string,
  customer: string,
  invoiceId: string,
  payment: Record<string, unknown>,
): Promise<void> {
  const made = await claimHandle(`${handle}@example.com`, handle, handle, "");
  if (!made.ok) throw new Error(`fixture failed: ${handle}`);
  await setSubscription(`${handle}@example.com`, {
    customerId: customer,
    subscriptionId: `sub_${handle.replace(/-/g, "")}01`,
    active: true,
  });
  redis.run([
    "SET",
    byKey(made.store.sid),
    JSON.stringify({ r: inviterSid, at: NOW - 60 * DAY, terms: { version: 1, sharePercent: 50, bonusCents: 0 } }),
  ]);
  redis.run(["ZADD", ALL_KEY, NOW - 60 * DAY, made.store.sid]);
  invoice(invoiceId, customer, payment);
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_c2_invoice_payment_type_proof_only";
  redis.clear();
  const inviter = await claimHandle("inviter-c2-type@example.com", "inviter-c2-type", "Inviter", "");
  if (!inviter.ok) throw new Error("inviter fixture failed");
  await setSubscription("inviter-c2-type@example.com", {
    customerId: "cus_InviterC201",
    subscriptionId: "sub_InviterC201",
    active: true,
  });

  await invitedStore(inviter.store.sid, "payment-record", "cus_Record0001", "in_Record0001", {
    type: "payment_record",
    payment_record: "payrec_unknown_refund_evidence",
  });
  await invitedStore(inviter.store.sid, "known-intent", "cus_Intent0001", "in_Intent0001", {
    type: "payment_intent",
    payment_intent: "pi_known_refunded",
  });
  refundByPayment.set("pi_known_refunded", {
    object: "list",
    data: [{ amount: 2_900, status: "succeeded" }],
    has_more: false,
  });

  const run = await settleInvites(Date.now() + 60_000, NOW_MS);
  const unknown = redis.run(["GET", creditKey("in_Record0001")]);
  const known = JSON.parse(String(redis.run(["GET", creditKey("in_Intent0001")]))) as { state: string };

  part("Invoice payment variants are exact before invite credit");
  is("a payment_record without understood refund evidence creates no credit", unknown, null);
  is("the unknown variant is never posted as plan credit", postedCredits.includes("in_Record0001"), false);
  is("unknown payment evidence fails the store and the pass", [run.failed >= 1, run.complete], [true, false]);
  is("a known PaymentIntent with a confirmed full refund earns nothing", [known.state, postedCredits.includes("in_Intent0001")], ["none", false]);
  done();
}

void main();
