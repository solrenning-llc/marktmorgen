/**
 * A refund check kept on the studio page never stands over newer server data
 * (#3291, MEDIUM from Claude 2, issue comment 6727630633, and Claude 6,
 * review 5819828816).
 *
 * The studio keeps what "Check refunds for this payment" said beside the
 * request, in React state. `router.refresh()` (after create, remind, cancel,
 * delete or paid outside) gives the component new rows but keeps that state.
 * A kept check must then give way to a server row that already knows more:
 * a refund made in full since, or a floor ("at least ...") above what the
 * check said. It still stands while the server row is the same unchecked paid
 * row it was made for, or one whose floor it does not fall below.
 *
 * Checked through the real component and its real button: the hook runner of
 * tests/client-hooks.ts, the route's answer from a mocked fetch, and the rows
 * changed the way router.refresh() changes them. Synthetic data only; Redis in
 * memory builds the one request row.
 */
import * as React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest, markPaid, readRequest } from "@/lib/payment-request-store";
import { PaymentRequestsStudio, type RequestRow } from "@/components/payment-requests-studio";
import { store as redis } from "./redis-stub";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "refund-check-stale@example.com";
const INTENT = "pi_RefundCheckStale0001";
const PAID = 48_000;

async function paidStore(): Promise<Store> {
  await claimHandle(OWNER, "refundcheckstale", "Refund Check Stale Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1RefStale0001", true);
  await setSubscription(OWNER, { customerId: "cus_refundcheckstale", subscriptionId: "sub_refundcheckstale", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

/** What the route answers to the one check (lib/payment-request-reply.ts reads it). */
let routeAnswer: unknown = null;
let routeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "/api/store/payment-requests") {
    routeCalls += 1;
    return new Response(JSON.stringify(routeAnswer), { status: 200 });
  }
  return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
}) as typeof fetch;

type Internals = { H: Record<string, unknown> | null };
const internals = (React as unknown as Record<string, Internals>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
/**
 * useRouter reads the app router through useContext, which the test hook runner does not give: the app router is
 * a stand-in that only counts refreshes, and any other context (the layout router) its default value.
 */
let refreshes = 0;
const router = { refresh: () => { refreshes += 1; }, push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {}, forward: () => {} };

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_refund_check_stale_only_a_stand_in";
  const now = Date.now();
  let store = await paidStore();
  const draft = (readDraft({ email: "client@example.com", name: "Dana", lines: [{ text: "Coaching", quantity: 1, amount: "480" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;
  const made = await createRequest(store, draft, now);
  if (!made.ok) throw new Error("the request was not made");
  await markPaid(store, made.request.id, { id: "cs_test_refundcheckstale000000001", amount_total: PAID, payment_intent: INTENT, created: Math.floor(now / 1000) }, now);
  store = (await storeForEmail(OWNER))!;
  const base = (await readRequest(made.request.id))!;
  /** The list's row as the server gives it: paid, its refunds past the list's cap, so the check is offered. */
  const row = (over: Partial<RequestRow>): RequestRow => ({ ...base, state: "paid", refunded: 0, refundsChecked: false, refundsRetry: false, refundsOnDemand: true, link: "https://marktmorgen.com/pay/x", ...over }) as RequestRow;

  /**
   * One page: the studio mounted with the given rows, pressed "Check refunds for this payment" with the route
   * answering `answer`, then given `after` as router.refresh() gives new rows (component state kept).
   */
  async function checkThenRefresh(first: RequestRow, answer: unknown, after: RequestRow): Promise<{ before: string; now: string }> {
    let rows = [first];
    const listeners = new Set<() => void>();
    const Host = () => {
      const H = internals.H!;
      if (!H.useContext) H.useContext = (context: React.Context<unknown>) => (context === (AppRouterContext as React.Context<unknown>) ? router : (context as unknown as { _currentValue: unknown })._currentValue);
      const given = React.useSyncExternalStore((change) => { listeners.add(change); return () => listeners.delete(change); }, () => rows);
      return PaymentRequestsStudio({ rows: given, now, currency: "usd", canSend: false, open: true, closedWhy: "", limits: { open: 10, kept: 50 }, openNow: 0, emails: { used: 0, limit: 100 }, shareWords: "", taxOn: false, prefill: { email: "", name: "", text: "", amount: "" }, dueFirst: "2026-11-08", dueLast: "2026-12-08" });
    };
    const page = await mount(Host, {});
    const button = find(page.tree(), (n) => n.type === "button" && texts(n.props?.children).join("").includes("Check refunds for this payment"))[0];
    if (!button) throw new Error("the check was not offered");
    routeAnswer = answer;
    (button.props!.onClick as () => void)();
    await page.settle();
    const before = texts(page.tree()).join(" ");
    rows = [after];
    listeners.forEach((change) => change());
    await page.settle();
    const shown = texts(page.tree()).join(" ");
    page.unmount();
    return { before, now: shown };
  }

  const none = { ok: true, checked: true, state: "paid", refunded: 0 };
  const hundred = { ok: true, checked: true, state: "paid", refunded: 10_000 };

  part("Control: the check stands while the server row is the one it was made for");
  let page = await checkThenRefresh(row({}), none, row({}));
  is("the route was asked once", routeCalls, 1);
  is("after the check: Paid, none refunded, checked on Stripe", [page.before.includes("Refunds checked on Stripe: none."), page.before.includes("Paid, refunds not checked")], [true, false]);
  is("refreshed with the same row: still the check", [page.now.includes("Refunds checked on Stripe: none."), page.now.includes("Paid, refunds not checked")], [true, false]);
  page = await checkThenRefresh(row({}), hundred, row({ refunded: 10_000 }));
  is("a check of $100 over a server floor of $100: the check stands, said as checked", [page.now.includes("Refunds checked on Stripe: $100 refunded."), page.now.includes("at least $100 refunded"), page.now.includes("Paid, refunds not checked")], [true, false, false]);

  part("A server row that knows more since the check wins over it (MEDIUM, Claude 2 and Claude 6)");
  page = await checkThenRefresh(row({}), none, row({ state: "refunded", refunded: PAID, refundsChecked: true, refundsOnDemand: false }));
  is("refunded in full on Stripe since the check: shown Refunded, $480 refunded", [page.now.includes("Refunded"), page.now.includes("$480 refunded")], [true, true]);
  is("and never Paid with \"Refunds checked on Stripe: none.\"", page.now.includes("Refunds checked on Stripe: none."), false);
  page = await checkThenRefresh(row({}), none, row({ refunded: 10_000 }));
  is("a server floor of $100 above a check of none: \"at least $100 refunded\", not checked", [page.now.includes("at least $100 refunded"), page.now.includes("Paid, refunds not checked")], [true, true]);
  is("and never \"Refunds checked on Stripe: none.\"", page.now.includes("Refunds checked on Stripe: none."), false);
  page = await checkThenRefresh(row({}), hundred, row({ refunded: 20_000 }));
  is("a server floor of $200 above a check of $100: the floor, never the lower check", [page.now.includes("at least $200 refunded"), page.now.includes("Refunds checked on Stripe: $100 refunded.")], [true, false]);
  page = await checkThenRefresh(row({}), hundred, row({ refunded: 10_000, refundsChecked: true, refundsOnDemand: false }));
  is("a server row checked on its own since: the server's words, no older check beside it", [page.now.includes("$100 refunded"), page.now.includes("Refunds checked on Stripe:")], [true, false]);
  is("no refresh was asked by a check", refreshes, 0);

  done();
}

void main();
