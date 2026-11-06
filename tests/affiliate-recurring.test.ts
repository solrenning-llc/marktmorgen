/**
 * Affiliates on memberships, monthly bonuses, the checks that hold
 * commission, and affiliates as a channel (lib/affiliate-setting.ts,
 * lib/affiliates.ts, lib/store-checkout.ts, lib/source-rules.ts; added
 * 12 October 2026). Checked:
 *
 *   - the terms as they are kept, and only the choices there are;
 *   - a membership sold through a link carries the affiliate, the share and
 *     the months on its subscription, only where the creator credits them;
 *   - each paid invoice is read from Stripe, pinned to one version, and earns
 *     within the months agreed, a plan's every payment, after refunds, never
 *     the affiliate's own;
 *   - a bonus for each goal reached in a month, taken back by a refund;
 *   - a paid search click, or a shared address, holds what is owed out of
 *     every payment until the creator releases it;
 *   - visits through an affiliate's link are their own channel.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { NO_AFFILIATES, RECURRING_ALWAYS, parseAffiliateSetting, readBonuses } from "@/lib/affiliate-setting";
import { canonicalEmail, readBook, recordClick, releaseHold, withinMonths } from "@/lib/affiliates";
import { owedLines } from "@/lib/affiliate-payouts";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { sourceTag } from "@/lib/source-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_recurring_stand_in";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SARA = "0123456789ab";
const TOM = "abcdef012345";

const checkouts: URLSearchParams[] = [];
let invoices: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];
const invoiceAsks: { url: URL; version: string | null }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"r".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/invoices") {
    invoiceAsks.push({ url, version: new Headers(init?.headers).get("stripe-version") });
    return answer({ object: "list", data: invoices, has_more: false });
  }
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const invoice = (id: string, paidAt: number, cents: number, meta: Record<string, string>, over: Record<string, unknown> = {}) => ({
  id,
  status: "paid",
  billing_reason: "subscription_cycle",
  amount_paid: cents,
  currency: "usd",
  customer_email: "member@example.com",
  created: paidAt,
  status_transitions: { paid_at: paidAt },
  total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", ...meta } } },
  payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] },
  ...over,
});

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 400 * DAY) * 1000, decidedAt: 1, note: "", ...over });

async function main(): Promise<void> {
  redis.clear();

  part("The terms");
  is("off until chosen, as every program before was", [NO_AFFILIATES.recurring, NO_AFFILIATES.bonuses, NO_AFFILIATES.paidSearch], [0, [], false]);
  is("only the months there are", [parseAffiliateSetting({ recurring: 12 }).recurring, parseAffiliateSetting({ recurring: 5 }).recurring, parseAffiliateSetting({ recurring: RECURRING_ALWAYS }).recurring], [12, 0, RECURRING_ALWAYS]);
  is("bonuses whole and in range, the fewest sales first", readBonuses([{ sales: 25, cents: 15000 }, { sales: 10, cents: 5000 }]), [{ sales: 10, cents: 5000 }, { sales: 25, cents: 15000 }]);
  is("anything else refused", [readBonuses([{ sales: 0, cents: 5000 }]), readBonuses([{ sales: 3, cents: 50 }]), readBonuses([{ sales: 3, cents: 500 }, { sales: 3, cents: 900 }]), readBonuses(new Array(4).fill({ sales: 1, cents: 500 }))], [null, null, null, null]);
  is("within the months agreed, to the day", [withinMonths(Date.UTC(2026, 0, 31) / 1000, Date.UTC(2026, 3, 30) / 1000, 3), withinMonths(Date.UTC(2026, 0, 15) / 1000, Date.UTC(2026, 3, 15) / 1000, 3), withinMonths(0, NOW, RECURRING_ALWAYS)], [true, false, true]);
  is("one inbox however it is written", [canonicalEmail(("Sara.Lee+aff" + "@" + "Gmail.com")), canonicalEmail("sara+x@example.com"), canonicalEmail("s.ara@example.com")], [("saralee" + "@" + "gmail.com"), "sara@example.com", "s.ara@example.com"]);

  part("A membership sold through a link");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const open = async () => {
    checkouts.length = 0;
    const store = (await storeForEmail(OWNER))!;
    await createCheckout(store, (await readProduct(store, club.product.id))!, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT, via: { aff: SARA, rate: 30 }, cameFrom: { source: "instagram", medium: "post", campaign: "launch", content: "story-a" } });
    return checkouts[0];
  };
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  is("not credited where the creator does not credit memberships", (await open()).get("subscription_data[metadata][via]"), null);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: 3, bonuses: [{ sales: 2, cents: 5000 }] });
  const sent = await open();
  is("post tags travel on the checkout and subscription", [sent.get("metadata[utm_content]"), sent.get("subscription_data[metadata][utm_source]"), sent.get("subscription_data[metadata][utm_campaign]"), sent.get("subscription_data[metadata][utm_content]")], ["story-a","instagram","launch","story-a"]);
  is("the affiliate, the share and the months ride on the subscription", [
    sent.get("subscription_data[metadata][via]"),
    sent.get("subscription_data[metadata][via_rate]"),
    sent.get("subscription_data[metadata][via_months]"),
    Math.abs(Number(sent.get("subscription_data[metadata][via_at]")) - NOW) < 60,
  ], [SARA, "30", "3", true]);

  part("Each payment, read from Stripe");
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, SARA, person(SARA, ("sara.lee" + "@" + "gmail.com"), "sara")],
    ["HSET", `nl:aff:${statsId}:codes`, "sara", SARA],
    ["HSET", `nl:aff:${statsId}:people`, TOM, person(TOM, "tom@example.com", "tom")],
  ]);
  const sold = NOW - 100 * DAY;
  const terms = { product: club.product.id, via: SARA, via_rate: "30", via_months: "3", via_at: String(sold), utm_source: "instagram", utm_campaign: "launch", utm_content: "story-a" };
  invoices = [
    invoice("in_First0000001", sold + 60, 2000, terms, { billing_reason: "subscription_create" }),
    invoice("in_Month0000002", sold + 31 * DAY, 2000, terms),
    invoice("in_Month0000003", NOW - 2 * DAY, 2000, terms),
    invoice("in_Month0000004", NOW - DAY, 2000, terms),
    invoice("in_OwnPay000001", NOW - 8 * DAY, 2000, { ...terms, via_at: String(NOW - 20 * DAY) }, { customer_email: ("saralee+me" + "@" + "gmail.com") }),
    invoice("in_PlanPay00001", NOW - 5 * DAY, 3000, { product: club.product.id, via: SARA, via_rate: "30", kind: "plan" }),
    invoice("in_Elsewhere001", NOW - 5 * DAY, 3000, { ...terms, store: "another" }),
    invoice("in_Nobody000001", NOW - 5 * DAY, 3000, { product: club.product.id }),
  ];
  refunds = [{ status: "succeeded", payment_intent: "pi_in_Month0000002", amount: 1000 }];
  let book = await readBook(store);
  is("renewals retain the original subscription promotion", book.lines.find(line => line.ref === "in_Month0000002")?.promotion, {source:"instagram",campaign:"launch",content:"story-a"});
  const lines = (aff: string) => book.lines.filter((l) => l.aff === aff && l.how !== "bonus").map((l) => [l.ref, l.commission, l.status]);
  is("within three months, a partly refunded one on what was kept, a plan's every payment, never their own", lines(SARA).sort(), [
    ["in_First0000001", 600, "earned"],
    ["in_Month0000002", 300, "partly refunded"],
    ["in_OwnPay000001", 0, "own purchase"],
    ["in_PlanPay00001", 900, "earned"],
  ].sort());
  is("read with one version of Stripe's API, each payment expanded", [invoiceAsks[0]?.version, invoiceAsks[0]?.url.searchParams.getAll("expand[]")], ["2026-08-26.dahlia", ["data.payments"]]);
  is("named after the membership, credited as a membership payment", book.lines.find((l) => l.ref === "in_Month0000002")?.title, "Supper Club");

  part("A bonus for each goal reached in a month");
  // Both sales inside the month that is running: an hour or two before now fell in the
  // month before during a month's first hours (seen on 1 November 2026, 01:00 UTC).
  const monthStart = Date.UTC(new Date(NOW * 1000).getUTCFullYear(), new Date(NOW * 1000).getUTCMonth(), 1) / 1000;
  const firstSale = Math.max(NOW - 2 * 3600, monthStart + 1);
  const secondSale = Math.max(NOW - 3600, monthStart + 2);
  invoices = [
    invoice("in_Bonus0000001", firstSale, 2000, { ...terms, via_at: String(NOW - 3 * DAY) }),
    invoice("in_Bonus0000002", secondSale, 2000, { ...terms, via_at: String(NOW - 3 * DAY) }, { customer_email: "other@example.com" }),
  ];
  refunds = [];
  book = await readBook(store);
  const bonus = book.lines.find((l) => l.how === "bonus");
  is("two sales that earn in this month: the bonus once, dated at the second", [bonus?.commission, bonus?.at, bonus?.aff], [5000, secondSale, SARA]);
  is("not counted as a sale", book.rows.find((r) => r.affiliate.id === SARA)?.sales, 2);
  refunds = [{ status: "succeeded", payment_intent: "pi_in_Bonus0000002", amount: 2000 }];
  book = await readBook(store);
  is("a refund that takes the month under the goal takes it back", book.lines.some((l) => l.how === "bonus"), false);
  refunds = [];

  part("What is held until the creator looks");
  is("a click from a paid search ad is counted apart", await recordClick(store, "sara", { ip: "198.51.100.1", userAgent: "UA", session: undefined, paid: true }), true);
  book = await readBook(store);
  let sara = book.rows.find((r) => r.affiliate.id === SARA)!;
  is("held: nothing of it payable, nothing in a batch", [sara.flags, sara.held, sara.payable, owedLines(book).some((l) => l.affiliate.id === SARA)], [["paid-search"], 600 + 600 + 5000, 0, false]);
  await setAffiliateSetting(OWNER, { ...store.affiliates, paidSearch: true });
  store = (await storeForEmail(OWNER))!;
  is("unless the creator allows paid search", (await readBook(store)).rows.find((r) => r.affiliate.id === SARA)?.flags, []);
  await setAffiliateSetting(OWNER, { ...store.affiliates, paidSearch: false });
  store = (await storeForEmail(OWNER))!;
  await releaseHold(store, SARA);
  sara = (await readBook(store)).rows.find((r) => r.affiliate.id === SARA)!;
  is("released by the creator: payable again", [sara.flags, sara.held, sara.payable], [[], 0, 6200]);
  await recordClick(store, "sara", { ip: "198.51.100.2", userAgent: "UA", session: undefined, paid: true });
  is("and a new one holds it again", (await readBook(store)).rows.find((r) => r.affiliate.id === SARA)?.flags, ["paid-search"]);
  await releaseHold(store, SARA);
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, TOM, person(TOM, "tom@example.com", "tom", { paypal: ("saralee" + "@" + "gmail.com") })]]);
  book = await readBook(store);
  is("two affiliates paid at one inbox, written two ways: both held", [book.rows.find((r) => r.affiliate.id === SARA)?.flags, book.rows.find((r) => r.affiliate.id === TOM)?.flags], [["same-address"], ["same-address"]]);

  part("Affiliates, a channel of their own");
  is("a link with ?via= and no tag of its own", [sourceTag(new URLSearchParams("via=sara")), sourceTag(new URLSearchParams("via=sara&utm_source=newsletter")), sourceTag(new URLSearchParams("via=<x>"))], ["affiliates", "newsletter", ""]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
