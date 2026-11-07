/**
 * The come-back offer (lib/winback-send.ts) when something fails before the
 * sender is asked (rule 30, pre-review W1 on claude5/email-outcome-siblings).
 *
 * Nothing was asked of the sender, so nothing can have gone: the marks this
 * run took (the membership's 90-day mark and, once taken, the 180-day mark)
 * and the link it made are let go, and the next run, inside the same window,
 * sends the offer once. Once the send has started, nothing changes: a count
 * that could not be written after a send that went keeps the marks. Stripe,
 * Redis and the sender are stand-ins; no real email is sent. Checked:
 *
 *   - Stripe down on /customers in one run and back in the next: nothing
 *     asked in the first run, the membership's mark let go, one email in the
 *     second (W1);
 *   - the link's write failing after the 180-day mark was taken: both marks
 *     and the link let go, one email in the next run;
 *   - the count failing after a send that went: the marks are kept, never a
 *     second email (control: once the send started, unchanged);
 *   - a plain yes: sent once (control).
 */
import {
  addProduct,
  claimHandle,
  ensureListId,
  ensureStatsId,
  setProductLink,
  setStripeAccount,
  setSubscription,
  setWinBack,
  storeForEmail,
} from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendWinBacks, winbacksSent } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const ACCOUNT = "acct_1TestBefore01";

const asked: string[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();
/** Customers whose read Stripe fails, while listed here. */
const stripeDown = new Set<string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    return new Response(JSON.stringify({ id: `email_${asked.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) {
    if (stripeDown.has(customer[1])) return new Response(JSON.stringify({ error: { type: "api_error", message: "unavailable" } }), { status: 503 });
    return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  }
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

/** Redis failing on one kind of write, once per listed key fragment, while listed. */
const failWrites = new Map<string, "SET-link" | "INCR">();
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  for (const [name, key] of commands) {
    for (const [fragment, kind] of failWrites) {
      if (kind === "SET-link" && name === "SET" && String(key).startsWith("nl:wb:link:") && fragment === "next-link") {
        failWrites.delete(fragment);
        throw new TypeError("fetch failed: the connection to Redis was reset");
      }
      if (kind === "INCR" && name === "INCR" && String(key).startsWith("nl:wb:n:") && fragment === "next-count") {
        failWrites.delete(fragment);
        throw new TypeError("fetch failed: the connection to Redis was reset");
      }
    }
  }
  return realPipeline(commands);
};

function ended(id: string, customer: string, meta: Record<string, string>) {
  events.push({
    id: `evt_${id}`,
    type: "customer.subscription.deleted",
    created: nowS - 8 * DAY,
    data: { object: { id, customer, ended_at: nowS - 8 * DAY, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
  });
}

const askedOf = (email: string) => asked.filter((to) => to === email).length;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_before_send_winback_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 1, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = await storeForEmail(OWNER);
  if (!store?.listId || !store.statsId) throw new Error("no list");

  const people: [string, string, string][] = [
    ["sub_Ola000000001", "cus_Ola0000001", "ola@example.com"],
    ["sub_Una000000001", "cus_Una0000001", "una@example.com"],
    ["sub_Tom000000001", "cus_Tom0000001", "tom@example.com"],
    ["sub_Rex000000001", "cus_Rex0000001", "rex@example.com"],
  ];
  for (const [sub, customer, email] of people) {
    customers.set(customer, email);
    await upsertContact(store.listId, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    ended(sub, customer, { store: "harbor", product: club.product.id });
  }
  const membershipMark = (sub: string) => redis.keys().includes(`nl:wb:${ACCOUNT}:${sub}`);
  const onceMarks = () => redis.keys().filter((k) => k.startsWith(`nl:wb:once:${store.statsId}:`)).length;
  const links = () => redis.keys().filter((k) => k.startsWith("nl:wb:link:")).length;

  part("The first run: Stripe down for Una, the link's write fails for Tom, the count fails for Rex");
  stripeDown.add("cus_Una0000001");
  // Each failure is armed when that person's customer is read, so it hits the next write of its kind, theirs.
  const order: string[] = [];
  let arm = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const m = new URL(String(input)).pathname.match(/\/customers\/(cus_\w+)$/);
    if (m && arm) {
      order.push(m[1]);
      if (m[1] === "cus_Tom0000001") failWrites.set("next-link", "SET-link");
      if (m[1] === "cus_Rex0000001") failWrites.set("next-count", "INCR");
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await sendWinBacks(Date.now() + 30_000, now);
  is("all four memberships were looked at", order.length, 4);
  is("Stripe down: Una was not asked for", askedOf("una@example.com"), 0);
  is("the link's write failed: Tom was not asked for", askedOf("tom@example.com"), 0);
  is("Rex's email went before the count failed", askedOf("rex@example.com"), 1);
  is("Ola, a plain yes, was asked for once", askedOf("ola@example.com"), 1);
  redis.advance(2_000); // a mark let go lapses within a second (lib/claim-mark.ts)
  is("an error before any send lets Una's membership mark go", membershipMark("sub_Una000000001"), false);
  is("an error before any send lets Tom's membership mark go", membershipMark("sub_Tom000000001"), false);
  is("once the send started, Rex's membership mark is kept", membershipMark("sub_Rex000000001"), true);
  is("once-marks only for the two that were sent (Tom's 180-day mark let go)", onceMarks(), 2);
  is("links only for the two that were sent (Tom's link not left behind)", links(), 2);

  part("The next run, Stripe and Redis back: each offer goes once");
  arm = false;
  stripeDown.clear();
  failWrites.clear();
  await sendWinBacks(Date.now() + 30_000, now);
  is("Una, whose run failed on Stripe, is sent the offer once", askedOf("una@example.com"), 1);
  is("Tom, whose run failed on the link, is sent the offer once", askedOf("tom@example.com"), 1);
  is("Rex is never sent it twice", askedOf("rex@example.com"), 1);
  is("Ola is never sent it twice", askedOf("ola@example.com"), 1);
  is("three counted: Ola, Una and Tom (Rex's count was lost with the failed write)", await winbacksSent(store), 3);

  done();
}

void main();
