/**
 * Codex N review evidence for #2722: a paid invoice's expanded payment list
 * must be complete and exact before its refunds can be treated as zero.
 */
import { store as redis } from "../../tests/redis-stub";
import { done, is, part } from "../../tests/check";
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

function invoice(id: string, customer: string, payments: unknown): void {
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
    ...(payments === undefined ? {} : { payments }),
  });
}

async function invitedStore(
  inviterSid: string,
  handle: string,
  customer: string,
  invoiceId: string,
  payments: unknown,
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
  invoice(invoiceId, customer, payments);
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_n_invite_payment_proof_only";
  redis.clear();
  const inviter = await claimHandle("inviter-n@example.com", "inviter-n-proof", "Inviter", "");
  if (!inviter.ok) throw new Error("inviter fixture failed");
  await setSubscription("inviter-n@example.com", {
    customerId: "cus_InviterN01",
    subscriptionId: "sub_InviterN01",
    active: true,
  });

  await invitedStore(inviter.store.sid, "missing-payments", "cus_Missing001", "in_Missing001", undefined);
  await invitedStore(
    inviter.store.sid,
    "partial-payments",
    "cus_Partial001",
    "in_Partial001",
    { object: "list", data: [], has_more: true },
  );
  await invitedStore(
    inviter.store.sid,
    "known-payment",
    "cus_Known0001",
    "in_Known0001",
    {
      object: "list",
      data: [{ payment: { type: "payment_intent", payment_intent: "pi_known" } }],
      has_more: false,
    },
  );
  refundByPayment.set("pi_known", {
    object: "list",
    data: [{ amount: 2_900, status: "succeeded" }],
    has_more: false,
  });

  const run = await settleInvites(Date.now() + 60_000, NOW_MS);
  const missing = redis.run(["GET", creditKey("in_Missing001")]);
  const partial = redis.run(["GET", creditKey("in_Partial001")]);
  const known = JSON.parse(String(redis.run(["GET", creditKey("in_Known0001")]))) as { state: string };

  part("Invoice payments are read exactly before invite credit");
  is("missing expanded payments create no credit", missing, null);
  is("a truncated payment list creates no credit", partial, null);
  is("unknown payment evidence fails the stores and the pass", [run.failed >= 2, run.complete], [true, false]);
  is("a complete payment list and confirmed full refund earn nothing", [known.state, postedCredits.includes("in_Known0001")], ["none", false]);
  done();
}

void main();
