/**
 * A payment request is never payable through two checkouts at once (Claude 7, 14 November 2026). Synthetic only: the
 * in-memory Redis and a stand-in for Stripe, through the real lib/payment-requests.ts openRequestCheckout.
 *
 * Its checkout is opened again only after 23 hours (REUSE_SECONDS), but Stripe keeps one open for a day: between the
 * 23rd hour and the 24th a second press opened a second checkout beside the first, never closing it, and a buyer who
 * paid both was charged twice for one request (the second payment recorded nowhere). Now a checkout that Stripe may
 * still hold open is read first, as markPaidOutside does: reused within 23 hours, written down when paid, refused
 * while it is being paid, and closed on Stripe before another opens; if it cannot be closed, nothing opens.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest } from "@/lib/payment-request-store";
import { openRequestCheckout } from "@/lib/payment-requests";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

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
    return answer(sessions.get(id));
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const found = sessions.get(decodeURIComponent(path.slice("/checkout/sessions/".length)));
    return found ? answer(found) : answer({ error: { code: "resource_missing", message: "No such checkout" } }, 404);
  }
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", data: [...sessions.values()], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };
const draftBody = (over: Record<string, unknown> = {}) => ({ email: "client@example.com", name: "Dana", lines: [LINE], note: "Thank you for a good month.", dueDate: "", autoReminders: 2, consent: true, ...over });

async function paidStore(owner: string, handle: string, tier: "creator" | "pro" | "scale" = "creator"): Promise<Store> {
  await claimHandle(owner, handle, "Dana's Studio Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_requests_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const now = Date.now();
  const store = await paidStore("zz@example.com", "zzcoach");
  const draft = (readDraft(draftBody(), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;
  const c = await createRequest(store, draft, now);
  const request = c.ok ? c.request : null!;
  const open = () => [...sessions.values()].filter((s) => s.status === "open").length;

  part("Control: within 23 hours the same checkout is given again");
  const first = await openRequestCheckout(store, request.id, "https://marktmorgen.com", now);
  const reused = await openRequestCheckout(store, request.id, "https://marktmorgen.com", now + 3_600_000);
  is("the same page", reused.ok && first.ok ? reused.url === first.url : reused, true);
  is("one checkout payable", open(), 1);

  part("Between the 23rd and the 24th hour: the first is closed before a second opens");
  const later = await openRequestCheckout(store, request.id, "https://marktmorgen.com", now + 23.5 * 3_600_000);
  is("a page is given", later.ok, true);
  is("only one checkout is payable", open(), 1);

  part("A checkout being paid (complete, not yet paid) opens no second one");
  const c2 = await createRequest(store, (readDraft(draftBody({ email: "second@example.com" }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  const second = c2.ok ? c2.request : null!;
  const firstSecond = await openRequestCheckout(store, second.id, "https://marktmorgen.com", now);
  const pendingId = [...sessions.keys()].find((k) => (sessions.get(k)!.metadata as Record<string, string>).request === second.id && sessions.get(k)!.status === "open")!;
  sessions.set(pendingId, { ...sessions.get(pendingId)!, status: "complete", payment_status: "unpaid" });
  const whilePaying = await openRequestCheckout(store, second.id, "https://marktmorgen.com", now + 23.5 * 3_600_000);
  is("control: the first opened", firstSecond.ok, true);
  is("refused while it is being paid", whilePaying, { ok: false, reason: "busy" });

  part("A malformed 200 reply for the earlier checkout opens no second one: the answer is an error");
  for (const [label, reply] of [
    ["no status", (s: Record<string, unknown>) => { const { status: _drop, ...rest } = s; return rest; }],
    ["an unknown status", (s: Record<string, unknown>) => ({ ...s, status: "processing" })],
    ["another checkout's id", (s: Record<string, unknown>) => ({ ...s, id: "cs_test_someoneelse0000000000000", status: "expired" })],
  ] as const) {
    const cN = await createRequest(store, (readDraft(draftBody({ email: `odd-${label.length}@example.com` }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
    const req = cN.ok ? cN.request : null!;
    const opened = await openRequestCheckout(store, req.id, "https://marktmorgen.com", now);
    const sid = [...sessions.keys()].find((k) => (sessions.get(k)!.metadata as Record<string, string>).request === req.id)!;
    sessions.set(sid, reply(sessions.get(sid)!));
    const before = checkouts.length;
    const again = await openRequestCheckout(store, req.id, "https://marktmorgen.com", now + 23.5 * 3_600_000);
    is(`control: the first opened (${label})`, opened.ok, true);
    is(`no new checkout is opened (${label})`, checkouts.length, before);
    is(`the answer is an error (${label})`, again.ok ? again : again.reason, "error");
  }
  done();
}

void main();
