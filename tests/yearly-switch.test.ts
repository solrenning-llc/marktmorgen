import {renderToReadableStream} from "react-dom/server";
import SwitchPage from "@/app/[handle]/manage/switch/page";
import {membershipWords} from "@/lib/buyer-words/membership";
let jPreviewUnknown=false;
/** Codex J, return on 669e541d: a preview whose lines say more follow (has_more), read as unknown. */
let jPreviewPartial = false;
/**
 * A monthly member moving to the same membership's yearly price, and the one
 * email that offers it (lib/yearly-switch-rules.ts, lib/yearly-switch.ts,
 * lib/yearly-ask.ts; added 12 October 2026). Checked:
 *
 *   - offered only where it saves the member money against their own monthly
 *     payments, and never where it could cost the creator: a discount, or an
 *     affiliate's share for a set number of months still running;
 *   - the member's page offers it, and the amount shown is Stripe's own
 *     preview at the second the move uses: the year, less what is left of
 *     the month already paid;
 *   - the move puts the same product on a yearly price, records it, and
 *     sends the member a receipt and the creator a note;
 *   - the emailed link opens that one membership's move and nothing else;
 *   - the email goes once per membership, from the third monthly payment on,
 *     only to members who agreed to hear from the creator, with the list's
 *     footer and the creator's postal address.
 */
import { askFits, affiliateMonthsLeft, parseYearlyAsk, yearlyChoice } from "@/lib/yearly-switch-rules";
import { YEARLY_TARGET, grantFor, mintYearlyLink, previewYearly, switchYearly, yearlyPriceBody } from "@/lib/yearly-switch";
import { askStore, yearlyAskEmail, yearlyAsksThisMonth } from "@/lib/yearly-ask";
import { membershipsFor, requestManageLink } from "@/lib/membership-manage";
import { upsertContact } from "@/lib/contacts";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, setYearlyAsk, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { consentMetaValue } from "@/lib/digital-consent";
import { NextRequest } from "next/server";
import { POST as switchRoute } from "@/app/api/store/manage/switch/route";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_switch_only";
process.env.RESEND_API_KEY = "re_test_yearly_switch_only";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const mails: { to: string | string[]; subject: string; text: string }[] = [];
const calls: { method: string; path: string; body: URLSearchParams }[] = [];
let product = "";
let subs: Record<string, unknown>[] = [];
let declined = false;

