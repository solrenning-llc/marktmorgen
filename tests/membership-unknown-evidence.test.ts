/**
 * A membership read in a shape Stripe never sends is unknown, never ended
 * (CX-123 rule 24; rule 30 for the sibling doors). Audit of the buyer
 * membership doors, 11 November 2026.
 *
 * Every door a membership opens asks Stripe for the checkout with its
 * subscription expanded, then asked lib/membership-access.ts whether it is
 * live. Before this, three readings of an answer Stripe could not have given
 * shut a paying member out as if the membership had ended:
 *
 *   - the subscription not expanded (still its id), or null, on a paid
 *     subscription checkout: the course door kept "ended" for ten minutes
 *     (lib/learn.ts), the community said a definite "no" (lib/community-access.ts)
 *     and the list of purchases showed it ended, with the way to renew
 *     (lib/buyer-orders.ts);
 *   - a subscription with no readable status (missing, a number): the same,
 *     and the thanks-page download said "ended" (lib/store-checkout.ts).
 *
 * Now each is unknown: the course door keeps nothing and opens on the next
 * good read, the community says it could not ask, and the list and the
 * download report an error to try again. A real end (canceled, unpaid) still
 * closes, and an active membership still opens.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { isLiveSub, memberState } from "@/lib/membership-access";
import { paidCourses } from "@/lib/learn";
import { paidForAny } from "@/lib/community-access";
import { purchasesFor } from "@/lib/buyer-orders";
import { readOrder } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_membership_unknown_only";

const OWNER = "coach@example.com";
const ACCOUNT = "acct_1TestUnknown01";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const sessions: Record<string, Record<string, unknown>[]> = {};
const oneSession: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return list(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return oneSession[one[1]] ? answer(oneSession[one[1]]) : answer({ error: { message: "no such" } }, 404);
  return list([]);
}) as typeof fetch;

const subOf = (id: string, status: unknown) => ({ id: `sub_${id.slice(8)}`, object: "subscription", status, latest_invoice: null, items: { data: [{ current_period_end: NOW + 10 * DAY }] } });

const member = (id: string, product: string, subscription: unknown, email: string) => ({
  id,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  created: NOW - 3600,
  customer: "cus_TestMember001",
  customer_details: { email },
  amount_total: 1500,
  metadata: { store: "coachclub", product },
  payment_intent: null,
  subscription,
});

const outcome = (p: Promise<unknown>) => p.then((value) => ({ answered: value }), (error: unknown) => ({ unknown: error instanceof Error }));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "coachclub", "Coach Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
  const course = await addProduct(OWNER, "Running Club", "", "15", { interval: "month" } as Parameters<typeof addProduct>[4]);
  const notes = await addProduct(OWNER, "Training Notes", "", "9", { interval: "month" } as Parameters<typeof addProduct>[4]);
  if (!course.ok || !notes.ok) throw new Error("no products");
  await setProductCourse(OWNER, course.product.id, { id: "d".repeat(32), lessons: 4 });
  await setProductLink(OWNER, notes.product.id, "https://example.com/training-notes");
  const store = (await storeForEmail(OWNER))!;
  const club = course.product.id;
  const ids = new Set([club]);

  part("The rule: a subscription object with no readable status is unknown, not ended");
  is("no status", (() => { try { return memberState({ id: "sub_TestNoStatus1" }); } catch { return "unknown"; } })(), "unknown");
  is("a numeric status", (() => { try { return isLiveSub({ id: "sub_TestNumber01", status: 3 }); } catch { return "unknown"; } })(), "unknown");
  is("canceled is still ended", isLiveSub({ status: "canceled" }), false);
  is("active is still open", isLiveSub({ status: "active" }), true);

  const odd: [string, (id: string) => unknown][] = [
    ["not expanded (its id)", (id) => `sub_${id.slice(8)}`],
    ["null on a paid subscription checkout", () => null],
    ["no status", (id) => subOf(id, undefined)],
    ["a numeric status", (id) => subOf(id, 7)],
  ];
  let n = 0;
  for (const [what, shape] of odd) {
    n += 1;
    part(`A subscription ${what}`);
    const email = `odd${n}@example.com`;
    const cs = `cs_test_odd${n}00000000001`;
    sessions[email] = [member(cs, club, shape(cs), email)];
    is("the community says it could not ask, not \"no\"", await outcome(paidForAny(store, email, ids)), { unknown: true });
    is("the course does not open on it", [...(await paidCourses(store, email)).keys()], []);
    // Stripe answers properly a moment later: the course opens at once, nothing "ended" was kept.
    sessions[email] = [member(cs, club, subOf(cs, "active"), email)];
    is("and opens on the next good read, with no \"ended\" kept for ten minutes", [...(await paidCourses(store, email)).keys()], [club]);

    const listed = `odd${n}list@example.com`;
    const lcs = `cs_test_odd${n}0000000lst1`;
    sessions[listed] = [member(lcs, notes.product.id, shape(lcs), listed)];
    const shown = await outcome(purchasesFor(store, listed).then((rows) => rows.map((p) => ({ member: p.member, ended: p.ended }))));
    is("the list of purchases does not show it ended with the way to renew", shown, { unknown: true });

    const dl = `cs_test_odd${n}00000000dl1`;
    oneSession[dl] = member(dl, notes.product.id, shape(dl), `odd${n}dl@example.com`);
    const order = await readOrder(store, dl);
    // Read by its id alone (not expanded) it is asked of Stripe, which the stand-in answers with nothing readable.
    is("the download does not say ended", order.state === "paid" ? order.membership : order.state, "error");
  }

  part("A real end still closes every door, an active one still opens");
  sessions["end@example.com"] = [member("cs_test_end00000000001", club, subOf("cs_test_end00000000001", "canceled"), "end@example.com")];
  is("the community, canceled", await paidForAny(store, "end@example.com", ids), false);
  is("the course, canceled", [...(await paidCourses(store, "end@example.com")).keys()], []);
  sessions["live@example.com"] = [member("cs_test_live0000000001", club, subOf("cs_test_live0000000001", "active"), "live@example.com")];
  is("the community, active", await paidForAny(store, "live@example.com", ids), true);
  is("the course, active", [...(await paidCourses(store, "live@example.com")).keys()], [club]);

  done();
}

void main();
