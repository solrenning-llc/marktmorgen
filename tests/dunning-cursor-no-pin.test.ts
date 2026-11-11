/**
 * A member or creator whose email keeps failing never pins a dunning cursor (rule 24; Claude 2 and Codex S, the two
 * HIGH findings on #3215).
 *
 * The defect this file was written around: the cursor of the billing reminders (lib/billing-reminders.ts, walkList)
 * and the store's card cursor (lib/payment-recovery.ts, noticeCards) stopped before the first subscription whose
 * email did not go, on every run. Stripe lists newest first, so a subscription that fails every time (an address
 * the sender refuses) kept the cursor there for good: every newer creator past due, every newer trial and every
 * newer member with a card about to stop was never read again, and their notice never went. Now:
 *
 *   - a list read to its end is read from the top on the next run, so the one that failed is tried again then,
 *     and every newer one is read too;
 *   - a list longer than one run reads goes on from before the first one not handled, but not when that is where
 *     the run started (nothing moved): then from where the run stopped, so the walk always moves on.
 *
 * Never twice: every one told is told once. Synthetic Stripe and Resend stand-ins only.
 */
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const emails: string[] = [];
/** Addresses the sender refuses (422), every time. */
const refused = new Set<string>();
/** The sender down for everyone (503) while true. */
let senderDown = false;
/** The platform's subscriptions by status (billing reminders), and each connected account's running memberships. */
const lists: Record<string, Record<string, unknown>[]> = { trialing: [], active: [], past_due: [] };
const running = new Map<string, Record<string, unknown>[]>();

const slice = (all: Record<string, unknown>[], url: URL) => {
  const after = url.searchParams.get("starting_after");
  const from = after ? all.findIndex((s) => s.id === after) + 1 : 0;
  const limit = Number(url.searchParams.get("limit")) || 10;
  return { object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length };
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = Array.isArray(body.to) ? body.to[0] : body.to;
    if (senderDown) return answer({ message: "unavailable", name: "internal_server_error" }, 503);
    if (refused.has(to)) return answer({ message: "refused", name: "validation_error" }, 422);
    emails.push(to);
    return answer({ id: `email_${emails.length}` });
  }
  const account = String((init?.headers as Record<string, string> | undefined)?.["Stripe-Account"] ?? "");
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/subscriptions" && method === "GET") {
    if (account) return answer(url.searchParams.get("status") === "active" ? slice(running.get(account) ?? [], url) : { object: "list", data: [], has_more: false });
    return answer(slice(lists[url.searchParams.get("status") ?? ""] ?? [], url));
  }
  if (/^\/subscriptions\/sub_\w+$/.test(path) && method === "POST") return answer({ id: path.split("/").pop() });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const sentTo = (address: string) => emails.filter((to) => to === address).length;
const PRICE = { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } };
function trial(id: string, daysLeft: number): Record<string, unknown> {
  return {
    id, status: "trialing", created: NOW - 6 * DAY, trial_end: NOW + daysLeft * DAY,
    customer: { email: `${id}@example.com` },
    items: { data: [{ current_period_start: NOW - 6 * DAY, current_period_end: NOW + daysLeft * DAY, price: PRICE }] },
  };
}
function failing(id: string): Record<string, unknown> {
  return {
    id, status: "past_due", created: NOW - 90 * DAY, trial_end: NOW - 76 * DAY,
    customer: { email: `${id}@example.com` },
    items: { data: [{ current_period_start: NOW - 2 * DAY, current_period_end: NOW + 28 * DAY, price: PRICE }] },
    latest_invoice: { id: `in_${id.slice(4)}inv`, status: "open", amount_due: 2900, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, next_payment_attempt: NOW + 3 * DAY },
  };
}

