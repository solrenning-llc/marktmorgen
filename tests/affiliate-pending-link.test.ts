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
import { NO_AFFILIATES, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import {
  PENDING_LINK_SECONDS,
  VIA_PENDING_META,
  attributionFor,
  attributionOrPending,
  creditPayPalSale,
  noteSession,
  notePendingLinks,
  pendingChannel,
} from "@/lib/affiliates";
import { giveCode } from "@/lib/affiliate-codes";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_pending_only";
process.env.RESEND_API_KEY = "re_test_affiliate_pending_only";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";

const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return answer({ id: `email_${mails.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

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
  metadata: { store: "oven", product: "prod01", title: "Sourdough course", ...meta },
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
  is("and the creator is not told yet, inside the window", mails.length, 0);
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
  is("and the creator is never told about a link that was confirmed", mails.length, 0);

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
  counts = await notePendingLinks(store, [late], NOW);
  is("still unknown past PENDING_LINK_SECONDS: told", counts.told, 1);
  is("one email, to the creator", mails.map((m) => m.to), [OWNER]);
  is("naming the order and the affiliate code it came through", /cs_pend4/.test(mails[0]?.text ?? "") && /\bana\b/.test(mails[0]?.text ?? ""), true);
  is("and saying no commission was paid on it", /not credited|no commission/i.test(mails[0]?.text ?? ""), true);
  odd = null;
  counts = await notePendingLinks(store, [late], NOW + 300);
  is("once told, a later read that answers credits nothing automatically", (await sales()).has("cs_pend4"), false);
  is("and the creator is not told twice", mails.length, 1);
  is("the deadline leaves several of the sweep's five-minute passes, and ends well inside its day of re-reading", PENDING_LINK_SECONDS >= 30 * 60 && PENDING_LINK_SECONDS <= 12 * 3_600, true);

  part("PayPal: the same mark, decided at the hand-over");
  const paid = (order: string, meta: Record<string, string>) => ({
    store: "oven", order, capture: `CAP${order}`, email: "pp@example.com", product: "prod01", cents: 4_000, currency: "USD", at: NOW - 60, handle: "oven", meta,
  });
  await creditPayPalSale(store, paid("PPORDER1", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-` }), "Sourdough course");
  const pp = (await sales()).get("paypal:PPORDER1");
  is("a pending PayPal order whose read answers is credited to the affiliate", [pp?.aff, pp?.rate], [ANA, 30]);
  odd = weirdCodes;
  await creditPayPalSale(store, paid("PPORDER2", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-` }), "Sourdough course");
  odd = null;
  is("one still unknown at its hand-over is not credited", (await sales()).has("paypal:PPORDER2"), false);
  is("and its creator is told", mails.length, 2);

  part("Every checkout route keeps the sale and the pending click");
  for (const file of ["app/api/store/checkout/route.ts", "app/api/store/cart/route.ts", "app/api/store/book/route.ts", "app/api/store/paypal/checkout/route.ts"]) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    is(`${file}: reads through attributionOrPending`, /attributionOrPending\(/.test(source) && !/attributionFor\(/.test(source), true);
    is(`${file}: carries the pending click on the order`, /pendingChannel\(/.test(source), true);
  }
  const sweep = readFileSync(join(process.cwd(), "lib/checkout-sweep.ts"), "utf8");
  is("the five-minute sweep decides the pending links", /notePendingLinks\(/.test(sweep), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
