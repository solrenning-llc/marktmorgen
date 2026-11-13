/**
 * Issue #4475, Codex X8 report of 13/11/2026 06:46: a settled checkout read without
 * amount_total makes markPaid write the request's own pre-tax total as the
 * amount charged, and because the request is then paid, a later read of the
 * same session that does carry the charged amount changes nothing, so the
 * page and the receipt show $100 for a $108 payment.
 *
 * Synthetic: in-memory Redis, stand-in Stripe, no email sent.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest, markPaid, readRequest } from "@/lib/payment-request-store";
import { settleFromReturn } from "@/lib/payment-requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const id = `cs_test_${"r".repeat(24)}`;
    const meta: Record<string, string> = {};
    for (const [key, value] of body) {
      const m = /^metadata\[(.+)\]$/.exec(key);
      if (m) meta[m[1]] = value;
    }
    sessions.set(id, { id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, metadata: meta, created: Math.floor(Date.now() / 1000) });
    return answer(sessions.get(id));
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const found = sessions.get(decodeURIComponent(path.slice("/checkout/sessions/".length)));
    return found ? answer(found) : answer({ error: { code: "resource_missing", message: "No such checkout" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const draft = (over: Record<string, unknown> = {}) => ({ email: "client@example.com", name: "Dana", lines: [{ text: "Coaching, October", quantity: 1, amount: "100" }], note: "Thank you.", dueDate: "", autoReminders: 0, consent: true, ...over });

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Dana's Studio Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_request_total_stand_in";
  process.env.RESEND_API_KEY = "re_test_payment_request_total_stand_in";
  const now = Date.now();

  /** One open request of $100, and the id of a settled checkout of its own that charged $108 with tax. */
  const open = async (owner: string, handle: string) => {
    const store = await paidStore(owner, handle);
    const made = await createRequest(store, (readDraft(draft(), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
    if (!made.ok) throw new Error("no request");
    const id = `cs_test_${handle.padEnd(24, "x").slice(0, 24)}`;
    sessions.set(id, { id, status: "complete", payment_status: "paid", currency: "usd", payment_intent: `pi_${handle}0001`, created: Math.floor(now / 1000), metadata: { kind: "request", request: made.request.id, store: handle }, amount_total: 10_800 });
    return { store, request: made.request, session: id };
  };

  part("Control: the charged amount is read from the session");
  const a = await open("requests-a@example.com", "danacoacha");
  await settleFromReturn(a.store, a.request, a.session, now);
  is("the request is paid for what Stripe charged, tax included", [(await readRequest(a.request.id))?.state, (await readRequest(a.request.id))?.amountPaid], ["paid", 10_800]);

  part("A settled session read without a charged amount");
  const b = await open("requests-b@example.com", "danacoachb");
  delete sessions.get(b.session)!.amount_total;
  await settleFromReturn(b.store, b.request, b.session, now);
  const first = (await readRequest(b.request.id))!;
  is("the request's own pre-tax total is never written as the amount charged", [first.state, first.amountPaid], ["paid", 0]);
  sessions.get(b.session)!.amount_total = 10_800;
  await markPaid(b.store, b.request.id, sessions.get(b.session)!, now + 1_000);
  is("a later read of the same session completes the amount charged", (await readRequest(b.request.id))?.amountPaid, 10_800);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
