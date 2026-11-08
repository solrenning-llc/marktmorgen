/** S bounded cap-branch proof, fixture helpers adapted from author no-pin test; provider returns one-row pages. */
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
import { sendReminders } from "@/lib/billing-reminders";
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "../../../tests/redis-stub";
import { done, is } from "../../../tests/check";
import { paidPeriod } from "../../../tests/billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const emails: string[] = [];
/** Addresses the sender refuses (422), every time. */
const refused = new Set<string>();
/** The platform's subscriptions by status (billing reminders), and each connected account's running memberships. */
const lists: Record<string, Record<string, unknown>[]> = { trialing: [], active: [], past_due: [] };
const running = new Map<string, Record<string, unknown>[]>();

const slice = (all: Record<string, unknown>[], url: URL) => {
  const after = url.searchParams.get("starting_after");
  const from = after ? all.findIndex((s) => s.id === after) + 1 : 0;
  const limit = 1; // Synthetic valid short pages: preserve real page caps, not product constants.
  return { object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length };
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = Array.isArray(body.to) ? body.to[0] : body.to;
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
 redis.clear();
 if(process.env.S_CAP_KIND === "billing"){
  lists.trialing=Array.from({length:51},(_,i)=>trial(`sub_SCapMany${String(i).padStart(4,"0")}`,i===0?7:20));
  refused.add("sub_SCapMany0000@example.com");
  const result=await sendReminders(NOW);
  is("page cap is reached",result.more,true);
  is("refused first subscription did not send",sentTo("sub_SCapMany0000@example.com"),0);
  is("capped walk advances beyond repeated start",redis.run(["GET","nl:remind:after:trialing"]),"sub_SCapMany0049");
 }else{
  const product=await makeStore("s-cap@example.com","scapcard","acct_1SCapCard01");
  running.set("acct_1SCapCard01",Array.from({length:6},(_,i)=>member("scapcard",product,String(i).padStart(4,"0"),i===0||i===4)));
  refused.add("scapcard-0000@example.com");
  await recover();
  is("refused first member did not send",sentTo("scapcard-0000@example.com"),0);
  is("another due member receives one notice",sentTo("scapcard-0004@example.com"),1);
  is("capped card walk advances beyond repeated start",redis.run(["GET","nl:dun:cards:acct_1SCapCard01"]),"sub_scapcardRun0004");
 }
 done();
}
void main();
