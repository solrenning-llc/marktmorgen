/**
 * A failed-payment email and a card notice (lib/payment-recovery.ts) that the
 * sender refuses for certain on every run (rule 30; Claude 5's MEDIUM on the
 * -v3 branches, 9 November 2026).
 *
 * Since #3377 a stop before any request is a certain refusal too, and it can
 * come after the store's figure was taken (the dispatch's deadline passed
 * before the fetch), as a 4xx after the request does (played here by a 422).
 * The daily job lets the mark go on a refusal, so each run asked again and
 * took the figure again, with no end. Now each refusal is counted
 * (lib/refused-tries.ts) and the mark is kept at REFUSED_TRIES: N refusals
 * take the figure at most 3 times. Stripe and the sender are a stand-in for
 * `fetch`; no real email is sent.
 */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { allowanceUsed } from "@/lib/store-allowance";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ACCOUNT = "acct_1TestOutcome0001";

/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();
/** Subscriptions whose Stripe change (save the paying card) fails. */
const stripeRefuses = new Set<string>();
const state = { pastDue: [] as Record<string, unknown>[], active: [] as Record<string, unknown>[] };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return answer({ id: `email_${asked.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/subscriptions" && method === "GET") {
    const status = url.searchParams.get("status");
    return answer({ object: "list", data: status === "past_due" ? state.pastDue : status === "active" ? state.active : [], has_more: false });
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "POST") return stripeRefuses.has(sub[1]) ? answer({ error: { message: "synthetic: Stripe is down" } }, 500) : answer({ id: sub[1] });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const askedOf = (email: string) => asked.filter((to) => to === email).length;
const run = () => recoverFailedPayments(Date.now() + 20_000);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_outcome_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER))!;
  const meta = { store: "harbor", product: club.product.id };

  part("A failed-payment email the sender refuses on every daily run");
  state.pastDue = [{
    id: "sub_FailAna00000001",
    status: "past_due",
    metadata: meta,
    customer: { id: "cus_FailAna0000001", email: "ana@example.com" },
    latest_invoice: { id: "in_FailAna00000001", status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/Ana", next_payment_attempt: 0 },
  }];
  senderAnswers.set("ana@example.com", () => answerOf(422));
  const dunMark = () => redis.keys().includes(`nl:dun:${ACCOUNT}:in_FailAna00000001`);
  const before = await allowanceUsed(store, "email");
  for (let day = 0; day < 6; day += 1) await run();
  is("six daily runs ask the sender at most REFUSED_TRIES (3) times", askedOf("ana@example.com"), 3);
  is("and take the store's figure at most 3 times", (await allowanceUsed(store, "email")) - before, 3);
  is("at the third refusal its mark is kept, so no later run takes the figure again", dunMark(), true);
  state.pastDue = [];

  part("A card notice the sender refuses on every daily run");
  const payAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const payDay = new Date(payAt * 1000);
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  state.active = [{
    id: "sub_CardHal00000001",
    status: "active",
    metadata: meta,
    customer: { id: "cus_CardHal0000001", email: "hal@example.com", invoice_settings: { default_payment_method: null } },
    items: { data: [{ current_period_end: payAt }] },
    default_payment_method: { id: "pm_CardHal0000001", type: "card", card: { brand: "visa", last4: "4242", exp_month: lastMonth.getUTCMonth() + 1, exp_year: lastMonth.getUTCFullYear() } },
  }];
  senderAnswers.set("hal@example.com", () => answerOf(422));
  const cardMark = () => redis.keys().includes(`nl:dun:card:${ACCOUNT}:sub_CardHal00000001:pm_CardHal0000001`);
  const cardsBefore = await allowanceUsed(store, "email");
  for (let day = 0; day < 6; day += 1) await run();
  is("six daily runs ask the sender at most 3 times", askedOf("hal@example.com"), 3);
  is("and take the store's figure at most 3 times", (await allowanceUsed(store, "email")) - cardsBefore, 3);
  is("at the third refusal its mark is kept", cardMark(), true);

  done();
}

function answerOf(status: number): Response {
  return new Response(JSON.stringify({ message: status >= 500 ? "internal" : "invalid recipient" }), { status });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
