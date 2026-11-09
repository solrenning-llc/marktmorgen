/**
 * The failed-payment email and the card notice (lib/payment-recovery.ts)
 * under a sender whose answer is not known (rule 30, a sibling of 283
 * [HG2] unit 1's sendEmailOutcome).
 *
 * A timeout, a server error or a network error after the request may have
 * reached the sender can mean the email went. The once-per-invoice mark
 * (`nl:dun:*`) and the once-per-card mark (`nl:dun:card:*`) are then kept,
 * so the daily job never writes to the member twice and never takes the
 * store's figure again for the same email; only a certain refusal lets the
 * mark go. Before this, an unknown answer let the mark go: the next day's
 * run asked again, which the SES once-mark held back only for 24 hours, and
 * each run took one more email from the store's figure. Stripe and the
 * sender are played by a stand-in for `fetch`; no real email is sent.
 * Checked, for each of the two emails:
 *
 *   - a 500 from the sender: asked once over two runs, its mark kept, the
 *     store's figure taken once;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): the mark is let go and the next run asks
 *     again (control: unchanged behavior);
 *   - a plain yes: sent once, counted (control);
 *   - an error before the send (Stripe's change for the failed payment):
 *     nothing was asked of the sender, so the mark is let go and the next
 *     run sends it (control: unchanged behavior).
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

  part("Failed payments: one email per invoice");
  const failing = (n: string, email: string) => ({
    id: `sub_Fail${n}00000001`,
    status: "past_due",
    metadata: meta,
    customer: { id: `cus_Fail${n}0000001`, email },
    latest_invoice: { id: `in_Fail${n}00000001`, status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: `https://invoice.stripe.com/i/${n}`, next_payment_attempt: 0 },
  });
  const failed: [string, string][] = [["Ana", "ana@example.com"], ["Ben", "ben@example.com"], ["Cid", "cid@example.com"], ["Dee", "dee@example.com"], ["Eve", "eve@example.com"]];
  state.pastDue = failed.map(([n, email]) => failing(n, email));
  senderAnswers.set("ana@example.com", () => answerOf(500));
  senderAnswers.set("ben@example.com", () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set("cid@example.com", () => answerOf(422));
  stripeRefuses.add("sub_FailEve00000001");
  const dunMark = (n: string) => redis.keys().includes(`nl:dun:${ACCOUNT}:in_Fail${n}00000001`);

  const usedBefore = await allowanceUsed(store, "email");
  await run();
  is("each of the four reached the sender once; the one whose Stripe change failed did not", failed.map(([, email]) => askedOf(email)), [1, 1, 1, 1, 0]);
  is("each request was taken from the store's figure first, the uncertain ones included", (await allowanceUsed(store, "email")) - usedBefore, 4);
  is("a 500: its mark is kept", dunMark("Ana"), true);
  is("a thrown request: its mark is kept", dunMark("Ben"), true);
  is("a certain refusal (422): its mark is let go", dunMark("Cid"), false);
  is("the plain yes: its mark is kept", dunMark("Dee"), true);
  is("an error before the send: its mark is let go", dunMark("Eve"), false);

  // The mark is what keeps the next run from writing again. The synthetic sender here is the Resend floor, whose own
  // record holds a repeated identical request back; the SES once-mark does that only for 24 hours, after which a mark
  // let go is a second email to the member. So the marks above are the proof; the asks below are the controls.
  senderAnswers.clear();
  stripeRefuses.clear();
  await run();
  is("the next run asks again only the certain refusal and the one never sent", failed.map(([, email]) => askedOf(email)), [1, 1, 2, 1, 1]);
  is("and takes the store's figure only for those two", (await allowanceUsed(store, "email")) - usedBefore, 6);
  await run();
  is("a third run asks nobody again", asked.length, 6);
  state.pastDue = [];

  part("Card notices: one per membership and card");
  const payAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const payDay = new Date(payAt * 1000);
  // A card printed with last month: it stops working before payAt.
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  const running = (n: string, email: string) => ({
    id: `sub_Card${n}00000001`,
    status: "active",
    metadata: meta,
    customer: { id: `cus_Card${n}0000001`, email, invoice_settings: { default_payment_method: null } },
    items: { data: [{ current_period_end: payAt }] },
    default_payment_method: { id: `pm_Card${n}0000001`, type: "card", card: { brand: "visa", last4: "4242", exp_month: lastMonth.getUTCMonth() + 1, exp_year: lastMonth.getUTCFullYear() } },
  });
  const cards: [string, string][] = [["Fay", "fay@example.com"], ["Gus", "gus@example.com"], ["Hal", "hal@example.com"], ["Ivy", "ivy@example.com"]];
  state.active = cards.map(([n, email]) => running(n, email));
  senderAnswers.set("fay@example.com", () => answerOf(500));
  senderAnswers.set("gus@example.com", () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set("hal@example.com", () => answerOf(422));
  const cardMark = (n: string) => redis.keys().includes(`nl:dun:card:${ACCOUNT}:sub_Card${n}00000001:pm_Card${n}0000001`);

  const cardsBefore = await allowanceUsed(store, "email");
  await run();
  is("each card notice reached the sender once", cards.map(([, email]) => askedOf(email)), [1, 1, 1, 1]);
  is("each was taken from the store's figure first", (await allowanceUsed(store, "email")) - cardsBefore, 4);
  is("a 500: its mark is kept", cardMark("Fay"), true);
  is("a thrown request: its mark is kept", cardMark("Gus"), true);
  is("a certain refusal (422): its mark is let go", cardMark("Hal"), false);
  is("the plain yes: its mark is kept", cardMark("Ivy"), true);

  // A card notice carries a new link each time, so the sender's own record does not hold a second one back.
  senderAnswers.clear();
  await run();
  is("the next run asks again only the certain refusal", cards.map(([, email]) => askedOf(email)), [1, 1, 2, 1]);
  is("and takes the store's figure only for it", (await allowanceUsed(store, "email")) - cardsBefore, 5);

  done();
}

function answerOf(status: number): Response {
  return new Response(JSON.stringify({ message: status >= 500 ? "internal" : "invalid recipient" }), { status });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
