/**
 * A payment request is never payable through two checkouts at once, even when the 60-second hold
 * (holdForCheckout) runs out while one press is still talking to Stripe (review of #4532, Claude 1 cloud R,
 * MEDIUM).
 *
 * In the 24th hour a press reads the old checkout, closes it on Stripe and opens a new one: up to a GET, an
 * expire, a POST and a retry, past the hold. A second press then takes the hold, reads the same old checkout
 * (now expired), opens one and writes it down. The first press used to write its own over it, checking only
 * that the request was still open: two payable checkouts, so a buyer who paid both was charged twice. Now a
 * press keeps its checkout only when the request still names the checkout it read; otherwise it closes the one
 * it opened. Marking the request paid outside Stripe follows the same rule: it is refused when a checkout was
 * opened beside the one it closed, which stays payable.
 *
 * Synthetic only: the Redis stand-in and a Stripe stand-in whose expire lets the hold run out.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest, readRequest } from "@/lib/payment-request-store";
import { markPaidOutside, openRequestCheckout } from "@/lib/payment-requests";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis, advance } from "./redis-stub";

let onExpire: (() => Promise<void>) | null = null;
const checkouts: URLSearchParams[] = [];
const sessions = new Map<string, Record<string, unknown>>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    checkouts.push(body);
    const id = `cs_test_${String(checkouts.length).padStart(24, "r")}`;
    const meta: Record<string, string> = {};
    for (const [key, value] of body) {
      const m = /^metadata\[(.+)\]$/.exec(key);
      if (m) meta[m[1]] = value;
    }
    sessions.set(id, { id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, metadata: meta, created: Math.floor(Date.now() / 1000) });
    return answer(sessions.get(id));
  }
  if (path.endsWith("/expire") && method === "POST") {
    const id = decodeURIComponent(path.slice("/checkout/sessions/".length, -"/expire".length));
    const found = sessions.get(id);
    if (!found) return answer({ error: { code: "resource_missing", message: "No such checkout" } }, 404);
    if (found.status === "open") sessions.set(id, { ...found, status: "expired" });
    // A slow Stripe: the 60-second hold runs out while this expire is answered, and a second press comes in.
    if (onExpire) {
      const run = onExpire;
      onExpire = null;
      advance(61_000);
      await run();
    }
    return answer(sessions.get(id));
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const found = sessions.get(decodeURIComponent(path.slice("/checkout/sessions/".length)));
    return found ? answer(found) : answer({ error: { code: "resource_missing", message: "No such checkout" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };
const draftBody = () => ({ email: "client@example.com", name: "Dana", lines: [LINE], note: "", dueDate: "", autoReminders: 2, consent: true });

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Dana's Studio Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function newRequest(store: Store, now: number): Promise<string> {
  const read = readDraft(draftBody(), "usd", now);
  if (!read.ok) throw new Error("draft did not read");
  const made = await createRequest(store, read.draft, now);
  if (!made.ok) throw new Error(made.message);
  return made.request.id;
}

const payable = (requestId: string) => [...sessions.values()].filter((s) => s.status === "open" && (s.metadata as Record<string, string>).request === requestId).map((s) => String(s.id));

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_requests_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const now = Date.now();
  const store = await paidStore("lapse@example.com", "lapsecoach");
  const later = now + 23.5 * 3_600_000;

  part("The hold runs out while a 24th-hour press closes the old checkout; a second press opens beside it");
  {
    const id = await newRequest(store, now);
    const first = await openRequestCheckout(store, id, "https://marktmorgen.com", now);
    is("control: the first checkout opened", first.ok, true);
    let second: Awaited<ReturnType<typeof openRequestCheckout>> | null = null;
    onExpire = async () => {
      second = await openRequestCheckout(store, id, "https://marktmorgen.com", later + 61_000);
    };
    const firstPress = await openRequestCheckout(store, id, "https://marktmorgen.com", later);
    is("control: the second press ran inside the first", second !== null, true);
    is("a page is given to one of the two presses", firstPress.ok || (second as { ok: boolean } | null)?.ok === true, true);
    const open = payable(id);
    is("only one checkout is payable after both presses", open.length, 1);
    is("and it is the one the request names", (await readRequest(id))?.session, open[0]);
  }

  part("A checkout opened beside the one a mark closed keeps the request from being marked paid outside Stripe");
  {
    const id = await newRequest(store, now);
    const first = await openRequestCheckout(store, id, "https://marktmorgen.com", now);
    is("control: the first checkout opened", first.ok, true);
    let opened: Awaited<ReturnType<typeof openRequestCheckout>> | null = null;
    onExpire = async () => {
      opened = await openRequestCheckout(store, id, "https://marktmorgen.com", later + 61_000);
    };
    const marked = await markPaidOutside(store, id, { method: "transfer", note: "Ref 1", paidAt: later }, later);
    is("control: a press opened a checkout while the mark was closing the old one", (opened as { ok: boolean } | null)?.ok, true);
    is("the mark is refused, never written over a checkout that can still be paid", marked.ok ? "marked" : marked.reason, "busy");
    is("the request is still open, so the payable checkout pays it once", (await readRequest(id))?.state, "open");
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
