import {renderToStaticMarkup} from "react-dom/server";
import SwitchPage from "@/app/[handle]/manage/switch/page";
let jPreviewUnknown = false;
/** Codex J, return on 669e541d: a preview whose lines say more follow (has_more), read as unknown. */
let jPreviewPartial = false;
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
import { choicesFor, liveTiers, previewKnown, previewSwitch, switchTier } from "@/lib/tier-switch";
import { membershipsFor, requestManageLink } from "@/lib/membership-manage";
import { membershipWords } from "@/lib/buyer-words/membership";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { NextRequest } from "next/server";
import { POST as switchRoute } from "@/app/api/store/manage/switch/route";
import { consentMetaValue } from "@/lib/digital-consent";

const emails: { to: string | string[]; text: string; subject: string }[] = [];
const calls: { method: string; path: string; body: URLSearchParams }[] = [];
let declined = false;
/** Stripe answers the charging update in a shape no subscription has (Revisor 2, LEVE on #2764). */
let unreadable = false;
let tierA = "";
let priceMeta: Record<string, string> = {};
// The currency the member pays in: the store's, unless it changed its currency since (22 [E5], unit 2b).
let paidIn = "usd";
// A pause set on the membership (lib/membership-pause.ts): Stripe's pause_collection, and the day it starts (R43 F4).
let pausedWith: Record<string, unknown> | null = null;
let pauseMeta: Record<string, string> = {};
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
          metadata: { store: "harbor", product: tierA, ...pauseMeta },
          pause_collection: pausedWith,
          items: { data: [{ id: "si_Member0001", price: { unit_amount: 1000, currency: paidIn, metadata: priceMeta, recurring: { interval: "month", interval_count: 1 } } }] },
        },
      ],
    });
  }
  if (method === "POST" && path === "/prices") return json({ id: "price_Tier00000001" });
  if (method === "POST" && path === "/invoices/create_preview") {
    if (jPreviewUnknown) return json({});
    if (jPreviewPartial) return json({currency:"usd",starting_balance:0,lines:{object:"list",has_more:true,data:[{amount:0,proration:true,period:{start:Number(body.get("subscription_details[proration_date]"))}}]}});
    // Stripe's next invoice: the switch's prorations, and the renewal at the period's end.
    const at = Number(body.get("subscription_details[proration_date]"));
    return json({
      total: 3240,
      currency: "usd",
      starting_balance: 0,
      lines: {
        object: "list",
        has_more: false,
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
      if (unreadable) return json({});
      return json(
        declined
          ? { id: "sub_Member0001", pending_update: { expires_at: 1 }, latest_invoice: { id: "in_Declined0001", status: "open", total: 1240 } }
          : // Applied: Stripe answers the subscription as it now is, on the new price and with the yes sent (lib/tier-switch.ts, switchReply).
            { id: "sub_Member0001", pending_update: null, items: { data: [{ id: "si_Member0001", price: { id: body.get("items[0][price]") } }] }, metadata: body.get("metadata[dc]") ? { dc: body.get("metadata[dc]") } : {}, latest_invoice: { id: "in_Paid0001", status: "paid", total: 1240, amount_paid: 1240, currency: "usd" } },
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
  const otherSwitch = await switchTier(store, token, "sub_Member0001", b.product.id, Math.floor(Date.now() / 1000), TEST_CONSENT);
  is("a link to a switch says why and changes nothing", [otherPreview.ok ? "shown" : otherPreview.reason, otherSwitch.ok ? "switched" : otherSwitch.reason], ["currency", "currency"]);
  is("no price made, no preview asked, no subscription touched", calls.slice(before).filter((c) => c.method === "POST").map((c) => c.path), []);
  is("the member is told so in every language", (["en", "es", "fr", "de", "it", "nl", "pt"] as const).every((l) => membershipWords(l).switchProblems.currency?.body.length > 40 && membershipWords(l).manageNotices.currency?.title.length > 10), true);
  paidIn = "usd";

  part("A membership with a pause set (Claude 6, R43 F4)");
  // Stripe voids every invoice while pause_collection is "void" (lib/membership-pause.ts), so a switch's charge
  // could be voided and the new tier handed over for nothing. Refused like the yearly move (lib/yearly-switch-rules.ts).
  const nowS = Math.floor(Date.now() / 1000);
  for (const [label, pause, meta] of [
    ["a pause set to start when the paid period ends", { behavior: "void", resumes_at: nowS + 40 * 86_400 }, { pause_from: String(nowS + 10 * 86_400) }],
    ["a pause running now", { behavior: "void", resumes_at: nowS + 20 * 86_400 }, { pause_from: String(nowS - 86_400) }],
    // Set on Stripe by hand, without the day it starts: unknown, so refused all the same.
    ["a pause this code did not set", { behavior: "void" }, {}],
  ] as const) {
    pausedWith = pause;
    pauseMeta = meta;
    const beforePause = calls.length;
    const pausedList = (await membershipsFor(store, token))!;
    is(`${label}: no tier offered, on the member's page or the leaving one`, choicesFor(store, pausedList[0], tiers), []);
    const pausedPreview = await previewSwitch(store, token, "sub_Member0001", b.product.id);
    const pausedSwitch = await switchTier(store, token, "sub_Member0001", b.product.id, nowS, TEST_CONSENT);
    is(`${label}: a link to a switch says why`, [pausedPreview.ok ? "shown" : pausedPreview.reason, pausedSwitch.ok ? "switched" : pausedSwitch.reason], ["paused", "paused"]);
    is(`${label}: no price made, no preview asked, no subscription touched`, calls.slice(beforePause).filter((c) => c.method === "POST").map((c) => c.path), []);
  }
  const pausedForm = withConsent(new URLSearchParams({ handle: "harbor", token, sub: "sub_Member0001", to: b.product.id, at: String(nowS) }));
  const pausedBack = await switchRoute(new NextRequest("https://marktmorgen.com/api/store/manage/switch", {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: "https://marktmorgen.com", "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
    body: pausedForm.toString(),
  }));
  // Never "paused": that status is the pause's own notice ("Your membership is paused ... an email with the dates").
  is("the button: back to the member's page with its own notice", new URL(pausedBack.headers.get("location") ?? "https://x.invalid/").searchParams.get("status"), "switch-paused");
  is("which says why in every language", (["en", "es", "fr", "de", "it", "nl", "pt"] as const).every((l) => membershipWords(l).switchProblems.paused?.body.length > 40 && membershipWords(l).switchProblems.paused?.title.length > 10), true);
  is("in plain words", [membershipWords("en").switchProblems.paused?.title, membershipWords("en").switchProblems.paused?.body], [
    "This membership has a pause set",
    "So it stays on its plan until the pause ends. To switch sooner, resume it on your membership page first. Nothing was changed.",
  ]);
  pausedWith = null;
  pauseMeta = {};

  part("The box is asked again before a switch charges (91 [D2-EU-WITHDRAWAL]; owner, C1-20261106-0100-TODOS-1)");
  is("the preview says the tier is delivered at once, so the page shows the box", preview.preview.digital, true);
  const unasked = calls.length;
  const noYes = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at, null);
  is("without the box checked: refused, and nothing sent to Stripe", [noYes.ok ? "switched" : noYes.reason, calls.slice(unasked).filter((c) => c.method === "POST").length], ["consent", 0]);
  const oldYes = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at, { version: "2026-10-30.1", at: TEST_CONSENT.at });
  is("a yes to older words: refused the same", [oldYes.ok ? "switched" : oldYes.reason, calls.slice(unasked).filter((c) => c.method === "POST").length], ["consent", 0]);

  part("The switch");
  const old = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at - 16 * 60, TEST_CONSENT);
  is("a figure more than 15 minutes old is not used", old.ok ? "switched" : old.reason, "stale");
  await redisPipeline([["SET", "nl:tier:sub_Member0001:lock", "another-change", "EX", 60]]);
  const sentBefore = calls.length;
  const held = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at, TEST_CONSENT);
  await redisPipeline([["DEL", "nl:tier:sub_Member0001:lock"]]);
  is("another change to the membership holding the lock: busy, never an error, and nothing sent", [held.ok ? "switched" : held.reason, calls.length - sentBefore], ["busy", 0]);
  declined = true;
  emails.length = 0;
  const refused = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at, TEST_CONSENT);
  is("a declined card changes nothing", refused.ok ? "switched" : refused.reason, "declined");
  is("and the invoice is voided, so nothing is owed", calls.some((c) => c.path === "/invoices/in_Declined0001/void"), true);
  is("and nobody is told it happened", emails.length, 0);
  declined = false;
  unreadable = true;
  emails.length = 0;
  const unsure = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at, TEST_CONSENT);
  unreadable = false;
  // The card may have been charged: the member is told it could not be confirmed, never that nothing changed.
  is("an answer that cannot be read: not confirmed, and nobody is told it happened", [unsure.ok ? "switched" : unsure.reason, emails.length], ["unconfirmed", 0]);
  is("said in every language without claiming nothing changed", (["en", "es", "fr", "de", "it", "nl", "pt"] as const).every((l) => {
    const notice = membershipWords(l).manageNotices.unconfirmed;
    return Boolean(notice && notice.title.length > 10 && notice.body.length > 40) && notice.body !== membershipWords(l).manageNotices.error.body;
  }), true);
  const made = await switchTier(store, token, "sub_Member0001", b.product.id, preview.preview.at, TEST_CONSENT);
  is("switched", made.ok ? made.title : made.reason, "Pro");
  const update = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("items[0][price]")).at(-1)!.body;
  is("the yes is kept on the subscription with the charge itself", update.get("metadata[dc]"), consentMetaValue(TEST_CONSENT, "membership"));
  is("charged at once, only if paid", [update.get("items[0][id]"), update.get("proration_behavior"), update.get("proration_date"), update.get("payment_behavior")], ["si_Member0001", "always_invoice", String(preview.preview.at), "pending_if_incomplete"]);
  const record = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("metadata[product]")).at(-1)!.body;
  is("the subscription's record follows", [record.get("metadata[product]"), record.get("metadata[switched_from]"), record.get("metadata[option]")], [b.product.id, a.product.id, ""]);
  is("a receipt to the member, a note to the creator", emails.map((e) => e.subject), ["You switched to Pro", "A member switched to Pro"]);
  is("the receipt says what was charged", emails[0].text.includes("Charged today: $12.40"), true);

  part("J: an unreadable invoice preview is not a known zero charge");
  jPreviewUnknown = true;
  const unknownPreview = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  const unknownHtml = renderToStaticMarkup(await SwitchPage({params:Promise.resolve({handle:"@harbor"}),searchParams:Promise.resolve({token,sub:"sub_Member0001",to:b.product.id})}));
  is("unknown preview never tells the buyer nothing is charged today", unknownHtml.includes(membershipWords("en").nothingToday), false);
  const priorCharges = calls.filter(c=>c.method==="POST" && c.body.has("items[0][price]")).length;
  const chargedAfterUnknown = await switchTier(store, token, "sub_Member0001", b.product.id, unknownPreview.ok ? unknownPreview.preview.at : Math.floor(Date.now()/1000), TEST_CONSENT);
  is("valid consent control still reaches exactly one charging update", [chargedAfterUnknown.ok,calls.filter(c=>c.method==="POST" && c.body.has("items[0][price]")).length-priorCharges], [true,1]);
  jPreviewUnknown = false;
  is("an unreadable preview refuses to certify the amount shown to the member", unknownPreview.ok, false);
  part("J: a preview whose lines are not all there is not a known zero charge");
  jPreviewPartial = true;
  const partialPreview = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  const partialHtml = renderToStaticMarkup(await SwitchPage({params:Promise.resolve({handle:"@harbor"}),searchParams:Promise.resolve({token,sub:"sub_Member0001",to:b.product.id})}));
  jPreviewPartial = false;
  is("lines said to go on (has_more) never tell the buyer nothing is charged today", [partialPreview.ok, partialHtml.includes(membershipWords("en").nothingToday)], [false, false]);
  // Stripe sends has_more on every list: a list without it is not known to be whole either.
  const line = { amount: 0, proration: true, period: { start: 1_800_000_000 } };
  is("lines are whole only when they say so (has_more false)", [
    previewKnown({ currency: "usd", lines: { object: "list", has_more: false, data: [line] } }),
    previewKnown({ currency: "usd", lines: { object: "list", data: [line] } }),
    previewKnown({ currency: "usd", lines: { object: "list", has_more: "false", data: [line] } }),
  ], [true, false, false]);
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
