/**
 * Issue #4424 (Codex X8): a refund whose status is not one of Stripe's known states must never be read as "nothing
 * refunded". The store fails the run, no credit is written and nothing is posted. Known states keep their treatment:
 * succeeded, pending and requires_action subtract the money; failed and canceled do not.
 * Refund states: https://docs.stripe.com/api/refunds/object
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
    postedCredits.push(form.get("metadata[nimbus_invite_credit]") ?? "");
    return answer({ id: `cbtxn_${postedCredits.length}abcdef`, object: "customer_balance_transaction" });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

function invoice(id: string, customer: string, payment: string): void {
  const paidAt = NOW - (INVITE_HOLD_DAYS + 4) * DAY;
  invoiceByCustomer.set(customer, {
    id,
    object: "invoice",
    status: "paid",
    amount_paid: 10_000,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    created: paidAt,
    status_transitions: { paid_at: paidAt },
    parent: { type: "subscription_details" },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: payment } }], has_more: false },
  });
}

const STATUS_CASES = [
  { status: "mystery_state", key: "Mystery" },
  { status: "succeeded", key: "Succeed" },
  { status: "pending", key: "Pending" },
  { status: "requires_action", key: "ReqActn" },
  { status: "failed", key: "Failedx" },
  { status: "canceled", key: "Canceld" },
];

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_issue4424_refund_status_only";
  redis.clear();
  const inviter = await claimHandle("inviter@example.com", "inviter-status", "Inviter", "");
  if (!inviter.ok) throw new Error("inviter fixture failed");
  await setSubscription("inviter@example.com", { customerId: "cus_Inviter001", subscriptionId: "sub_Inviter001", active: true });

  for (const c of STATUS_CASES) {
    const handle = `status-${c.key.toLowerCase()}`;
    const made = await claimHandle(`${handle}@example.com`, handle, handle, "");
    if (!made.ok) throw new Error(`fixture failed: ${handle}`);
    await setSubscription(`${handle}@example.com`, { customerId: `cus_${c.key}001`, subscriptionId: `sub_${c.key}001`, active: true });
    redis.run(["SET", byKey(made.store.sid), JSON.stringify({ r: inviter.store.sid, at: NOW - 60 * DAY, terms: { version: 1, sharePercent: 50, bonusCents: 0 } })]);
    redis.run(["ZADD", ALL_KEY, NOW - 60 * DAY, made.store.sid]);
    invoice(`in_${c.key}001`, `cus_${c.key}001`, `pi_${c.key.toLowerCase()}`);
    refundAnswerByPayment.set(`pi_${c.key.toLowerCase()}`, { object: "list", data: [{ amount: 10_000, status: c.status }], has_more: false });
  }

  const run = await settleInvites(Date.now() + 60_000, NOW_MS);
  const read = (key: string) => {
    const raw = redis.run(["GET", creditKey(`in_${key}001`)]);
    return raw === null ? null : (JSON.parse(String(raw)) as { cents: number; state: string });
  };

  part("A refund with a status not known is not read as no refund");
  is("the run is not complete and a store failed", [run.complete, run.failed >= 1], [false, true]);
  is("no credit record is written", read("Mystery"), null);
  is("nothing is posted to the balance", postedCredits.includes("in_Mystery001"), false);

  part("Known refund states keep their treatment");
  for (const key of ["Succeed", "Pending", "ReqActn"]) {
    is(`${key}: the refunded money is taken off, so nothing is earned or posted`, [read(key)?.state, read(key)?.cents, postedCredits.includes(`in_${key}001`)], ["none", 0, false]);
  }
  for (const key of ["Failedx", "Canceld"]) {
    is(`${key}: no money went back, so the share is earned and posted once`, [read(key)?.state, read(key)?.cents, postedCredits.filter((id) => id === `in_${key}001`).length], ["done", 5_000, 1]);
  }
  done();
}

void main();
