/**
 * The come-back offer after a membership ends.
 *
 * Measured before it was built (30 September 2026): Patreon's Autopilot sends
 * win-back offers; Mighty Networks has cancellation follow-ups; Circle sends
 * reactivation emails; Whop messages members who leave; Stan, Skool, Kajabi
 * and Gumroad document none. Stripe is played by a stand-in for `fetch`, and
 * so is the email sender. What is checked:
 *
 *   - one email per ended membership, the chosen number of days after, never
 *     twice however many times the job runs;
 *   - only to somebody who agreed to hear from the creator and has not left;
 *   - never to somebody who already came back, never for a payment plan or a
 *     membership sold to end, never another store's;
 *   - a multi-payment offer only for a monthly membership;
 *   - the link opens a checkout for that address alone, with the coupon
 *     applied and no second free trial.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import {
  addOption,
  addProduct,
  claimHandle,
  ensureListId,
  ensureStatsId,
  removeOption,
  setProductLink,
  setStripeAccount,
  setSubscription,
  setWinBack,
  storeForEmail,
} from "@/lib/store";
import { unsubscribe, upsertContact, readUnsubToken } from "@/lib/contacts";
import { parseWinBack, winbackOn, winbackWords } from "@/lib/winback";
import { openWinBack, readWinBack, sendWinBacks, winbackEmail } from "@/lib/winback-send";
import { readProduct } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);

type Sent = { to: string[]; subject: string; text: string; headers?: Record<string, string> };
const emails: Sent[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();
const liveSubs = new Map<string, { status: string; metadata: Record<string, string> }[]>();
const checkouts: URLSearchParams[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  // The customers of one address (lib/winback-send.ts reads every one of them, audit R43): those set above.
  if (path === "/customers") return answer({ object: "list", data: [...customers].filter(([, e]) => e === url.searchParams.get("email")).map(([id, email]) => ({ id, object: "customer", email })), has_more: false });
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  if (path === "/subscriptions") return answer({ object: "list", data: liveSubs.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"a".repeat(20)}${checkouts.length}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

/** A membership that ended, as Stripe's event holds it. */
function ended(id: string, customer: string, daysAgo: number, meta: Record<string, string>, interval = "month") {
  events.push({
    id: `evt_${id}`,
    type: "customer.subscription.deleted",
    created: nowS - daysAgo * DAY,
    data: {
      object: {
        id,
        customer,
        ended_at: nowS - daysAgo * DAY,
        metadata: meta,
        items: { data: [{ price: { recurring: { interval, interval_count: 1 } } }] },
      },
    },
  });
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_winback_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_winback_only_a_stand_in";
  redis.clear();

  part("The setting");
  is("off with no coupon", parseWinBack({ percent: 25, months: 1, days: 7, coupon: "", address: "1 Main St" }).percent, 0);
  is("off with no postal address to print", parseWinBack({ percent: 25, months: 1, days: 7, coupon: "co_ABC123", address: " " }).percent, 0);
  is("a day not offered falls back to a week", parseWinBack({ percent: 25, months: 1, days: 30, coupon: "co_ABC123", address: "1 Main St" }).days, 7);
  is("the words", winbackWords({ percent: 30, months: 2 }), "30% off your first 2 payments");

  part("The email says what it is");
  const sample = winbackEmail({ storeName: "Harbor Kitchen", title: "The Inner Circle", endedOn: "September 20, 2026", offer: "25% off your first payment", link: "https://x/renew/p?back=t", until: "October 14, 2026" });
  is("the subject names the product and the offer", sample.subject, "Come back to The Inner Circle: 25% off your first payment");
  is("it says nothing is charged by opening it", sample.body.includes("nothing is charged until you check out"), true);

  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct("owner@example.com", "The Inner Circle", "", "29", { interval: "month", trialDays: 7, payments: 0 });
  const yearly = await addProduct("owner@example.com", "Yearly Club", "", "290", { interval: "year", trialDays: 0, payments: 0 });
  if (!club.ok || !yearly.ok) throw new Error("no product");
  await setProductLink("owner@example.com", club.product.id, "https://example.com/club");
  await setProductLink("owner@example.com", yearly.product.id, "https://example.com/yearly");
  await setWinBack("owner@example.com", { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  let store = await storeForEmail("owner@example.com");
  if (!store?.listId) throw new Error("no list");
  is("on, with its coupon and its address", winbackOn(store), true);

  const agreed = async (email: string) => upsertContact(store!.listId as string, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
  await agreed("dana@example.com");
  await agreed("eli@example.com");
  await agreed("gia@example.com");
  await agreed("hal@example.com");
  await upsertContact(store.listId, "fay@example.com", { agreed: false, explicit: false, source: "buyer" }, ROOM);
  for (const [id, email] of [["cus_Dana00001", "dana@example.com"], ["cus_Eli000001", "eli@example.com"], ["cus_Fay000001", "fay@example.com"], ["cus_Gia000001", "gia@example.com"], ["cus_Hal000001", "hal@example.com"]]) {
    customers.set(id, email);
  }
  const meta = { store: "harbor", product: club.product.id };
  ended("sub_Dana00001", "cus_Dana00001", 8, meta);
  ended("sub_Eli000001", "cus_Eli000001", 7, meta);
  liveSubs.set("cus_Eli000001", [{ status: "active", metadata: meta }]);
  ended("sub_Fay000001", "cus_Fay000001", 8, meta);
  ended("sub_Gia000001", "cus_Gia000001", 8, { ...meta, kind: "plan" });
  ended("sub_Gia000002", "cus_Gia000001", 8, { ...meta, ends_after: "6" });
  ended("sub_Hal000001", "cus_Hal000001", 8, { store: "harbor", product: yearly.product.id }, "year");
  ended("sub_Oth000001", "cus_Dana00001", 8, { store: "someoneelse", product: club.product.id });
  ended("sub_Dana00002", "cus_Dana00001", 3, meta);

  part("Who is written to");
  await sendWinBacks(Date.now() + 30_000, now);
  is("exactly one email", emails.length, 1);
  is("to the member who agreed and has not come back", emails[0]?.to, ["dana@example.com"]);
  is("never to somebody already back, a plan, a set-length membership, another store, or somebody who never agreed", emails.map((e) => e.to[0]), ["dana@example.com"]);
  is("a two-payment offer is not sent for a yearly membership", emails.some((e) => e.to[0] === "hal@example.com"), false);
  is("a membership that ended three days ago waits for its seven", emails.length, 1);
  is("it carries the one-click unsubscribe", Boolean(emails[0]?.headers?.["List-Unsubscribe"]), true);
  is("and the creator's postal address", emails[0]?.text.includes("1 Main St, Portland, OR 97201"), true);

  await sendWinBacks(Date.now() + 30_000, now);
  is("a second run sends nothing more", emails.length, 1);

  part("The link");
  const link = emails[0].text.match(/\/renew\/([a-z0-9]+)\?back=([0-9a-f]{40})/);
  if (!link) throw new Error("no link");
  store = await storeForEmail("owner@example.com");
  const grant = await readWinBack(store!, link[1], link[2]);
  is("it is for Dana, on this product", [grant?.email, grant?.product], ["dana@example.com", club.product.id]);
  is("with the offer as it was sent", [grant?.percent, grant?.months], [25, 2]);
  is("it opens nothing for another product", await readWinBack(store!, yearly.product.id, link[2]), null);
  const unasked = await openWinBack(store!, link[1], link[2], "https://marktmorgen.com");
  is("without the box to start the membership before the 14 days end (lib/digital-consent.ts), no checkout opens", unasked.ok ? "opened" : unasked.reason, "consent");
  const opened = await openWinBack(store!, link[1], link[2], "https://marktmorgen.com", TEST_CONSENT);
  is("the checkout opens", opened.ok, true);
  const body = checkouts[0];
  is("with the coupon applied", body.get("discounts[0][coupon]"), "co_Back0001");
  is("and no box for another code beside it", body.get("allow_promotion_codes"), null);
  is("for her address only", body.get("customer_email"), "dana@example.com");
  is("with no second free trial", body.get("subscription_data[trial_period_days]"), null);
  is("marked, so the creator's Stripe shows where it came from", body.get("subscription_data[metadata][winback]"), "yes");

  part("Somebody who left the list");
  const token = emails[0].headers?.["List-Unsubscribe"]?.match(/t=([0-9a-f]+)/)?.[1] ?? "";
  is("the unsubscribe token is the list's own", (await readUnsubToken(token))?.email, "dana@example.com");
  await unsubscribe(token);
  ended("sub_Dana00009", "cus_Dana00001", 8, { store: "harbor", product: yearly.product.id });
  await setWinBack("owner@example.com", { percent: 25, months: 1, days: 7, coupon: "co_Back0002", address: "1 Main St, Portland, OR 97201" });
  await sendWinBacks(Date.now() + 30_000, now);
  is("is not written to again", emails.slice(1).some((e) => e.to[0] === "dana@example.com"), false);
  is("while a one-payment offer now reaches the yearly member it could not before", emails.slice(1).map((e) => e.to[0]), ["hal@example.com"]);

  part("A price since removed, or kept with nothing to hand over (owner, C2-89)");
  // A membership at several prices: Gone is removed, Bare has no file or link, Kept is offered.
  const tiers = await addProduct("owner@example.com", "Bread Club", "", "19", { interval: "month", trialDays: 0, payments: 0 });
  if (!tiers.ok) throw new Error("no product");
  for (const label of ["Gone", "Bare", "Kept"]) await addOption("owner@example.com", tiers.product.id, label, "19");
  store = await storeForEmail("owner@example.com");
  const [gone, bare, kept] = (await readProduct(store!, tiers.product.id))!.options.map((o) => o.id);
  await setProductLink("owner@example.com", gone, "https://example.com/gone");
  await setProductLink("owner@example.com", kept, "https://example.com/kept");
  await removeOption("owner@example.com", gone);
  for (const [id, email] of [["cus_Ivy000001", "ivy@example.com"], ["cus_Jon000001", "jon@example.com"], ["cus_Kim000001", "kim@example.com"]]) {
    customers.set(id, email);
    await agreed(email);
  }
  ended("sub_Ivy000001", "cus_Ivy000001", 8, { store: "harbor", product: tiers.product.id, option: gone });
  ended("sub_Jon000001", "cus_Jon000001", 8, { store: "harbor", product: tiers.product.id, option: bare });
  ended("sub_Kim000001", "cus_Kim000001", 8, { store: "harbor", product: tiers.product.id, option: kept });
  const sentBefore = emails.length;
  const onceBefore = redis.keys().filter((k) => k.startsWith("nl:wb:once:")).length;
  await sendWinBacks(Date.now() + 30_000, now);
  is("only the member whose price is still offered is written to", emails.slice(sentBefore).map((e) => e.to[0]), ["kim@example.com"]);
  is("the others leave no mark: no email spent, no later offer held back", [redis.keys().includes("nl:wb:acct_1TestHarbor0001:sub_Ivy000001"), redis.keys().includes("nl:wb:acct_1TestHarbor0001:sub_Jon000001"), redis.keys().filter((k) => k.startsWith("nl:wb:once:")).length - onceBefore], [false, false, 1]);

  done();
}

void main();
