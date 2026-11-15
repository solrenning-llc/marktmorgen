/**
* Issue #4777 (Codex T report of 13/11/2026 09:43, reproduced by Claude 2): a stored payment request line that can no longer be read (quantity written back as the
 * string "2") is dropped by parseRequest while the stored total is kept, so the page stays payable and the checkout is
 * built from fewer lines than the total says.
 *
 * Synthetic: in-memory Redis, stand-in Stripe, no email sent.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest, readRequest } from "@/lib/payment-request-store";
import { openRequestCheckout } from "@/lib/payment-requests";
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
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_request_lines_stand_in";
  process.env.RESEND_API_KEY = "re_test_payment_request_lines_stand_in";
  const now = Date.now();
  const store = await paidStore("requests-l@example.com", "danacoachl");
  const made = await createRequest(store, (readDraft(draft({ lines: [{ text: "Coaching session", quantity: 1, amount: "100" }, { text: "Second session", quantity: 2, amount: "10" }] }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  if (!made.ok) throw new Error("no request");
  const key = `nl:payreq:r:${made.request.id}`;
  const raw = JSON.parse(redis.run(["GET", key]) as string);
  is("control: stored total and lines agree", [raw.total, raw.lines.reduce((n: number, l: { cents: number; quantity: number }) => n + l.cents * l.quantity, 0)], [12000, 12000]);
  raw.lines[1].quantity = "2";
  redis.run(["SET", key, JSON.stringify(raw)]);
  part("A stored line that cannot be read");
  const read = (await readRequest(made.request.id).catch((e) => `threw ${e.constructor.name}`)) as { total: number; lines: { cents: number; quantity: number }[] } | string | null;
  const lines = typeof read === "object" && read ? read.lines.reduce((n, l) => n + l.cents * l.quantity, 0) : read;
  is("the request is not readable as payable, or its lines still add up to its total", typeof read === "object" && read ? lines === read.total : true, true);
  const opened = await openRequestCheckout(store, made.request.id, "https://marktmorgen.com", now);
  is("no checkout is opened for lines that do not add up to the total", opened.ok, false);
  is("no checkout was posted to Stripe", sessions.size, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