async function makeStore(owner: string, handle: string, account: string): Promise<string> {
  const made = await claimHandle(owner, handle, `Store ${handle}`, "");
  if (!made.ok) throw new Error(`no store ${handle}`);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${handle}Own01`, subscriptionId: `sub_${handle}Own01`, active: true, tier: "pro", period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  await setDunning(owner, { reminders: 1, cardNotice: true });
  await storeForEmail(owner);
  return club.product.id;
}
/** A running membership of `handle`; its card stops before the payment five days away when `lapses`. */
function member(handle: string, product: string, id: string, lapses: boolean): Record<string, unknown> {
  const payAt = Math.floor(Date.now() / 1000) + 5 * DAY;
  const payDay = new Date(payAt * 1000);
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  return {
    id: `sub_${handle}Run${id}`,
    status: "active",
    metadata: { store: handle, product },
    customer: { id: `cus_${handle}Run${id}`, email: `${handle}-${id}@example.com`, invoice_settings: { default_payment_method: null } },
    items: { data: [{ current_period_end: payAt }] },
    default_payment_method: { id: `pm_${handle}Card${id}`, type: "card", card: { brand: "visa", last4: "4242", exp_month: lapses ? lastMonth.getUTCMonth() + 1 : 12, exp_year: lapses ? lastMonth.getUTCFullYear() : 2099 } },
  };
}
const recover = () => recoverFailedPayments(Date.now() + 20_000);

async function main(): Promise<void> {
  part("Failed-payment notices: a creator the sender always refuses, then a newer creator past due");
  redis.clear();
  lists.past_due = [failing("sub_NoPinAlpha01"), failing("sub_NoPinRefused1"), failing("sub_NoPinCharlie1")];
  refused.add("sub_NoPinRefused1@example.com");
  await sendFailedPlanNotices();
  is("the two who can be told are told", [sentTo("sub_NoPinAlpha01@example.com"), sentTo("sub_NoPinCharlie1@example.com")], [1, 1]);
  lists.past_due.unshift(failing("sub_NoPinNewcomer"));
  for (let i = 0; i < 3; i += 1) await sendFailedPlanNotices();
  is("the newer creator past due is told", sentTo("sub_NoPinNewcomer@example.com"), 1);
  refused.clear();
  await sendFailedPlanNotices();
  is("the refused one is told once the sender takes it", sentTo("sub_NoPinRefused1@example.com"), 1);
  await sendFailedPlanNotices();
  is("never twice for any", ["sub_NoPinAlpha01", "sub_NoPinRefused1", "sub_NoPinCharlie1", "sub_NoPinNewcomer"].map((id) => sentTo(`${id}@example.com`)), [1, 1, 1, 1]);
  lists.past_due = [];

  part("Trial reminders: more trials than one run reads, one the sender always refuses near the top");
  redis.clear();
  lists.trialing = Array.from({ length: 5_050 }, (_, i) => trial(`sub_NoPinMany${String(i).padStart(4, "0")}`, i === 10 || i === 5_020 ? 7 : 20));
  refused.add("sub_NoPinMany0010@example.com");
  for (let i = 0; i < 4; i += 1) await sendReminders(NOW);
  is("the walk moves on and reaches the trial past the first fifty pages", sentTo("sub_NoPinMany5020@example.com"), 1);
  is("the refused one is never counted as told", sentTo("sub_NoPinMany0010@example.com"), 0);
  refused.clear();
  lists.trialing = [];

  part("Card notices: a member the sender always refuses, then a newer member whose card stops");
  redis.clear();
  {
    const product = await makeStore("nopin-cards@example.com", "nopincard", "acct_1TestNoPinCard1");
    running.set("acct_1TestNoPinCard1", [member("nopincard", product, "0000", false), member("nopincard", product, "0001", true), member("nopincard", product, "0002", true)]);
    refused.add("nopincard-0001@example.com");
    await recover();
    is("the member who can be told is told", sentTo("nopincard-0002@example.com"), 1);
    running.get("acct_1TestNoPinCard1")!.unshift(member("nopincard", product, "0009", true));
    for (let i = 0; i < 4; i += 1) await recover();
    is("the newer member whose card stops is told", sentTo("nopincard-0009@example.com"), 1);
    refused.clear();
    await recover();
    await recover();
    is("the refused one is told once the sender takes it, and nobody twice", ["0001", "0002", "0009"].map((id) => sentTo(`nopincard-${id}@example.com`)), [1, 1, 1]);
  }

  part("Card notices: more members than one run reads, one the sender always refuses near the top");
  redis.clear();
  {
    const product = await makeStore("nopin-many@example.com", "nopinmany", "acct_1TestNoPinMany1");
    running.set("acct_1TestNoPinMany1", Array.from({ length: 600 }, (_, i) => member("nopinmany", product, String(i).padStart(4, "0"), i === 10 || i === 550)));
    refused.add("nopinmany-0010@example.com");
    for (let i = 0; i < 4; i += 1) await recover();
    is("the walk moves on and reaches the member past the first five pages", sentTo("nopinmany-0550@example.com"), 1);
    is("the refused one is never counted as told", sentTo("nopinmany-0010@example.com"), 0);
  }

  part("Card notices: a sender outage on a run that starts at the first member due never skips the others (Claude 1 on #3215)");
  redis.clear();
  {
    const product = await makeStore("nopin-down@example.com", "nopindown", "acct_1TestNoPinDown1");
    running.set("acct_1TestNoPinDown1", Array.from({ length: 600 }, (_, i) => member("nopindown", product, String(i).padStart(4, "0"), i % 10 === 0)));
    senderDown = true;
    await recover();
    senderDown = false;
    await recover();
    const early = Array.from({ length: 49 }, (_, i) => `nopindown-${String((i + 1) * 10).padStart(4, "0")}@example.com`);
    is("the next run tells every member due in the pages the outage read, past the first one", early.filter((to) => sentTo(to) === 1).length, 49);
  }

  part("Trial reminders: a sender outage on a run that starts at the first trial due never skips the others (Claude 1 on #3215)");
  redis.clear();
  {
    lists.trialing = Array.from({ length: 5_050 }, (_, i) => trial(`sub_NoPinDown${String(i).padStart(4, "0")}`, i % 100 === 0 ? 7 : 20));
    senderDown = true;
    await sendReminders(NOW);
    senderDown = false;
    await sendReminders(NOW);
    const early = Array.from({ length: 49 }, (_, i) => `sub_NoPinDown${String((i + 1) * 100).padStart(4, "0")}@example.com`);
    is("the next run tells every trial due in the pages the outage read, past the first one", early.filter((to) => sentTo(to) === 1).length, 49);
    lists.trialing = [];
  }

  done();
}

void main();
