/**
 * Membership tiers: a member switching up or down, on their own.
 *
 * Measured before it was built (30 September 2026): Stan's help center says
 * existing members stay at the price they bought at (article 132) and shows
 * no way to move between memberships. What is checked:
 *
 *   - what can be a tier, and the product a subscription is on now, read at
 *     every door from its price, then its record, then the checkout;
 *   - the member's page offers the other tiers only on a membership that runs;
 *   - the price shown is Stripe's own preview, at the second the switch uses;
 *   - a switch charges at once, and a declined card changes nothing and
 *     leaves nothing owed;
 *   - a figure more than 15 minutes old is not used.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { canTier, currentMeta, direction, dueNow, parseTiers, productOfSub } from "@/lib/tier-rules";
import { choicesFor, liveTiers, previewSwitch, switchTier } from "@/lib/tier-switch";
import { membershipsFor, requestManageLink } from "@/lib/membership-manage";
import { membershipWords } from "@/lib/buyer-words/membership";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string | string[]; text: string; subject: string }[] = [];
const calls: { method: string; path: string; body: URLSearchParams }[] = [];
let declined = false;
let tierA = "";
let priceMeta: Record<string, string> = {};
// The currency the member pays in: the store's, unless it changed its currency since (22 [E5], unit 2b).
let paidIn = "usd";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "e" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  calls.push({ method, path, body });
  const json = (v: unknown) => new Response(JSON.stringify(v));
  if (method === "GET" && path === "/customers") return json({ data: [{ id: "cus_Member0001", created: 1 }] });
  if (method === "GET" && path === "/customers/cus_Member0001") return json({ id: "cus_Member0001", email: "dana@example.com" });
  if (method === "GET" && path === "/subscriptions") {
    return json({
      data: [
        {
          id: "sub_Member0001",
          status: "active",
          customer: "cus_Member0001",
          created: 1,
          metadata: { store: "harbor", product: tierA },
          items: { data: [{ id: "si_Member0001", price: { unit_amount: 1000, currency: paidIn, metadata: priceMeta, recurring: { interval: "month", interval_count: 1 } } }] },
        },
      ],
    });
  }
  if (method === "POST" && path === "/prices") return json({ id: "price_Tier00000001" });
  if (method === "POST" && path === "/invoices/create_preview") {
    // Stripe's next invoice: the switch's prorations, and the renewal at the period's end.
    const at = Number(body.get("subscription_details[proration_date]"));
    return json({
      total: 3240,
      currency: "usd",
      starting_balance: 0,
      lines: {
        data: [
          { amount: -500, parent: { subscription_item_details: { proration: true } }, period: { start: at } },
          { amount: 1740, parent: { subscription_item_details: { proration: true } }, period: { start: at } },
          { amount: 2000, parent: { subscription_item_details: { proration: false } }, period: { start: at + 20 * 86_400 } },
        ],
      },
    });
  }
  if (method === "POST" && path === "/subscriptions/sub_Member0001") {
    if (body.get("items[0][price]")) {
      return json(
        declined
          ? { id: "sub_Member0001", pending_update: { expires_at: 1 }, latest_invoice: { id: "in_Declined0001", status: "open", total: 1240 } }
          : { id: "sub_Member0001", pending_update: null, latest_invoice: { id: "in_Paid0001", status: "paid", total: 1240, amount_paid: 1240, currency: "usd" } },
      );
    }
    return json({ id: "sub_Member0001" });
  }
  if (method === "POST" && path === "/invoices/in_Declined0001/void") return json({ id: "in_Declined0001", status: "void" });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_tiers_only";
  process.env.RESEND_API_KEY = "re_test_tiers_only";

  part("What a tier is");
  is("2 to 6 ids, or none", [parseTiers(["a", "b", "a"]), parseTiers(["a"]), parseTiers(["a", "b", "c", "d", "e", "f", "g"]).length], [["a", "b"], [], 6]);
  const member = { priceCents: 1000, recurring: { interval: "month", payments: 0 }, options: [] };
  is("a membership that runs until canceled, at one price", [canTier(member), canTier({ ...member, recurring: { interval: "month", payments: 12 } }), canTier({ ...member, recurring: null }), canTier({ ...member, pwyw: { minCents: 100 } })], [true, false, false, false]);
  is("up or down on the same schedule, neither across schedules", [direction({ priceCents: 1000, interval: "month" }, { priceCents: 10000, interval: "year" }), direction({ priceCents: 1000, interval: "month" }, { priceCents: 2000, interval: "month" }), direction({ priceCents: 2000, interval: "month" }, { priceCents: 1000, interval: "month" })], ["same", "up", "down"]);

  part("What a switch charges, read from Stripe's preview");
  // Stripe's own example (docs.stripe.com/billing/subscriptions/prorations, "Preview a proration"):
  // $10 to $32.52 a month; the preview totals $36.27 with next month's renewal in it.
  const docs = { starting_balance: 0, lines: { data: [
    { amount: -166, proration: true, period: { start: 1598982148 } },
    { amount: 541, proration: true, period: { start: 1598982148 } },
    { amount: 3252, proration: false, period: { start: 1599427688 } },
  ] } };
  is("only the switch, not the renewal after it", dueNow(docs, 1598982148), 375);
  is("a credit the member holds comes off it", dueNow({ ...docs, starting_balance: -300 }, 1598982148), 75);
  is("down is a credit", dueNow({ lines: { data: [{ amount: -900, parent: { subscription_item_details: { proration: true } }, period: { start: 100 } }] } }, 100), -900);
  is("monthly to yearly: the new year is charged now, less the credit", dueNow({ lines: { data: [
    { amount: -750, parent: { subscription_item_details: { proration: true } }, period: { start: 100 } },
    { amount: 15000, parent: { subscription_item_details: { proration: false } }, period: { start: 100 }, discount_amounts: [{ amount: 1500 }], taxes: [{ amount: 900, tax_behavior: "exclusive" }] },
  ] } }, 100), 13650);

  part("The tier a subscription is on now");
  const sub = (priceProduct: string | null, subProduct: string) => ({ metadata: { product: subProduct }, items: { data: [{ price: { metadata: priceProduct ? { product: priceProduct } : {} } }] } });
  is("its price first, then its record, then the checkout", [productOfSub(sub("b", "a")), productOfSub(sub(null, "a")), productOfSub(null, "c")], ["b", "a", "c"]);
  const meta = { store: "harbor", product: "a", option: "o1" };
  is("a switched membership hands over its tier now", currentMeta(meta, { mode: "subscription", subscription: sub("b", "a") }), { store: "harbor", product: "b" });
  is("never switched, as it was", currentMeta(meta, { mode: "subscription", subscription: sub(null, "a") }), meta);
  is("a payment plan is never read as a tier", currentMeta({ ...meta, kind: "plan" }, { mode: "subscription", subscription: sub("b", "a") }).product, "a");
  is("nor a one-off payment", currentMeta(meta, { mode: "payment", subscription: null }).product, "a");

  part("The member's page");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct("owner@example.com", "Basic", "", "10", monthly);
  const b = await addProduct("owner@example.com", "Pro", "", "20", monthly);
  if (!a.ok || !b.ok) throw new Error("no products");
  await setProductLink("owner@example.com", a.product.id, "https://example.com/basic");
  await setProductLink("owner@example.com", b.product.id, "https://example.com/pro");
  tierA = a.product.id;
  await setStoreTiers("owner@example.com", [a.product.id, b.product.id]);
  let store = (await storeForEmail("owner@example.com"))!;
  is("kept with the store", store.tiers, [a.product.id, b.product.id]);
  const tiers = await liveTiers(store);
  is("both on sale", tiers.map((t) => t.title), ["Basic", "Pro"]);

  is("the link is emailed", await requestManageLink({ store, email: "dana@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "sent");
  const link = emails.at(-1)!;
  is("which says switching is there", link.text.includes("switch to another plan"), true);
  const token = /token=([0-9a-f]{64})/.exec(link.text)![1];
  const listed = (await membershipsFor(store, token))!;
  is("the membership, on the tier it is on", [listed.length, listed[0].title, listed[0].product], [1, "Basic", a.product.id]);
  const choices = choicesFor(store, listed[0], tiers);
  is("offered the other tier, as an upgrade", choices.map((c) => [c.title, c.way, c.words]), [["Pro", "up", "$20 a month"]]);
  is("nothing offered once canceled", choicesFor(store, { ...listed[0], endsAt: 2_000_000_000 }, tiers), []);
  is("nor while a payment is failing", choicesFor(store, { ...listed[0], status: "past_due" }, tiers), []);
  is("nor on one sold as a set number of payments", choicesFor(store, { ...listed[0], fixedEnd: true }, tiers), []);

  part("What it costs, before anything happens");
  const preview = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  if (!preview.ok) throw new Error(`no preview: ${preview.reason}`);
  is("Stripe's own figure", [preview.preview.due, preview.preview.from.title, preview.preview.to.title], [1240, "Basic", "Pro"]);
  const asked = calls.find((c) => c.path === "/invoices/create_preview")!.body;
  is("worked out to the second, onto the new tier's price", [asked.get("subscription_details[items][0][price]"), asked.get("subscription_details[proration_behavior]"), asked.get("subscription_details[proration_date]")], ["price_Tier00000001", "always_invoice", String(preview.preview.at)]);
  const price = calls.find((c) => c.path === "/prices")!.body;
  is("that price names the product it hands over", [price.get("metadata[product]"), price.get("unit_amount"), price.get("recurring[interval]")], [b.product.id, "2000", "month"]);
  await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("and is made once", calls.filter((c) => c.path === "/prices").length, 1);
  const notMine = await previewSwitch(store, token, "sub_Somebody0001", b.product.id);
  is("nobody else's membership", notMine.ok ? "shown" : notMine.reason, "gone");
  const same = await previewSwitch(store, token, "sub_Member0001", a.product.id);
  is("not to the tier it is on", same.ok ? "shown" : same.reason, "tier");
  const badLink = await previewSwitch(store, "0".repeat(64), "sub_Member0001", b.product.id);
  is("not without a live link", badLink.ok ? "shown" : badLink.reason, "expired");

  part("A membership paid in another currency than the store's now");
  // The store changed its currency after this member subscribed: every tier is priced in the new one.
  paidIn = "eur";
  const before = calls.length;
  const other = (await membershipsFor(store, token))!;
  is("no tier offered to it", [other[0].currency, choicesFor(store, other[0], tiers)], ["eur", []]);
  const otherPreview = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  const otherSwitch = await switchTier(store, token, "sub_Member0001", b.product.id, Math.floor(Date.now() / 1000));
  is("a link to a switch says why and changes nothing", [otherPreview.ok ? "shown" : otherPreview.reason, otherSwitch.ok ? "switched" : otherSwitch.reason], ["currency", "currency"]);
  is("no price made, no preview asked, no subscription touched", calls.slice(before).filter((c) => c.method === "POST").map((c) => c.path), []);
  is("the member is told so in every language", (["en", "es", "fr", "de", "it", "nl", "pt"] as const).every((l) => membershipWords(l).switchProblems.currency?.body.length > 40 && membershipWords(l).manageNotices.currency?.title.length > 10), true);
  paidIn = "usd";

  part("The switch");
  const old = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at - 16 * 60);
  is("a figure more than 15 minutes old is not used", old.ok ? "switched" : old.reason, "stale");
  await redisPipeline([["SET", "nl:tier:sub_Member0001:lock", "another-change", "EX", 60]]);
  const sentBefore = calls.length;
  const held = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at);
  await redisPipeline([["DEL", "nl:tier:sub_Member0001:lock"]]);
  is("another change to the membership holding the lock: busy, never an error, and nothing sent", [held.ok ? "switched" : held.reason, calls.length - sentBefore], ["busy", 0]);
  declined = true;
  emails.length = 0;
  const refused = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at);
  is("a declined card changes nothing", refused.ok ? "switched" : refused.reason, "declined");
  is("and the invoice is voided, so nothing is owed", calls.some((c) => c.path === "/invoices/in_Declined0001/void"), true);
  is("and nobody is told it happened", emails.length, 0);
  declined = false;
  const made = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at);
  is("switched", made.ok ? made.title : made.reason, "Pro");
  const update = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("items[0][price]")).at(-1)!.body;
  is("charged at once, only if paid", [update.get("items[0][id]"), update.get("proration_behavior"), update.get("proration_date"), update.get("payment_behavior")], ["si_Member0001", "always_invoice", String(preview.preview.at), "pending_if_incomplete"]);
  const record = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("metadata[product]")).at(-1)!.body;
  is("the subscription's record follows", [record.get("metadata[product]"), record.get("metadata[switched_from]"), record.get("metadata[option]")], [b.product.id, a.product.id, ""]);
  is("a receipt to the member, a note to the creator", emails.map((e) => e.subject), ["You switched to Pro", "A member switched to Pro"]);
  is("the receipt says what was charged", emails[0].text.includes("Charged today: $12.40"), true);

  part("Afterward");
  priceMeta = { product: b.product.id };
  const after = (await membershipsFor(store, token))!;
  is("the member's page shows the new tier", after[0].title, "Pro");
  is("and offers the way back down", choicesFor(store, { ...after[0], amount: 2000 }, tiers).map((c) => [c.title, c.way]), [["Basic", "down"]]);
  await setStoreTiers("owner@example.com", []);
  store = (await storeForEmail("owner@example.com"))!;
  is("switching off offers nothing", [store.tiers, (await liveTiers(store)).length], [[], 0]);

  done();
}

void main();