const member = (id: string, customer: string, email: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "active",
  customer: { id: customer, email },
  created: NOW - 90 * DAY,
  start_date: NOW - 90 * DAY,
  trial_end: null,
  discount: null,
  discounts: [],
  pause_collection: null,
  metadata: { store: "harbor", product },
  items: { data: [{ id: `si_${id.slice(4)}`, quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } } }] },
  ...over,
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown) => new Response(JSON.stringify(v));
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)));
    return json({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  calls.push({ method, path, body });
  // A list as Stripe gives it, with has_more (rule 23: fixture only; findMember reads lists exactly since sweep APP2).
  if (method === "GET" && path === "/customers") return json({ data: [{ id: "cus_Dana000001", created: 1 }], has_more: false });
  if (method === "GET" && path === "/customers/cus_Dana000001") return json({ id: "cus_Dana000001", email: "dana@example.com" });
  if (method === "GET" && path === "/subscriptions") {
    const customer = url.searchParams.get("customer");
    // The member's page asks for one customer's, unexpanded; the daily run for all, with the customer.
    const rows = customer ? subs.filter((s) => (s.customer as { id: string }).id === customer).map((s) => ({ ...s, customer: (s.customer as { id: string }).id })) : subs;
    return json({ object: "list", data: rows, has_more: false });
  }
  if (method === "POST" && path === "/prices") return json({ id: "price_Yearly000001" });
  if (method === "POST" && path === "/invoices/create_preview") {
    if(jPreviewUnknown)return json({});
    if (jPreviewPartial) return json({currency:"usd",starting_balance:0,lines:{object:"list",has_more:true,data:[{amount:0,proration:true,period:{start:Number(body.get("subscription_details[proration_date]"))}}]}});
    const at = Number(body.get("subscription_details[proration_date]"));
    // The month's unused part back, and the year from now.
    return json({
      currency: "usd",
      starting_balance: 0,
      lines: {
        object: "list",
        has_more: false,
        data: [
          { amount: -667, parent: { subscription_item_details: { proration: true } }, period: { start: at } },
          { amount: 20000, parent: { subscription_item_details: { proration: false } }, period: { start: at } },
        ],
      },
    });
  }
  if (method === "POST" && path === "/subscriptions/sub_Dana00000001") {
    if (body.get("items[0][price]")) {
      return json(
        declined
          ? { id: "sub_Dana00000001", pending_update: { expires_at: 1 }, latest_invoice: { id: "in_Declined0001", status: "open", total: 19333 } }
          : // Applied: Stripe answers the subscription as it now is, on the new price and with the yes sent (lib/tier-switch.ts, switchReply).
            { id: "sub_Dana00000001", pending_update: null, items: { data: [{ id: "si_Dana00000001", price: { id: body.get("items[0][price]") } }] }, metadata: body.get("metadata[dc]") ? { dc: body.get("metadata[dc]") } : {}, latest_invoice: { id: "in_Paid0001", status: "paid", total: 19333, amount_paid: 19333, currency: "usd" } },
      );
    }
    return json({ id: "sub_Dana00000001" });
  }
  if (method === "POST" && path === "/invoices/in_Declined0001/void") return json({ id: "in_Declined0001", status: "void" });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();

  part("Where it is offered");
  const club = { id: "club", priceCents: 2000, recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: null, yearly: { cents: 20000 } };
  const sub = (over: Record<string, unknown> = {}) => member("sub_Test00000001", "cus_Test000001", "t@example.com", { metadata: { store: "harbor", product: "club" }, ...over });
  is("a monthly member: the year, and what it saves against their own payments", yearlyChoice(sub(), club, [], "usd", NOW), { cents: 20000, saving: 4000, monthly: 2000 });
  const at = (cents: number) => ({ items: { data: [{ quantity: 1, price: { unit_amount: cents, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } });
  is("a member on an older, lower price, for whom a year saves nothing: not offered", yearlyChoice(sub(at(1500)), club, [], "usd", NOW), null);
  is("in a trial, yes", yearlyChoice(sub({ status: "trialing" }), club, [], "usd", NOW)?.cents, 20000);
  is(
    "not paid up, set to end, paused, two seats, another currency, already yearly",
    [
      yearlyChoice(sub({ status: "past_due" }), club, [], "usd", NOW),
      yearlyChoice(sub({ cancel_at_period_end: true }), club, [], "usd", NOW),
      yearlyChoice(sub({ pause_collection: { behavior: "void", resumes_at: NOW + DAY } }), club, [], "usd", NOW),
      yearlyChoice(sub({ items: { data: [{ quantity: 2, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } }), club, [], "usd", NOW),
      yearlyChoice(sub(at(2000)), club, [], "eur", NOW),
      yearlyChoice(sub({ items: { data: [{ quantity: 1, price: { unit_amount: 20000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] } }), club, [], "usd", NOW),
    ],
    [null, null, null, null, null, null],
  );
  is("never with a discount: a few months off would come off a whole year", [yearlyChoice(sub({ discounts: ["di_1"] }), club, [], "usd", NOW), yearlyChoice(sub({ discount: { id: "di_1" } }), club, [], "usd", NOW)], [null, null]);
  const via = (months: number, daysAgo: number) => ({ metadata: { store: "harbor", product: "club", via: "0123456789ab", via_rate: "30", via_months: String(months), via_at: String(NOW - daysAgo * DAY) } });
  is(
    "an affiliate's share for 3 months still running: not offered; once it ran out, or for as long as they pay: offered",
    [yearlyChoice(sub(via(3, 40)), club, [], "usd", NOW), yearlyChoice(sub(via(3, 120)), club, [], "usd", NOW)?.cents, yearlyChoice(sub(via(1200, 40)), club, [], "usd", NOW)?.cents],
    [null, 20000, 20000],
  );
  is("the share's months counted from the sale", [affiliateMonthsLeft(via(3, 40).metadata, NOW), affiliateMonthsLeft(via(3, 120).metadata, NOW), affiliateMonthsLeft({}, NOW)], [true, false, false]);
  is("a product that no longer offers a yearly price, or one in the plans members switch between", [yearlyChoice(sub(), { ...club, yearly: null }, [], "usd", NOW), yearlyChoice(sub(), club, ["club", "other"], "usd", NOW)], [null, null]);

  part("When the email fits");
  is(
    "paying, from the third monthly payment on; not in a trial, not before",
    [askFits(sub(), NOW), askFits(sub({ start_date: NOW - 30 * DAY }), NOW), askFits(sub({ status: "trialing" }), NOW), askFits(sub({ start_date: NOW - 70 * DAY, trial_end: NOW - 40 * DAY }), NOW)],
    [true, false, false, false],
  );
  is("on only with a postal address", [parseYearlyAsk({ on: true, address: " " }).on, parseYearlyAsk({ on: true, address: "1 Main St" }).on], [false, true]);

  part("The member's page");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setProductYearly(OWNER, product, { cents: 20000 });
  let store = (await storeForEmail(OWNER))!;
  subs = [member("sub_Dana00000001", "cus_Dana000001", "dana@example.com")];
  is("the link is emailed", await requestManageLink({ store, email: "dana@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "sent");
  const token = /token=([0-9a-f]{64})/.exec(mails[0].text)![1];
  const listed = (await membershipsFor(store, token))!;
  is("the membership offers paying yearly, with what it saves", listed.map((m) => m.yearly), [{ cents: 20000, saving: 4000, monthly: 2000 }]);

  part("What moving costs, from Stripe's preview");
  const preview = await previewYearly(store, token, "sub_Dana00000001");
  if (!preview.ok) throw new Error(`no preview: ${preview.reason}`);
  is("the year, less what is left of the month", [preview.preview.due, preview.preview.monthlyWords, preview.preview.yearlyWords, preview.preview.saving], [19333, "$20 a month", "$200 a year", 4000]);
  const price = calls.find((c) => c.path === "/prices")!.body;
  is("on a yearly price for the same product", [price.get("unit_amount"), price.get("recurring[interval]"), price.get("metadata[product]"), price.get("metadata[every]")], ["20000", "year", product, "year"]);
  is("the price body, pure", yearlyPriceBody(store, made.product, 20000).get("product_data[metadata][product]"), product);
  const asked = calls.find((c) => c.path === "/invoices/create_preview")!.body;
  is("previewed as the move itself will be made", [asked.get("subscription_details[items][0][price]"), asked.get("subscription_details[proration_behavior]")], ["price_Yearly000001", "always_invoice"]);
  is("somebody else's membership is not on this link", (await previewYearly(store, token, "sub_Somebody0001")).ok, false);

  part("The box is asked again before a move to yearly charges (91 [D2-EU-WITHDRAWAL]; owner, C1-20261106-0100-TODOS-1)");
  is("the preview says the membership is delivered at once, so the page shows the box", preview.preview.digital, true);
  const unasked = calls.length;
  const noYes = await switchYearly(store, token, "sub_Dana00000001", preview.preview.at, null);
  is("without the box checked: refused, and nothing sent to Stripe", [noYes, calls.slice(unasked).filter((c) => c.method === "POST").length], [{ ok: false, reason: "consent" }, 0]);
  const post = (fields: Record<string, string>, consent: boolean) => {
    const form = new URLSearchParams(fields);
    if (consent) withConsent(form);
    return switchRoute(new NextRequest("https://marktmorgen.com/api/store/manage/switch", {
      method: "POST",
      headers: { Host: "marktmorgen.com", Origin: "https://marktmorgen.com", "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
      body: form.toString(),
    }));
  };
  const fields = { handle: "harbor", token, sub: "sub_Dana00000001", to: YEARLY_TARGET, at: String(preview.preview.at) };
  const sentBack = await post(fields, false);
  const where = new URL(sentBack.headers.get("location") ?? "https://x.invalid/");
  is("the button without the box: back to the same move, the box saying what is missing", [sentBack.status, where.pathname, where.searchParams.get("to"), where.searchParams.get("sub"), where.searchParams.get("consent")], [303, "/@harbor/manage/switch", YEARLY_TARGET, "sub_Dana00000001", "needed"]);
  is("and nothing sent to Stripe", calls.slice(unasked).filter((c) => c.method === "POST").length, 0);

  part("The move");
  is("a figure more than 15 minutes old is not used", await switchYearly(store, token, "sub_Dana00000001", preview.preview.at - 16 * 60, TEST_CONSENT), { ok: false, reason: "stale" });
  await redisPipeline([["SET", "nl:tier:sub_Dana00000001:lock", "another-change", "EX", 60]]);
  const sentBefore = calls.length;
  const held = await switchYearly(store, token, "sub_Dana00000001", preview.preview.at, TEST_CONSENT);
  await redisPipeline([["DEL", "nl:tier:sub_Dana00000001:lock"]]);
  is("another change to the membership holding the lock: busy, never an error, and nothing sent", [held, calls.length - sentBefore], [{ ok: false, reason: "busy" }, 0]);
  declined = true;
  is("a declined card changes nothing", await switchYearly(store, token, "sub_Dana00000001", preview.preview.at, TEST_CONSENT), { ok: false, reason: "declined" });
  is("and leaves nothing owed", calls.some((c) => c.path === "/invoices/in_Declined0001/void"), true);
  declined = false;
  mails.length = 0;
  is("made", await switchYearly(store, token, "sub_Dana00000001", preview.preview.at, TEST_CONSENT), { ok: true, title: "Supper Club" });
  const update = calls.filter((c) => c.path === "/subscriptions/sub_Dana00000001" && c.body.get("items[0][price]")).at(-1)!.body;
  is("the yes is kept on the subscription with the charge itself", update.get("metadata[dc]"), consentMetaValue(TEST_CONSENT, "membership"));
  is("at the preview's second, charged at once", [update.get("items[0][price]"), update.get("proration_date"), update.get("payment_behavior")], ["price_Yearly000001", String(preview.preview.at), "pending_if_incomplete"]);
  const record = calls.filter((c) => c.path === "/subscriptions/sub_Dana00000001" && c.body.get("metadata[every]")).at(-1)!.body;
  is("recorded as a membership bought yearly says it", record.get("metadata[every]"), "year");
  const receipt = mails.find((m) => [m.to].flat()[0] === "dana@example.com")!;
  const note = mails.find((m) => [m.to].flat()[0] === OWNER)!;
  is("the member's receipt", [receipt.subject, receipt.text.includes("Charged today: $193.33"), receipt.text.includes("From now on: $200 a year.")], ["You now pay yearly for Supper Club", true, true]);
  is("the creator's note", [note.subject, note.text.includes("from $20 a month to $200 a year")], ["A member now pays yearly for Supper Club", true]);

  part("The emailed link opens this one move and nothing else");
  const offer = await mintYearlyLink(store, "cus_Dana000001", "sub_Dana00000001");
  is("this membership", (await grantFor(store, offer, "sub_Dana00000001"))?.emailed, true);
  is("not another", await grantFor(store, offer, "sub_Other0000001"), null);
  is("and not the member's page", await membershipsFor(store, offer), null);

  part("J: unreadable yearly preview is not zero");
  jPreviewUnknown=true;
  const unknownPreview=await previewYearly(store,offer,"sub_Dana00000001");
  const unknownHtml=await new Response(await renderToReadableStream(await SwitchPage({params:Promise.resolve({handle:"@harbor"}),searchParams:Promise.resolve({token:offer,sub:"sub_Dana00000001",to:YEARLY_TARGET,from:"offer"})}))).text();
  is("unknown yearly preview refuses to certify a zero amount",unknownPreview.ok,false);
  is("unknown yearly preview never says nothing is charged today",unknownHtml.includes(membershipWords("en").nothingToday),false);
  const priorCharges=calls.filter(c=>c.method==="POST"&&c.body.has("items[0][price]")).length;
  const chargedAfterUnknown=await switchYearly(store,offer,"sub_Dana00000001",unknownPreview.ok?unknownPreview.preview.at:Math.floor(Date.now()/1000),TEST_CONSENT);
  is("yearly valid-consent control reaches one charging update",[chargedAfterUnknown.ok,calls.filter(c=>c.method==="POST"&&c.body.has("items[0][price]")).length-priorCharges],[true,1]);
  jPreviewUnknown=false;
  jPreviewPartial = true;
  const partialPreview = await previewYearly(store, offer, "sub_Dana00000001");
  const partialHtml = await new Response(await renderToReadableStream(await SwitchPage({params:Promise.resolve({handle:"@harbor"}),searchParams:Promise.resolve({token:offer,sub:"sub_Dana00000001",to:YEARLY_TARGET,from:"offer"})}))).text();
  jPreviewPartial = false;
  is("yearly lines said to go on (has_more) never say nothing is charged today", [partialPreview.ok, partialHtml.includes(membershipWords("en").nothingToday)], [false, false]);
  part("The email");
  is("refused without an address", (await setYearlyAsk(OWNER, { on: true, address: "" })).ok, false);
  is("saved with one", (await setYearlyAsk(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" })).ok, true);
  store = (await storeForEmail(OWNER))!;
  subs = [
    member("sub_Ana000000001", "cus_Ana0000001", "ana@example.com"),
    // Did not agree to hear from the creator.
    member("sub_Ben000000001", "cus_Ben0000001", "ben@example.com"),
    // Joined three weeks ago.
    member("sub_Cy0000000001", "cus_Cy00000001", "cy@example.com", { start_date: NOW - 21 * DAY }),
    // A discount.
    member("sub_Dee000000001", "cus_Dee0000001", "dee@example.com", { discounts: ["di_Dee"] }),
  ];
  for (const email of ["ana@example.com", "cy@example.com", "dee@example.com"]) {
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer", productId: product, title: "Supper Club" }, ROOM);
  }
  mails.length = 0;
  is("sent to the one it fits", [await askStore(store, Date.now() + 20_000), mails.map((m) => [m.to].flat()[0])], [1, ["ana@example.com"]]);
  const mail = mails[0];
  is(
    "what they pay, what a year costs and saves, the link to this one move, the list's footer",
    [
      mail.subject,
      mail.text.includes("You pay $20 a month for Supper Club. Harbor Kitchen also offers it yearly: $200 a year. That is $40 less than twelve monthly payments"),
      new RegExp(`/manage/switch\\?token=[0-9a-f]{64}&sub=sub_Ana000000001&to=${YEARLY_TARGET}&from=offer`).test(mail.text),
      mail.text.includes("1 Main St, Portland, OR 97201"),
      /unsubscribe/i.test(mail.text),
    ],
    ["Supper Club: pay yearly and save $40", true, true, true, true],
  );
  await askStore(store, Date.now() + 20_000);
  is("once per membership", [mails.length, await yearlyAsksThisMonth(store)], [1, 1]);
  is("in the store's language", yearlyAskEmail({ storeName: "Harbor", title: "Club", monthly: "20 $ al mes", yearly: "200 $ al año", saving: "40 $", url: "u", language: "es" }).subject, "Club: paga al año y ahorra 40 $");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
