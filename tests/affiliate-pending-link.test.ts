/**
 * An affiliate link the checkout could not read (owner's decision 6, 9 November 2026).
 *
 * Before: attributionFor read the affiliate behind the visit's click with
 * replies taken on trust (readAffiliate, approvedByCode), and every checkout
 * route caught any failure as "no affiliate". A reply of an unknown shape, or
 * a read that failed, sold the order with no commission and no word to
 * anybody: the affiliate who brought the buyer was simply never paid.
 *
 * The owner's decision: the sale is charged and the affiliate is linked
 * afterwards. Held here, with the real code and a stubbed Redis:
 *
 *   - an unknown read never stops the sale and keeps the visit's click on the
 *     order as pending (metadata via_pending), with no share on it;
 *   - nothing is credited while it is pending, not even by a code or a bond;
 *   - a later read that answers credits the affiliate from then on, once,
 *     however many times the five-minute sweep sees the order;
 *   - past PENDING_LINK_SECONDS with no answer, the creator is told, once,
 *     and nothing is credited automatically after that;
 *   - a read that answers "nobody" keeps nothing pending;
 *   - a PayPal order carries the same mark and is decided at its hand-over.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_AFFILIATES, RECURRING_OPTIONS, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import {
  PENDING_LINK_SECONDS,
  notePayPalPendings,
  pendingNotice,
  VIA_PENDING_META,
  attributionFor,
  attributionOrPending,
  creditPayPalSale,
  noteSession,
  notePendingLinks,
  pendingChannel,
} from "@/lib/affiliates";
import { giveCode } from "@/lib/affiliate-codes";
import { REFUSED_TRIES } from "@/lib/refused-tries";
import { CONFIRM_WITHIN_SECONDS } from "@/lib/purchase-email";
import type { SendOutcome } from "@/lib/email";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_pending_only";
process.env.RESEND_API_KEY = "re_test_affiliate_pending_only";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";

// No real provider is reached: the email service is unavailable in this world (no reviewed fallback), so what the
// creator is told is held by its words (pendingNotice) and by the mark taken once before it is sent.
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

// Every reply passes through here, so a test can answer one command in a shape Redis never would.
const real = redis.pipeline.bind(redis);
let odd: ((command: (string | number)[]) => unknown) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const out = await real(commands);
  if (!odd) return out;
  return out.map((reply, i) => {
    const swapped = odd!(commands[i]);
    return swapped === undefined ? reply : swapped;
  });
}) as typeof redis.pipeline;

// What the email service answers, chosen by each check; every call is counted.
let answer: SendOutcome = "sent";
let sends = 0;
const send = async () => {
  sends += 1;
  return answer;
};

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", ...over });

const order = (id: string, email: string, meta: Record<string, string> = {}, created = NOW - 60, discounts: unknown[] = []) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "oven", product: "prod01", title: "Sourdough course", ...meta } as Record<string, string>,
  customer_details: { email },
  discounts,
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "oven", "Oven Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPendingLink1", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, days: 30 }));
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const codes = `nl:aff:${statsId}:codes`;
  const people = `nl:aff:${statsId}:people`;
  await redis.pipeline([
    ["HSET", people, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", codes, "ana", ANA],
    ["HSET", people, BEN, person(BEN, "ben@example.com", "ben")],
    ["HSET", codes, "ben", BEN],
  ]);
  const sales = async () => {
    const [flat] = await real([["HGETALL", `nl:aff:${statsId}:sales`]]);
    const out = new Map<string, { aff: string; rate: number; how: string }>();
    const list = (flat as string[]) ?? [];
    for (let i = 0; i + 1 < list.length; i += 2) out.set(list[i], JSON.parse(list[i + 1]) as { aff: string; rate: number; how: string });
    return out;
  };
  const cookie = viaCookieValue(undefined, "ana", NOW - 3_600);
  const mark = async (ref: string) => (await real([["GET", `nl:aff:pend:${statsId}:${ref}`]]))[0];
  const weirdCodes = (command: (string | number)[]) => (command[0] === "HGET" && command[1] === codes ? { not: "a reply" } : undefined);

  part("A read of an unknown shape at checkout: the sale goes on, the click is kept as pending");
  odd = weirdCodes;
  is("before: the old read took the strange reply for nobody, so the sale lost its affiliate", await attributionFor(store, "prod01", { via: cookie, session: undefined }).catch(() => "threw"), null);
  const unknown = await attributionOrPending(store, "prod01", { via: cookie, session: undefined });
  is("it answers instead of throwing, so the checkout opens and the buyer is charged", unknown.known, false);
  is("with the click it came from kept, marked pending", "pending" in unknown && typeof unknown.pending === "string" && unknown.pending.startsWith(`ana.${NOW - 3_600}`), true);
  is("which rides to Stripe on the checkout's channel metadata, and nothing else", Object.keys(pendingChannel(unknown)), [VIA_PENDING_META]);
  is("no share is set on the order while it is pending", "via" in pendingChannel(unknown) || "via_rate" in pendingChannel(unknown), false);
  odd = () => {
    throw new Error("the database could not be reached");
  };
  const failed = await attributionOrPending(store, "prod01", { via: cookie, session: undefined }).catch(() => "threw");
  is("a read that fails outright is pending too, never a lost sale", typeof failed === "object" && failed.known === false, true);
  odd = null;

  part("Known answers keep nothing pending");
  const known = await attributionOrPending(store, "prod01", { via: cookie, session: undefined });
  is("a read that answers credits at once, as before", known.known && known.via?.aff, ANA);
  is("and adds no pending mark", pendingChannel(known), {});
  const nobody = await attributionOrPending(store, "prod01", { via: viaCookieValue(undefined, "zed", NOW - 60), session: undefined });
  is("a code that belongs to nobody is a known nobody", [nobody.known, nobody.known && nobody.via], [true, null]);
  is("with nothing pending", pendingChannel(nobody), {});
  const none = await attributionOrPending(store, "prod01", { via: undefined, session: undefined });
  is("no click at all: nothing pending", [none.known, pendingChannel(none)], [true, {}]);

  part("While it is pending, nothing is paid");
  const pendingValue = "pending" in unknown ? unknown.pending : "";
  const sale = order("cs_pend1", "jo@example.com", { [VIA_PENDING_META]: pendingValue });
  odd = weirdCodes;
  let counts = await notePendingLinks(store, [sale], NOW);
  is("the sweep reads again and still cannot tell: it waits", counts.waiting, 1);
  is("no commission is written", (await sales()).has("cs_pend1"), false);
  // Regra 23: was mails.length 0; no email can leave this world, so the mark is what shows nobody was told.
  is("and the creator is not told yet, inside the window", [counts.told, await mark("cs_pend1")], [0, null]);
  odd = null;
  await giveCode(store, "promo_1PendBenCode0001", BEN);
  store = (await storeForEmail(OWNER))!;
  await noteSession(store, order("cs_pend1", "jo@example.com", { [VIA_PENDING_META]: pendingValue }, NOW - 60, [{ promotion_code: "promo_1PendBenCode0001" }]));
  is("a code or a bond never takes the sale while the click is still undecided", (await sales()).has("cs_pend1"), false);

  part("Confirmed later: the commission from then on, once");
  counts = await notePendingLinks(store, [sale], NOW + 300);
  is("the next read answers: credited", counts.credited, 1);
  const line = (await sales()).get("cs_pend1");
  is("to Ana, through her link, at the share the program holds now", [line?.aff, line?.how, line?.rate], [ANA, "click", 30]);
  await notePendingLinks(store, [sale], NOW + 600);
  await noteSession(store, sale);
  await notePendingLinks(store, [sale], NOW + 900);
  is("the sweep seeing it again writes nothing more: one line for one sale", [...(await sales()).keys()].filter((ref) => ref === "cs_pend1").length, 1);
  // Regra 23: was mails.length 0; the mark says the link was decided as credited, never told.
  is("and the creator is never told about a link that was confirmed", await mark("cs_pend1"), "credited");

  part("A pending read that answers nobody");
  await redis.pipeline([["HSET", people, BEN, person(BEN, "ben@example.com", "ben", { status: "removed" })]]);
  const gone = order("cs_pend2", "kai@example.com", { [VIA_PENDING_META]: `ben.${NOW - 600}~ben.${NOW - 600}~-` });
  counts = await notePendingLinks(store, [gone], NOW);
  is("an affiliate removed since: nothing credited, nothing waiting", [counts.none, counts.waiting, (await sales()).has("cs_pend2")], [1, 0, false]);
  const own = order("cs_pend3", "lu@example.com", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~${ANA}` });
  counts = await notePendingLinks(store, [own], NOW);
  is("the affiliate's own browser: nothing credited", [counts.none, (await sales()).has("cs_pend3")], [1, false]);

  part("Past the deadline with no answer: the creator is told, once");
  const late = order("cs_pend4", "mo@example.com", { [VIA_PENDING_META]: `ana.${NOW - 9_000}~ana.${NOW - 9_000}~-` }, NOW - PENDING_LINK_SECONDS - 120);
  odd = weirdCodes;
  // Regra 23: the email service is now handed in (send); "sent" is what makes the notice final.
  counts = await notePendingLinks(store, [late], NOW, undefined, undefined, send);
  is("still unknown past PENDING_LINK_SECONDS: told", counts.told, 1);
  // Regra 23: the three checks below read the email's words from pendingNotice, the one place tellPending takes them
  // from, and the mark it takes before sending; they were read off a stubbed Resend, which this world never reaches.
  is("the mark says told", await mark("cs_pend4"), "told");
  const notice = pendingNotice(store, "cs_pend4", late.metadata[VIA_PENDING_META], "unread");
  is("the email goes to the creator", notice.to, OWNER);
  is("naming the order and the affiliate code it came through", /cs_pend4/.test(notice.text) && /\bana\b/.test(notice.text), true);
  is("and saying no commission was counted on it", /not credited/.test(notice.subject) && /no commission/i.test(notice.text), true);
  odd = null;
  counts = await notePendingLinks(store, [late], NOW + 300, undefined, undefined, send);
  is("once told, a later read that answers credits nothing automatically", (await sales()).has("cs_pend4"), false);
  // Regra 23: was mails.length 1; told again would count here.
  is("and the creator is not told twice", [counts.told, await mark("cs_pend4")], [0, "told"]);
  is("the deadline leaves several of the sweep's five-minute passes, and ends well inside its day of re-reading", PENDING_LINK_SECONDS >= 30 * 60 && PENDING_LINK_SECONDS <= 12 * 3_600, true);

  part("A membership whose link could not be read");
  const member = (id: string) => ({ ...order(id, "sub@example.com", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-` }), mode: "subscription" });
  counts = await notePendingLinks(store, [member("cs_sub1")], NOW);
  is("a program that credits no renewals: nothing to credit, nobody told", [counts.none, counts.told, await mark("cs_sub1")], [1, 0, "none"]);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, recurring: RECURRING_OPTIONS.find((n) => n > 0) }));
  store = (await storeForEmail(OWNER))!;
  counts = await notePendingLinks(store, [member("cs_sub2")], NOW, undefined, undefined, send);
  is("one that does: its renewals cannot be credited afterwards, so the creator is told at once", [counts.told, await mark("cs_sub2")], [1, "told"]);
  is("and nothing is written as a sale", (await sales()).has("cs_sub2"), false);

  part("An email refused for certain: tried again at the next passes, REFUSED_TRIES at most, never credited");
  is("every try fits inside the day the sweep reads the order", PENDING_LINK_SECONDS + REFUSED_TRIES * 300 < CONFIRM_WITHIN_SECONDS, true);
  const refusedSale = order("cs_pend5", "ref@example.com", { [VIA_PENDING_META]: `ana.${NOW - 9_000}~ana.${NOW - 9_000}~-` }, NOW - PENDING_LINK_SECONDS - 120);
  answer = "refused";
  sends = 0;
  odd = weirdCodes;
  counts = await notePendingLinks(store, [refusedSale], NOW, undefined, undefined, send);
  is("refused: not told, and the notice stays due", [counts.told, await mark("cs_pend5")], [0, "tell:unread"]);
  odd = null;
  counts = await notePendingLinks(store, [refusedSale], NOW + 300, undefined, undefined, send);
  is("the next pass tries again, though the read answers now: never credited past the deadline", [sends, (await sales()).has("cs_pend5")], [2, false]);
  counts = await notePendingLinks(store, [refusedSale], NOW + 600, undefined, undefined, send);
  is("at REFUSED_TRIES refusals it stops, said in the counts", [sends, counts.untold, await mark("cs_pend5")], [REFUSED_TRIES, 1, "untold"]);
  await notePendingLinks(store, [refusedSale], NOW + 900, undefined, undefined, send);
  is("and is never tried again, nor credited", [sends, (await sales()).has("cs_pend5")], [REFUSED_TRIES, false]);
  answer = "refused";
  sends = 0;
  const thenSent = order("cs_pend6", "ref2@example.com", { [VIA_PENDING_META]: `ana.${NOW - 9_000}~ana.${NOW - 9_000}~-` }, NOW - PENDING_LINK_SECONDS - 120);
  await notePendingLinks(store, [thenSent], NOW, undefined, undefined, send);
  answer = "sent";
  counts = await notePendingLinks(store, [thenSent], NOW + 300, undefined, undefined, send);
  is("refused once, sent at the next pass: told, final", [counts.told, await mark("cs_pend6"), sends], [1, "told", 2]);

  part("An email whose send is not known is never sent again blindly");
  answer = "uncertain";
  sends = 0;
  const unsure = order("cs_pend7", "uns@example.com", { [VIA_PENDING_META]: `ana.${NOW - 9_000}~ana.${NOW - 9_000}~-` }, NOW - PENDING_LINK_SECONDS - 120);
  counts = await notePendingLinks(store, [unsure], NOW, undefined, undefined, send);
  is("uncertain: marked so, counted", [counts.uncertain, await mark("cs_pend7")], [1, "uncertain"]);
  await notePendingLinks(store, [unsure], NOW + 300, undefined, undefined, send);
  is("the next pass sends nothing and credits nothing", [sends, (await sales()).has("cs_pend7")], [1, false]);
  is("and the default sender is the repository's three-way one", /sendEmailOutcome/.test(readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8")), true);
  answer = "sent";

  part("A booking's lead, where the store pays per booked call");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, lead: { kind: "booking", cents: 500, hold: 30, daily: 10, budget: 50_000 } }));
  store = (await storeForEmail(OWNER))!;
  const callEnd = (NOW + 86_400) * 1000;
  const booking = order("cs_call1", "caller@example.com", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-`, kind: "call", start: String(callEnd - 1_800_000), end: String(callEnd) });
  odd = weirdCodes;
  await notePendingLinks(store, [booking], NOW, undefined, undefined, send);
  const leads = async () => JSON.stringify((await real([["HGETALL", `nl:aff:${statsId}:leads`]]))[0] ?? []);
  is("while the link is pending, no lead is written", (await leads()).includes("cs_call1"), false);
  odd = null;
  await notePendingLinks(store, [booking], NOW + 300, undefined, undefined, send);
  is("confirmed later, the booking's lead is written for the affiliate, as a link that read would have", (await leads()).includes("cs_call1") && (await leads()).includes(ANA), true);
  is("the book route still carries a lead only from a link that read", /lead: store\.affiliates\.lead\.kind === "booking" \? via\?\.aff \?\? null : null/.test(readFileSync(join(process.cwd(), "app/api/store/book/route.ts"), "utf8")), true);

  part("PayPal: the same mark, decided at the hand-over and by the sweep after it");
  const paid = (order: string, meta: Record<string, string>, at = NOW - 60) => ({
    store: "oven", order, capture: `CAP${order}`, email: "pp@example.com", product: "prod01", cents: 4_000, currency: "USD", at, handle: "oven", meta,
  });
  await creditPayPalSale(store, paid("PPORDER1", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-` }), "Sourdough course");
  const pp = (await sales()).get("paypal:PPORDER1");
  is("a pending PayPal order whose read answers is credited to the affiliate", [pp?.aff, pp?.rate], [ANA, 30]);
  // Regra 23: was "told at its hand-over"; an unknown read at the hand-over now waits for the sweep, as a Stripe
  // order does, and the creator is told past PENDING_LINK_SECONDS, with the same retries.
  const p2 = paid("PPORDER0000002", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-` });
  await real([["SET", `nl:ppsell:paid:${p2.order}`, JSON.stringify(p2)]]);
  odd = weirdCodes;
  await creditPayPalSale(store, p2, "Sourdough course", send);
  is("one still unknown at its hand-over is not credited, and waits", [(await sales()).has("paypal:PPORDER0000002"), await mark("paypal:PPORDER0000002")], [false, null]);
  await notePayPalPendings(store, NOW + 300, send);
  is("the sweep reads it again: still unknown, still waiting", [(await sales()).has("paypal:PPORDER0000002"), await mark("paypal:PPORDER0000002")], [false, null]);
  odd = null;
  await notePayPalPendings(store, NOW + 600, send);
  is("answered at a later pass: credited once", (await sales()).get("paypal:PPORDER0000002")?.aff, ANA);
  const p3 = paid("PPORDER0000003", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-` });
  await real([["SET", `nl:ppsell:paid:${p3.order}`, JSON.stringify(p3)]]);
  odd = weirdCodes;
  await creditPayPalSale(store, p3, "Sourdough course", send);
  answer = "refused";
  sends = 0;
  await notePayPalPendings(store, NOW + PENDING_LINK_SECONDS, send);
  is("past the deadline, refused: due again", [sends, await mark("paypal:PPORDER0000003")], [1, "tell:unread"]);
  answer = "sent";
  odd = null;
  await notePayPalPendings(store, NOW + PENDING_LINK_SECONDS + 300, send);
  is("sent at the next pass: told, and never credited", [sends, await mark("paypal:PPORDER0000003"), (await sales()).has("paypal:PPORDER0000003")], [2, "told", false]);
  await notePayPalPendings(store, NOW + PENDING_LINK_SECONDS + 600, send);
  is("and not tried again", sends, 2);

  part("Every checkout route keeps the sale and the pending click");
  for (const file of ["app/api/store/checkout/route.ts", "app/api/store/cart/route.ts", "app/api/store/book/route.ts", "app/api/store/paypal/checkout/route.ts"]) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    is(`${file}: reads through attributionOrPending`, /attributionOrPending\(/.test(source) && !/attributionFor\(/.test(source), true);
    is(`${file}: carries the pending click on the order`, /pendingChannel\(/.test(source), true);
  }
  const sweep = readFileSync(join(process.cwd(), "lib/checkout-sweep.ts"), "utf8");
  is("the five-minute sweep decides the pending links", /notePendingLinks\(/.test(sweep), true);
  is("and the PayPal ones", /notePayPalPendings\(/.test(sweep), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
