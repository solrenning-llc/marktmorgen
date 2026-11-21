/**
 * Rule 24 (r24 unit 6.2): the creator's "Stripe would not open a checkout"
 * email goes at most once a day. sendEmail's false is refused or unknown alike
 * (the provider may have taken it and the reply been lost), so a send that did
 * not come back true keeps the day's mark: the next refusal that day sends no
 * second email and takes nothing more from the store's emails. The email goes
 * under a stable per-day idempotency key, so even a repeat inside the
 * provider's window is answered without sending again.
 */
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { StripeError } from "@/lib/stripe-account";
import { type Store, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_cotrouble_unknown_stand_in";
process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "cotrouble-owner@example.com";
const DAY = 86_400_000;
type Mode = "ok" | "500" | "throw";
let mode: Mode = "ok";
const posts: { key: string | null; subject: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { subject: string };
    posts.push({ key: headers.get("Idempotency-Key"), subject: body.subject });
    if (mode === "throw") throw new Error("socket hang up after the request was sent");
    if (mode === "500") return json({ message: "internal error" }, 500);
    return json({ id: `email_${posts.length}` });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function freshStore(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "cotrouble", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCoTrbl0001", true);
  await setSubscription(OWNER, { customerId: "cus_CoTrbl0001", subscriptionId: "sub_CoTrbl0001", active: true, period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  const refused = new StripeError(400, "account_invalid", "Your account cannot currently make live charges.");
  const now = Date.UTC(2026, 9, 20, 12);
  const day = "2026-10-20";

  part("A healthy send: once a day, under the day's stable idempotency key");
  let store = await freshStore();
  posts.length = 0;
  mode = "ok";
  is("the first refusal of the day emails the creator", await noteCheckoutTrouble(store, refused, now), "emailed");
  is("one provider request", posts.length, 1);
  is("under the day's stable key", posts[0]?.key, `checkout-trouble:${store.statsId}:${day}`);
  is("a second refusal the same day sends nothing more", [await noteCheckoutTrouble(store, refused, now + 60_000), posts.length], ["counted", 1]);
  is("the next day emails again, under that day's key", [await noteCheckoutTrouble(store, refused, now + DAY), posts[1]?.key],
    ["emailed", `checkout-trouble:${store.statsId}:2026-10-21`]);

  for (const [label, unknown] of [["answered 500 (it may have been taken)", "500"], ["lost in transit (it may have been taken)", "throw"]] as [string, Mode][]) {
    part(`A send ${label} is unknown, so the day's mark is kept`);
    store = await freshStore();
    posts.length = 0;
    mode = unknown;
    is("the unknown send is not called emailed", await noteCheckoutTrouble(store, refused, now), "counted");
    is("one provider request was made", posts.length, 1);
    is("the day's mark is kept", redis.run(["EXISTS", `nl:cotrouble:mail:${store.statsId}:${day}`]), 1);
    mode = "ok";
    is("the next refusal that day sends no second email", [await noteCheckoutTrouble(store, refused, now + 60_000), posts.length], ["counted", 1]);
    is("the next day the creator is told again", await noteCheckoutTrouble(store, refused, now + DAY), "emailed");
  }

  part("A refusal Stripe did not make on purpose sends nothing and claims nothing");
  store = await freshStore();
  posts.length = 0;
  mode = "ok";
  is("a 500 from Stripe is only counted", await noteCheckoutTrouble(store, new StripeError(500, "api_error", "Stripe is down."), now), "counted");
  is("no email and no mark", [posts.length, redis.run(["EXISTS", `nl:cotrouble:mail:${store.statsId}:${day}`])], [0, 0]);
  done();
}
void main();
