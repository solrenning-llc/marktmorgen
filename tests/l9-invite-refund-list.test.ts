/**
 * Codex C2 on #2722 (codex/c-review-invite-credit-refund-list-evidence@2ab54442, made a permanent test): a Stripe
 * refund list that is not read exactly must never become proof that no refund happened before an invite credit is
 * put on another creator's plan. The store fails the run, no credit is written, and nothing is posted.
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
const refundAnswerByPayment = new Map<string, unknown>();
const postedCredits: string[] = [];

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
    return answer(refundAnswerByPayment.get(payment));
  }
  if (method === "GET" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    return answer({ object: "list", data: [], has_more: false });
  }
  if (method === "POST" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const credit = form.get("metadata[nimbus_invite_credit]") ?? "";
    postedCredits.push(credit);
    return answer({ id: `cbtxn_${postedCredits.length}abcdef`, object: "customer_balance_transaction" });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

function invoice(id: string, customer: string, payment: string): Record<string, unknown> {
  const paidAt = NOW - (INVITE_HOLD_DAYS + 4) * DAY;
  const row = {
    id,
    object: "invoice",
    status: "paid",
    amount_paid: 2_900,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    created: paidAt,
    status_transitions: { paid_at: paidAt },
    parent: { type: "subscription_details" },
    payments: { data: [{ payment: { type: "payment_intent", payment_intent: payment } }] },
  };
  invoiceByCustomer.set(customer, row);
  return row;
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_c2_invite_refund_proof_only";
  redis.clear();
  const inviter = await claimHandle("inviter@example.com", "inviter-proof", "Inviter", "");
  if (!inviter.ok) throw new Error("inviter fixture failed");
  await setSubscription("inviter@example.com", { customerId: "cus_Inviter001", subscriptionId: "sub_Inviter001", active: true });

  const cases = [
    { handle: "unknown-refund", customer: "cus_Unknown001", invoice: "in_Unknown001", payment: "pi_unknown", refunds: { object: "list", has_more: false } },
    { handle: "known-refund", customer: "cus_Refunded01", invoice: "in_Refunded01", payment: "pi_refunded", refunds: { object: "list", data: [{ amount: 2_900, status: "succeeded" }], has_more: false } },
    { handle: "clean-payment", customer: "cus_Clean0001", invoice: "in_Clean0001", payment: "pi_clean", refunds: { object: "list", data: [], has_more: false } },
  ];
  for (const c of cases) {
    const made = await claimHandle(`${c.handle}@example.com`, c.handle, c.handle, "");
    if (!made.ok) throw new Error(`fixture failed: ${c.handle}`);
    await setSubscription(`${c.handle}@example.com`, { customerId: c.customer, subscriptionId: `sub_${c.handle.replace(/-/g, "")}01`, active: true });
    redis.run(["SET", byKey(made.store.sid), JSON.stringify({ r: inviter.store.sid, at: NOW - 60 * DAY, terms: { version: 1, sharePercent: 50, bonusCents: 0 } })]);
    redis.run(["ZADD", ALL_KEY, NOW - 60 * DAY, made.store.sid]);
    invoice(c.invoice, c.customer, c.payment);
    refundAnswerByPayment.set(c.payment, c.refunds);
  }

  const run = await settleInvites(Date.now() + 60_000, NOW_MS);
  const unknown = redis.run(["GET", creditKey("in_Unknown001")]);
  const refunded = JSON.parse(String(redis.run(["GET", creditKey("in_Refunded01")])));
  const clean = JSON.parse(String(redis.run(["GET", creditKey("in_Clean0001")])));
  part("Refunds read exactly before a credit is earned");
  is("unknown refund evidence creates no credit record", unknown, null);
  is("and the run says a store failed and is not complete", [run.failed >= 1, run.complete], [true, false]);
  is("a confirmed full refund earns nothing", [refunded.state, postedCredits.includes("in_Refunded01")], ["none", false]);
  is("a confirmed empty refund list earns its clean payment once", [clean.state, postedCredits.filter((id) => id === "in_Clean0001").length], ["done", 1]);
  done();
}

void main();

