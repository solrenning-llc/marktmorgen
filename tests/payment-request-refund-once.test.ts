/**
 * A payment request's refunds (lib/payment-requests.ts, refreshRefunds) are
 * added up once each, by the refund's own id: a refund that comes back again
 * on the next page of the list is the same refund, never a second one, so a
 * part refunded is never written as refunded in full (issue #4433, Codex X8).
 * A row without an id is not readable evidence: nothing is written from that
 * read. Two different refunds still add up, as before.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest, listRequests, readRequest } from "@/lib/payment-request-store";
import { openRequestCheckout, refreshRefunds, settleFromReturn } from "@/lib/payment-requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const sessions = new Map<string, Record<string, unknown>>();
let pages: Record<string, unknown>[][] = [[]];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const id = `cs_test_${String(sessions.size + 1).padStart(24, "q")}`;
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
  if (path === "/refunds") {
    // The page after `starting_after` is the next one; the last page says there is no more.
    const n = url.searchParams.get("starting_after") ? Math.min(1, pages.length - 1) : 0;
    return answer({ object: "list", data: pages[n], has_more: n < pages.length - 1 });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function paidRequest(owner: string, handle: string, intent: string, now: number): Promise<{ store: Store; id: string }> {
  await claimHandle(owner, handle, "Refund Once Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const draft = readDraft({ email: "client@example.com", name: "Dana", lines: [{ text: "Coaching", quantity: 1, amount: "80" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now);
  if (!draft.ok) throw new Error("fixture draft");
  const made = await createRequest(store, draft.draft, now);
  if (!made.ok) throw new Error("fixture request");
  const opened = await openRequestCheckout(store, made.request.id, "https://marktmorgen.com", now);
  if (!opened.ok) throw new Error("fixture checkout");
  const sessionId = opened.url.split("/").at(-1)!;
  sessions.set(sessionId, { ...sessions.get(sessionId)!, status: "complete", payment_status: "paid", amount_total: 8000, currency: "usd", payment_intent: intent, created: Math.floor(now / 1000) });
  const paid = await settleFromReturn(store, (await readRequest(made.request.id))!, sessionId, now);
  if (paid.state !== "paid") throw new Error("fixture not paid");
  return { store, id: made.request.id };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_request_refund_once";
  const now = Date.now();

  part("The same refund on two pages");
  const one = await paidRequest("refund-once@example.com", "refundonce", "pi_K18Paid000001", now);
  const row = { id: "re_same", payment_intent: "pi_K18Paid000001", status: "succeeded", amount: 4000 };
  pages = [[row], [row]];
  const shown = (await refreshRefunds(one.store, (await listRequests(one.store, now))!, now)).find((r) => r.id === one.id)!;
  is("counted once: still paid, $40 refunded", [shown.state, shown.refunded], ["paid", 4000]);
  is("kept state is paid", (await readRequest(one.id))?.state, "paid");

  part("A row without an id is not evidence");
  const two = await paidRequest("refund-noid@example.com", "refundnoid", "pi_K18Paid000002", now);
  pages = [[{ payment_intent: "pi_K18Paid000002", status: "succeeded", amount: 8000 }]];
  await refreshRefunds(two.store, (await listRequests(two.store, now))!, now);
  is("nothing written from that read", [(await readRequest(two.id))?.state, (await readRequest(two.id))?.refunded], ["paid", 0]);

  part("Control: two different refunds still add up");
  pages = [[{ id: "re_a", payment_intent: "pi_K18Paid000002", status: "succeeded", amount: 3000 }], [{ id: "re_b", payment_intent: "pi_K18Paid000002", status: "succeeded", amount: 5000 }]];
  await refreshRefunds(two.store, (await listRequests(two.store, now))!, now);
  is("refunded in full", [(await readRequest(two.id))?.state, (await readRequest(two.id))?.refunded], ["refunded", 8000]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
