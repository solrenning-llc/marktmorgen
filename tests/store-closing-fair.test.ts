/**
 * A store closing fairly for the people who bought from it (queue item 307
 * [EC1], lib/closing-buyers-rules.ts), against stand-ins for Stripe (the
 * creator's account and ours) and the email sender. Nothing real is reached.
 *
 * What fails here:
 *   - a member charged between the end of the plan and the closing;
 *   - a membership still running after the closing;
 *   - an unused amount that is not the proportional one;
 *   - a refund made twice (twice pressed, pressed then the closing day, or
 *     after the creator refunded at Stripe);
 *   - a buyer not told at least seven days before the closing;
 *   - a store started again that is charged for the days between, keeps its
 *     members held, or refunds anyone;
 *   - a hold that failed and was not tried again, or a notice that went out
 *     before the hold was in place;
 *   - a refund the creator's balance did not cover that was made anyway, or
 *     whose member was not told;
 *   - an email past the closing's cap, or a store that closes while its
 *     buyers could not be told (no company postal address).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { type Hands, closeOne, closingOf, closingLetter } from "@/lib/plan-closing";
import { CLOSING_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import {
  BUYER_NOTICE_DAYS,
  CLOSING_ACCESS_SENTENCE,
  EMAILS_PER_BUYER_PER_ENDING,
  buyerNoticeCap,
  holdBody,
  membershipLineOf,
  releaseBody,
  stillToGive,
  unusedOf,
} from "@/lib/closing-buyers-rules";
import { HELD_INDEX, inClosingDay, paidPeriods, releaseRestarted, startCallBudget } from "@/lib/closing-holds";
import { creditKey } from "@/lib/closing-credit";
import { tellStaysOpen } from "@/lib/closing-buyers";
import { giveBackUnused, reviewMark, unusedRows } from "@/lib/closing-refunds";
import { companyPostal } from "@/lib/company-postal";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { addProduct, setProductLink, setProductShipping } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { PLAN_PRICES } from "@/lib/plan";
import { parseShipping } from "@/lib/shipping";
import { confirmationFor, offerConfirmationFor } from "@/lib/purchase-email";

const DAY = 86_400_000;
const S = (ms: number) => Math.floor(ms / 1000);
const POSTAL = "100 Example Street, Example City, NY 10001, United States";

// ------------------------------------------------------------------ Stripe, the creator's account

type Sub = Record<string, unknown> & {
  id: string;
  status: string;
  metadata: Record<string, string>;
  pause_collection: { behavior: string; resumes_at?: number } | null;
  pe: number;
  amount: number;
  /** An invoice issued before the hold and not paid yet: Stripe retries it unless it is voided. */
  open?: { id: string; amount: number; status: "open" | "void" | "paid" };
  /** A credit for a plan changed mid-period, on the paid invoice beside the membership's own line. */
  proration?: number;
  /** Always refused: a membership Stripe never lets us pause. */
  stuck?: boolean;
  /** A coupon on the membership's line, in cents off. */
  discount?: number;
  /** The latest paid invoice holds only a proration; the membership's own is the one before. */
  prorationOnlyLast?: boolean;
  /** A draft invoice, and whether Stripe would finalize it by itself. */
  draft?: { id: string; auto_advance: boolean; metadata: Record<string, string> };
};
type Charge = { amount: number; amount_refunded: number; disputed: boolean };

const world = {
  subs: new Map<string, Sub>(),
  sessions: [] as Record<string, unknown>[],
  /** One-off payments, each naming its store in its metadata (what the buyers' search finds). */
  payments: [] as Record<string, unknown>[],
  searches: 0,
  charges: new Map<string, Charge>(),
  refunds: [] as { id: string; payment_intent: string; amount: number; status: string; metadata: Record<string, string> }[],
  balance: 1_000_000,
  /** The currency the creator's account settles in, and what a dollar becomes in it. */
  settles: "usd",
  rate: 1,
  /** Payments taken from members, by subscription: what must never happen while held. */
  charged: [] as { sub: string; at: number }[],
  failHolds: 0,
  writes: [] as { method: string; path: string; body: string }[],
  /** Plans on our own account that Stripe's list shows at once and its search does not show yet (its index lags). */
  plans: [] as Record<string, unknown>[],
};

const lengthOf = (sub: Sub) => (sub.metadata.yearly ? 365 : 30) * 86_400;

function subscriptionOf(sub: Sub) {
  return { ...sub, customer: { id: `cus_${sub.id.slice(4)}`, email: `${sub.id.slice(4)}@buyers.example.com` } };
}

/** The member's last paid invoice: its membership line, and a proration credit beside it when it has one. */
function paidInvoiceOf(sub: Sub) {
  const id = sub.id.slice(4);
  const lines = [
    ...(sub.proration ? [{ type: "invoiceitem", proration: true, amount: -sub.proration, discount_amounts: [] as { amount: number }[], period: { start: sub.pe - lengthOf(sub) - 86_400 * 10, end: sub.pe - lengthOf(sub) } }] : []),
    { type: "subscription", proration: false, amount: sub.amount, discount_amounts: sub.discount ? [{ amount: sub.discount }] : [], period: { start: sub.pe - lengthOf(sub), end: sub.pe } },
  ];
  const paid = lines.reduce((sum, line) => sum + line.amount - line.discount_amounts.reduce((a, d) => a + d.amount, 0), 0);
  return { id: `in_${id}`, status: "paid", amount_paid: paid, subtotal: paid, total: paid, currency: "usd", payment_intent: `pi_${id}`, lines: { data: lines } };
}

/** The member's paid invoices, newest first: a proration-only one on top when it has one. */
function paidInvoicesOf(sub: Sub) {
  const own = paidInvoiceOf(sub);
  if (!sub.prorationOnlyLast) return [own];
  return [{ id: `in_${sub.id.slice(4)}pr`, status: "paid", amount_paid: 300, subtotal: 300, total: 300, currency: "usd", payment_intent: `pi_${sub.id.slice(4)}pr`, lines: { data: [{ type: "invoiceitem", proration: true, amount: 300, period: { start: sub.pe - 86_400, end: sub.pe } }] } }, own];
}

/** Stripe renews every membership whose period is over by `at`, and retries an open invoice: one with collection paused gets a voided invoice, any other is charged. */
function renewUntil(at: number) {
  for (const sub of world.subs.values()) {
    if (sub.open?.status === "open" && ["active", "past_due"].includes(sub.status)) {
      world.charged.push({ sub: sub.id, at: S(at) });
      sub.open.status = "paid";
    }
    while (["active", "trialing", "past_due"].includes(sub.status) && sub.pe <= S(at)) {
      const paused = sub.pause_collection && !(sub.pause_collection.resumes_at && sub.pause_collection.resumes_at <= sub.pe);
      if (!paused) world.charged.push({ sub: sub.id, at: sub.pe });
      sub.pe += lengthOf(sub);
    }
  }
}

const sent: { to: string; subject: string; text: string; html?: string; reply_to?: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    type One = { to: string | string[]; subject: string; text?: string; html?: string; reply_to?: string };
    const body = JSON.parse(String(init?.body)) as One | One[];
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ to: [m.to].flat()[0], subject: m.subject, text: m.text ?? "", html: m.html, reply_to: m.reply_to });
    return json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const account = new Headers(init?.headers).get("stripe-account") ?? "";
  const path = url.pathname.replace(/^\/v1/, "");
  const form = new URLSearchParams(String(init?.body ?? ""));
  if (method !== "GET") world.writes.push({ method, path, body: method === "DELETE" ? "DELETE" : String(init?.body ?? "") });
  // Our own account: the store's plan, which has ended.
  if (!account) {
    const plan = world.plans.find((row) => path === `/subscriptions/${String(row.id)}`);
    if (plan) return json(plan);
    // Search deliberately lags the platform plan list in this journey.
    // Match its endpoint before the generic single-subscription fallback.
    if (path === "/subscriptions/search" && method === "GET") return json({ object: "search_result", data: [], has_more: false, next_page: null });
    if (path.startsWith("/subscriptions/")) return json({ id: path.split("/").pop(), status: "canceled", items: { data: [] } });
    if (path === "/subscriptions" && method === "GET") {
      const customer = url.searchParams.get("customer");
      return json({ object: "list", data: world.plans.filter((row) => (row.customer as { id: string }).id === customer && (url.searchParams.get("status") === "all" || row.status !== "canceled")), has_more: false });
    }
    return json({ object: "list", data: [], has_more: false });
  }
  if (path === "/subscriptions/search") {
    const query = url.searchParams.get("query") ?? "";
    const all = [...world.subs.values()].filter((s) => query.includes(`'${s.metadata.store}'`));
    const from = Number(url.searchParams.get("page") ?? 0);
    const page = all.slice(from, from + 100);
    const more = from + 100 < all.length;
    return json({ object: "search_result", data: page.map(subscriptionOf), has_more: more, next_page: more ? String(from + 100) : null });
  }
  if (path === "/invoices" && method === "GET") {
    const row = world.subs.get(url.searchParams.get("subscription") ?? "");
    const status = url.searchParams.get("status");
    if (!row) return json({ object: "list", data: [], has_more: false });
    if (status === "paid") return json({ object: "list", data: paidInvoicesOf(row).slice(0, Number(url.searchParams.get("limit") ?? 10)), has_more: false });
    if (status === "draft") return json({ object: "list", data: row.draft ? [{ id: row.draft.id, status: "draft", auto_advance: row.draft.auto_advance, metadata: row.draft.metadata }] : [], has_more: false });
    if (status === "open") return json({ object: "list", data: row.open?.status === "open" ? [{ id: row.open.id, status: "open" }] : [], has_more: false });
    return json({ object: "list", data: [], has_more: false });
  }
  const drafted = path.match(/^\/invoices\/(in_\w+)$/);
  if (drafted && method === "POST") {
    const row = [...world.subs.values()].find((s) => s.draft?.id === drafted[1]);
    if (row?.draft) {
      if (form.has("auto_advance")) row.draft.auto_advance = form.get("auto_advance") === "true";
      const mark = form.get("metadata[closing_draft]");
      if (mark !== null) {
        if (mark === "") delete row.draft.metadata.closing_draft;
        else row.draft.metadata.closing_draft = mark;
      }
    }
    return json({ id: drafted[1], status: "draft" });
  }
  const voided = path.match(/^\/invoices\/(in_\w+)\/void$/);
  if (voided) {
    const row = [...world.subs.values()].find((s) => s.open?.id === voided[1]);
    if (row?.open) row.open.status = "void";
    return json({ id: voided[1], status: "void" });
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "no such subscription" } }, 404);
    if (method === "GET") return json(subscriptionOf(row));
    if (method === "DELETE") {
      row.status = "canceled";
      return json(subscriptionOf(row));
    }
    if (form.has("pause_collection[behavior]") && (row.stuck || world.failHolds > 0)) {
      if (!row.stuck) world.failHolds -= 1;
      return json({ error: { type: "api_error", message: "a stand-in failure" } }, 500);
    }
    if (form.has("pause_collection") && form.get("pause_collection") === "") row.pause_collection = null;
    if (form.has("pause_collection[behavior]")) row.pause_collection = { behavior: String(form.get("pause_collection[behavior]")), ...(form.get("pause_collection[resumes_at]") ? { resumes_at: Number(form.get("pause_collection[resumes_at]")) } : {}) };
    for (const [name, value] of form) {
      const m = name.match(/^metadata\[(\w+)\]$/);
      if (m) {
        if (value === "") delete row.metadata[m[1]];
        else row.metadata[m[1]] = value;
      }
    }
    return json(subscriptionOf(row));
  }
  const intent = path.match(/^\/payment_intents\/pi_(\w+)$/);
  if (intent) {
    const row = world.subs.get(`sub_${intent[1]}`);
    const charge = world.charges.get(intent[1]) ?? { amount: row ? paidInvoiceOf(row).amount_paid : 0, amount_refunded: 0, disputed: false };
    world.charges.set(intent[1], charge);
    return json({ id: `pi_${intent[1]}`, latest_charge: { id: `ch_${intent[1]}`, currency: "usd", ...charge, balance_transaction: { amount: Math.round(charge.amount * world.rate), currency: world.settles } } });
  }
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: world.refunds.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
  if (path === "/refunds" && method === "POST") {
    const pi = String(form.get("payment_intent"));
    const amount = Number(form.get("amount"));
    const cost = Math.ceil(amount * world.rate);
    if (cost > world.balance) return json({ error: { code: "balance_insufficient", message: "not enough" } }, 400);
    world.balance -= cost;
    const charge = world.charges.get(pi.slice(3))!;
    charge.amount_refunded += amount;
    const refund = { id: `re_${world.refunds.length + 1}`, payment_intent: pi, amount, status: "succeeded", metadata: Object.fromEntries([...form].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) };
    world.refunds.push(refund);
    return json(refund);
  }
  if (path === "/payment_intents/search") {
    world.searches += 1;
    const query = url.searchParams.get("query") ?? "";
    const all = world.payments.filter((p) => query.includes(`'${(p.metadata as Record<string, string>).store}'`) && query.includes("status:'succeeded'"));
    const from = Number(url.searchParams.get("page") ?? 0);
    const more = from + 100 < all.length;
    return json({ object: "search_result", data: all.slice(from, from + 100), has_more: more, next_page: more ? String(from + 100) : null });
  }
  if (path === "/balance") return json({ object: "balance", available: [{ amount: world.balance, currency: world.settles }], pending: [] });
  if (path === "/checkout/sessions") {
    const after = url.searchParams.get("starting_after");
    const from = after ? world.sessions.findIndex((s) => s.id === after) + 1 : 0;
    const page = world.sessions.slice(from, from + 100);
    return json({ object: "list", data: page, has_more: from + 100 < world.sessions.length });
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };

const realNow = Date.now.bind(Date);
const clockAt = (ms: number) => {
  Date.now = () => ms;
};

let made = 0;
/** A store on a paid plan, connected to its own Stripe account, with members and buyers. */
async function storeWith(handle: string, options: { tier?: "creator" | "pro" | "scale"; trial?: boolean } = {}) {
  made += 1;
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}plan01`, active: true, tier: options.tier ?? "creator", cycle: "month", trialEnds: options.trial ? S(Date.now()) + 86_400 : 0 });
  await setStripeAccount(email, `acct_1Fair${String(made).padStart(10, "0")}`, true);
  return email;
}

function member(handle: string, id: string, amount: number, periodEnd: number, extra: Partial<Sub> = {}): Sub {
  const sub: Sub = { id: `sub_${id}`, status: "active", metadata: { store: handle }, pause_collection: null, pe: periodEnd, amount, ...extra };
  world.subs.set(sub.id, sub);
  world.sessions.push({ id: `cs_${id}`, status: "complete", payment_status: "paid", mode: "subscription", customer_details: { email: `${id}@buyers.example.com` }, metadata: { store: handle } });
  return sub;
}

function buyer(handle: string, id: string) {
  world.payments.push({ id: `pi_${id}${world.payments.length}`, status: "succeeded", receipt_email: `${id}@buyers.example.com`, metadata: { store: handle } });
}

async function ended(email: string) {
  await setSubscription(email, { active: false });
  return Date.parse((await storeForEmail(email))!.planEndedAt);
}

/** The daily job for one store, day by day from `from` to `to` (both days after the plan's end), with Stripe renewing between. */
async function daily(email: string, E: number, from: number, to: number) {
  const out: string[] = [];
  for (let d = from; d <= to; d += 1) {
    const at = E + d * DAY + 60_000;
    clockAt(at);
    const row = await closeOne(email, at, hands, Number.POSITIVE_INFINITY);
    out.push(`${d}:${row.state}${row.note ? `:${row.note}` : ""}`);
    // Stripe renews and retries until the next look.
    renewUntil(at + DAY - 120_000);
  }
  return out;
}

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.COMPANY_POSTAL_ADDRESS = POSTAL;

  part("The rules");
  const ps = S(Date.UTC(2026, 10, 1)), pe = S(Date.UTC(2027, 10, 1));
  const day = Date.UTC(2026, 11, 2);
  is("the unused part is the payment times the share of its period after the closing day, rounded", unusedOf({ amt: 36_500, ps, pe }, day), Math.round((36_500 * (pe - S(day))) / (pe - ps)));
  is("nothing for a period that ends by the closing day, or for nothing paid", [unusedOf({ amt: 1_000, ps, pe: S(day) }, day), unusedOf({ amt: 0, ps, pe }, day)], [0, 0]);
  is("never more than the payment, even for a period that starts after the day", unusedOf({ amt: 1_000, ps: S(day) + 10, pe: S(day) + 100 }, day), 1_000);
  is("what was refunded already is taken off, never below nothing", [stillToGive(900, 300), stillToGive(900, 900), stillToGive(900, 2_000)], [600, 0, 0]);
  is("a hold pauses collection with its invoices voided and no day to resume, and keeps a member's own pause", [...holdBody({ pause_collection: { behavior: "void", resumes_at: 2_000_000_000 }, metadata: {} }, 5)].map(([k, v]) => `${k}=${v}`), ["pause_collection[behavior]=void", "metadata[store_hold]=5", "metadata[hold_member_resumes]=2000000000"]);
  is("a release resumes collection, or puts a member's own pause back with its own day", [[...releaseBody({ metadata: { store_hold: "5" } }, 100)].map(([k, v]) => `${k}=${v}`), releaseBody({ metadata: { store_hold: "5", hold_member_resumes: "2000000000" } }, 100).get("pause_collection[resumes_at]")], [["metadata[store_hold]=", "metadata[hold_member_resumes]=", "pause_collection="], "2000000000"]);
  is("the fixed sentence says the access comes from the store and the notice is at least seven days", [CLOSING_ACCESS_SENTENCE.includes("provided by this store on Marktmorgen"), CLOSING_ACCESS_SENTENCE.includes(`at least ${BUYER_NOTICE_DAYS} days`), BUYER_NOTICE_DAYS >= WARN_WEEK_DAYS], [true, true, true]);
  is("a paid store's cap is two years of its plan's orders, a trial's is its orders", [buyerNoticeCap("creator", true), buyerNoticeCap("scale", false)], [200 * 24, 100]);

  part("A store whose plan ends: held, told, ended and settled");
  clockAt(Date.UTC(2026, 10, 2, 12));
  const anna = await storeWith("anna");
  const annaFolder = await storeFolder(anna);
  // A monthly member who renews in the closing days, a yearly member who paid for most of a year, one with their own pause, and a buyer of a download.
  member("anna", "monthly1", 2_000, S(Date.UTC(2026, 10, 10)));
  const yearly = member("anna", "yearly1", 24_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "anna", yearly: "1" } });
  member("anna", "paused1", 2_000, S(Date.UTC(2026, 10, 20)), { pause_collection: { behavior: "void", resumes_at: S(Date.UTC(2026, 10, 25)) }, metadata: { store: "anna", pause_from: String(S(Date.UTC(2026, 10, 20))) } });
  buyer("anna", "download1");
  const E = await ended(anna);
  const first = await daily(anna, E, 0, 0);
  is("on the day the plan ends every member is held, before the first notice goes out", [first[0], [...world.subs.values()].filter((s) => s.metadata.store === "anna").map((s) => [s.id, s.pause_collection?.behavior, s.metadata.store_hold === String(E)])], ["0:told:ended", [["sub_monthly1", "void", true], ["sub_yearly1", "void", true], ["sub_paused1", "void", true]]]);
  is("the member's own pause is kept to be put back", world.subs.get("sub_paused1")!.metadata.hold_member_resumes, String(S(Date.UTC(2026, 10, 25))));
  is("and their last payments are written down", [...(await paidPeriods((await storeForEmail(anna))!)).keys()].sort(), ["sub_monthly1", "sub_paused1", "sub_yearly1"]);
  const firstLetter = sent.filter((m) => m.to === anna)[0];
  const closesOn = new Date(E + CLOSING_DAYS * DAY).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  is("the first notice says members are not charged, buyers will be told, the refund that will be made and that a new plan keeps the store", [
    firstLetter.text.includes("none of your members is charged again"),
    firstLetter.text.includes("we email everyone who bought from it"),
    /1 member has paid for time after .*: \$/.test(firstLetter.text),
    firstLetter.text.includes("each is given back the unused part of their last payment"),
    firstLetter.text.includes(`Starting a plan again before ${closesOn}`),
  ], [true, true, true, true, true]);
  is("it names the exact last moment, in UTC, as the studio and the checkout count it, and no longer says a plan can be started until the day itself", [/Starting a plan again before [A-Z][a-z]+ \d{1,2}, \d{4},? (at )?\d{1,2}:\d{2}\s?[AP]M UTC keeps your store/.test(firstLetter.text), firstLetter.text.includes("On that day itself")], [true, false]);
  const run = await daily(anna, E, 1, CLOSING_DAYS - 1);
  is("between the plan's end and the closing no member is charged", world.charged.filter((c) => c.sub.startsWith("sub_")), []);
  is("the creator is told three times, the buyers once, at least seven days before", [sent.filter((m) => m.to === anna).length, run.filter((r) => r.includes(":told:")).map((r) => r.split(":").slice(2).join(":"))], [3, ["month", "week"]]);
  const notices = sent.filter((m) => m.to.endsWith("@buyers.example.com"));
  is("every buyer and member is told, once each", notices.map((m) => m.to).sort(), ["download1@buyers.example.com", "monthly1@buyers.example.com", "paused1@buyers.example.com", "yearly1@buyers.example.com"]);
  const closing = (await closingOf((await storeForEmail(anna))!, E + (CLOSING_DAYS - 1) * DAY))!;
  is("the closing day is at least seven days after the last buyer was told", [closing.buyers!.done, closing.day - closing.buyers!.by >= BUYER_NOTICE_DAYS * DAY], [true, true]);
  const yearlyNotice = notices.find((m) => m.to === "yearly1@buyers.example.com")!;
  is("a member's notice says their payments stopped and what they will be refunded, from Marktmorgen with its address, in text and in HTML", [
    yearlyNotice.text.includes("Your membership payments have stopped"),
    /\$[0-9,.]+ will be given back to you/.test(yearlyNotice.text),
    yearlyNotice.text.includes(POSTAL),
    (yearlyNotice.html ?? "").includes('lang="en"') && (yearlyNotice.html ?? "").includes(POSTAL),
    yearlyNotice.reply_to,
    /\b(hurry|last chance|only \d+ left|offer|discount)\b/i.test(yearlyNotice.text),
  ], [true, true, true, true, "anna@example.com", false]);
  is("no refund is made before the closing day", world.refunds.length, 0);
  const owed = unusedOf({ amt: 24_000, ps: yearly.pe - 365 * 86_400, pe: yearly.pe }, closing.day);

  // The creator presses the button for the yearly member only, then presses again.
  const annaStore = (await storeForEmail(anna))!;
  const rows = await unusedRows(annaStore, closing.day);
  is("the review lists each member who paid past the day, with the proportional amount", rows.map((r) => [r.sub, r.unused]), [["sub_yearly1", owed], ["sub_paused1", unusedOf({ amt: 2_000, ps: S(Date.UTC(2026, 10, 20)) - 30 * 86_400, pe: S(Date.UTC(2026, 10, 20)) }, closing.day)]].filter(([, n]) => Number(n) > 0));
  is("a screen drawn before something changed refunds nothing", await giveBackUnused(annaStore, closing.day, { mark: "0".repeat(64) }), "changed");
  const pressed = await giveBackUnused(annaStore, closing.day, { mark: reviewMark(rows) });
  const again = await giveBackUnused(annaStore, closing.day, { mark: reviewMark(await unusedRows(annaStore, closing.day)) });
  is("pressed twice, each member is refunded once, the proportional amount, from the creator's own account", [typeof pressed === "object" && pressed.done.map((d) => d.amount), typeof again === "object" && again.done.length, world.refunds.map((r) => [r.payment_intent, r.amount])], [rows.map((r) => r.unused), 0, rows.map((r) => [`pi_${r.sub.slice(4)}`, r.unused])]);

  const last = await daily(anna, E, CLOSING_DAYS, CLOSING_DAYS);
  is("on its day the store closes", last[0].split(":")[1], "removed");
  is("every membership ends at once, none left running", [...world.subs.values()].filter((s) => s.metadata.store === "anna").map((s) => s.status), ["canceled", "canceled", "canceled"]);
  is("and the closing day refunds nobody twice", world.refunds.length, rows.length);
  is("what it kept for the closing is let go", await redis.pipeline([["EXISTS", `nl:closing:paid:${annaFolder}`], ["EXISTS", `nl:closing:told:${annaFolder}`], ["EXISTS", creditKey(annaFolder)], ["ZSCORE", HELD_INDEX, anna]]), [0, 0, 0, null]);
  renewUntil(E + 400 * DAY);
  is("and nobody is charged after it either", world.charged.filter((c) => c.sub.startsWith("sub_")), []);

  part("On the closing day, what the creator did not refund is refunded for them, once");
  world.refunds.length = 0;
  const ben = await storeWith("ben");
  const benYear = member("ben", "benyear", 12_000, S(Date.UTC(2027, 8, 1)), { metadata: { store: "ben", yearly: "1" } });
  const benMonth = member("ben", "benmonth", 1_000, S(Date.UTC(2026, 11, 20)));
  const benDone = member("ben", "bendone", 6_000, S(Date.UTC(2027, 5, 1)), { metadata: { store: "ben", yearly: "1" } });
  clockAt(Date.UTC(2026, 10, 3, 12));
  const B = await ended(ben);
  await daily(ben, B, 0, CLOSING_DAYS - 1);
  // The creator refunded one member in full at Stripe, before the day.
  world.charges.set("bendone", { amount: 6_000, amount_refunded: 6_000, disputed: false });
  is("nothing is refunded before the day", world.refunds.length, 0);
  const benDay = (await closingOf((await storeForEmail(ben))!, B + (CLOSING_DAYS - 1) * DAY))!.day;
  await daily(ben, B, CLOSING_DAYS, CLOSING_DAYS);
  const unusedYear = unusedOf({ amt: 12_000, ps: benYear.pe - 365 * 86_400, pe: benYear.pe }, benDay);
  const unusedMonth = unusedOf({ amt: 1_000, ps: benMonth.pe - 30 * 86_400, pe: benMonth.pe }, benDay);
  is("on the day, each member's proportional part is refunded, once, and the one already refunded is not", world.refunds.map((r) => [r.payment_intent, r.amount, r.metadata.closing_refund]).sort(), [["pi_benmonth", unusedMonth, "in_benmonth"], ["pi_benyear", unusedYear, "in_benyear"]].filter(([, n]) => Number(n) > 0).sort());
  is("a refund twice is impossible: the next day refunds nothing", [(await daily(ben, B, CLOSING_DAYS + 1, CLOSING_DAYS + 1)).length, world.refunds.length], [1, [unusedYear, unusedMonth].filter((n) => n > 0).length]);
  void benDone;

  part("A balance that does not cover a refund: never made, the member told");
  world.refunds.length = 0;
  const cleo = await storeWith("cleo");
  member("cleo", "cleoyear", 30_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "cleo", yearly: "1" } });
  clockAt(Date.UTC(2026, 10, 4, 12));
  const Cl = await ended(cleo);
  await daily(cleo, Cl, 0, CLOSING_DAYS - 1);
  world.balance = 100;
  const before = sent.length;
  const cleoLast = await daily(cleo, Cl, CLOSING_DAYS, CLOSING_DAYS);
  const shortMail = sent.slice(before).filter((m) => m.to === "cleoyear@buyers.example.com");
  is("no refund is made and nothing is owed by Marktmorgen", [world.refunds.length, world.balance], [0, 100]);
  is("the member is emailed that it could not be made, with the creator's published contact and never their sign-in address", [shortMail.length, shortMail[0]?.subject, shortMail[0]?.text.includes("reply to this email"), shortMail[0]?.text.includes("cleo@example.com"), shortMail[0]?.reply_to, shortMail[0]?.text.includes("Marktmorgen does not hold the store's money")], [1, "Your refund from Cleo Shop could not be made", true, false, "cleo@example.com", true]);
  is("and the store still closes that day", cleoLast[0].split(":")[1], "removed");
  world.balance = 1_000_000;

  part("A plan started again before the closing: as it was, nothing charged for the days between, nobody refunded");
  world.refunds.length = 0;
  world.charged.length = 0;
  const dan = await storeWith("dan");
  const danMember = member("dan", "danmonth", 1_500, S(Date.UTC(2026, 10, 12)));
  const danPaused = member("dan", "danpaused", 1_500, S(Date.UTC(2026, 10, 15)), { pause_collection: { behavior: "void", resumes_at: S(Date.UTC(2027, 0, 15)) }, metadata: { store: "dan", pause_from: String(S(Date.UTC(2026, 10, 15))) } });
  clockAt(Date.UTC(2026, 10, 5, 12));
  const D = await ended(dan);
  await daily(dan, D, 0, CLOSING_DAYS - 3);
  const danNotices = sent.filter((m) => m.to.startsWith("dan") && m.to.endsWith("@buyers.example.com")).length;
  // The creator starts a plan again.
  await setSubscription(dan, { customerId: "cus_dan0001", subscriptionId: "sub_danplan02", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const restartAt = D + (CLOSING_DAYS - 2) * DAY;
  clockAt(restartAt);
  const released = await releaseRestarted(restartAt + 60_000, tellStaysOpen, restartAt);
  is("its members are let go", [released.find((r) => r.key === dan)?.state, danMember.pause_collection, danMember.metadata.store_hold], ["released", null, undefined]);
  is("a member's own pause is put back with its own day", danPaused.pause_collection, { behavior: "void", resumes_at: S(Date.UTC(2027, 0, 15)) });
  is("nothing is charged for the days between: voided while held, and no invoice is collected for them", world.charged.filter((c) => c.sub === "sub_danmonth" && c.at < S(restartAt)), []);
  const stays = sent.filter((m) => m.to.startsWith("dan") && m.subject === "Dan Shop is staying open");
  is("every buyer told it closes is told it stays, once", [danNotices, stays.length], [2, 2]);
  is("nobody is refunded", world.refunds.length, 0);
  is("and it leaves the line", await redis.pipeline([["ZSCORE", HELD_INDEX, dan]]), [null]);

  part("A hold that fails is tried again every day; the notices go anyway, with the count, and the store closes on its day");
  const eve = await storeWith("eve");
  member("eve", "evemonth", 1_000, S(Date.UTC(2026, 10, 30)));
  const stuck = member("eve", "evestuck", 1_000, S(Date.UTC(2026, 10, 30)), { stuck: true });
  clockAt(Date.UTC(2026, 10, 6, 12));
  const Ev = await ended(eve);
  world.failHolds = 1;
  const real = console.error;
  console.error = () => {};
  const tries = await daily(eve, Ev, 0, 1);
  const eveFirst = sent.filter((m) => m.to === eve)[0];
  is("the first notice goes on the first day, saying how many are not paused yet", [tries, eveFirst?.text.includes("2 memberships' payments are not paused yet: we try again every day")], [["0:told:ended", "1:waiting"], true]);
  is("the next day only the failure is tried again, and the one Stripe accepts is held", [world.subs.get("sub_evemonth")!.pause_collection?.behavior, stuck.pause_collection, world.writes.filter((w) => w.path === "/subscriptions/sub_evemonth" && w.body.includes("pause_collection")).length], ["void", null, 2]);
  const eveEnd = await daily(eve, Ev, 2, CLOSING_DAYS);
  console.error = real;
  is("one that never pauses does not keep the store from closing on its day, where it ends with the rest", [eveEnd.at(-1)?.split(":")[1], stuck.status], ["removed", "canceled"]);
  const eveNotice = (email: string) => sent.find((m) => m.to === email && m.subject.startsWith("Eve Shop closes on"))?.text ?? "";
  is("the member Stripe never let us pause is not told its payments stopped: it may be charged until the day", [eveNotice("evestuck@buyers.example.com").includes("Your membership payments have stopped"), eveNotice("evestuck@buyers.example.com").includes("you may still be charged until that day"), eveNotice("evemonth@buyers.example.com").includes("Your membership payments have stopped")], [false, true, true]);

  part("More than fifty pages of members: read a part a day, from where the last run stopped");
  const hal = await storeWith("hal", { tier: "scale" });
  for (let i = 0; i < 5_050; i += 1) world.subs.set(`sub_hal${String(i).padStart(5, "0")}`, { id: `sub_hal${String(i).padStart(5, "0")}`, status: "active", metadata: { store: "hal" }, pause_collection: null, pe: S(Date.UTC(2026, 11, 30)), amount: 500 });
  clockAt(Date.UTC(2026, 10, 9, 12));
  const H = await ended(hal);
  const halDays = await daily(hal, H, 0, 1);
  const halSubs = [...world.subs.values()].filter((s) => s.metadata.store === "hal");
  is("the first run reads fifty pages and waits; the next reads the rest and the notice goes", [halDays, halSubs.filter((s) => s.pause_collection?.behavior === "void").length], [["0:held:its members are not all reached yet", "1:told:ended"], 5_050]);
  for (const sub of halSubs) world.subs.delete(sub.id);

  part("An invoice issued before the hold is voided, never collected during it");
  const ivy = await storeWith("ivy");
  const ivyLate = member("ivy", "ivylate", 1_200, S(Date.UTC(2026, 10, 25)), { status: "past_due", open: { id: "in_ivyopen1", amount: 1_200, status: "open" } });
  clockAt(Date.UTC(2026, 10, 10, 12));
  const Iv = await ended(ivy);
  await daily(ivy, Iv, 0, 5);
  is("its open invoice is voided at the hold, and Stripe's retries never charge it", [ivyLate.open?.status, world.charged.filter((c) => c.sub === "sub_ivylate")], ["void", []]);

  part("The closing's calls to Stripe are capped before they are made; members past it are counted, never silent");
  const jo = await storeWith("joan");
  member("joan", "joanone", 1_000, S(Date.UTC(2026, 11, 1)));
  member("joan", "joantwo", 1_000, S(Date.UTC(2026, 11, 1)));
  clockAt(Date.UTC(2026, 10, 11, 12));
  const J = await ended(jo);
  // This ending's budget, set before any call as the daily job sets it, cut here to one member's worth (8 calls) to see the cap work.
  const joFolder = await storeFolder(jo);
  const { createHash } = await import("node:crypto");
  await startCallBudget(joFolder, 8);
  // Its emails, as the daily job sets them with the budget (lib/closing-credit.ts).
  await redis.pipeline([["SET", creditKey(joFolder), 100]]);
  await redis.pipeline([["SET", `nl:plan:closing:${createHash("sha256").update(jo).digest("hex").slice(0, 40)}`, JSON.stringify({ of: J, holdFrom: J })]]);
  console.error = () => {};
  await daily(jo, J, 0, 0);
  console.error = real;
  const joHeld = [...world.subs.values()].filter((s) => s.metadata.store === "joan" && s.pause_collection).length;
  const joNotice = sent.filter((m) => m.to === jo)[0];
  is("only what the budget covers is called, and the member past it is counted in the notice", [joHeld, joNotice?.text.includes("past this closing's limit")], [1, true]);
  console.error = () => {};
  await daily(jo, J, 1, CLOSING_DAYS);
  console.error = real;
  is("the member past the budget is still told the store closes, like the one held", [sent.some((m) => m.to === "joanone@buyers.example.com"), sent.some((m) => m.to === "joantwo@buyers.example.com")], [true, true]);
  const noticeTo = (email: string) => sent.find((m) => m.to === email && m.subject.startsWith("Joan Shop closes on"))?.text ?? "";
  is("the held member is told its payments stopped; the one past the budget, still charged, is told the truth instead", [
    noticeTo("joanone@buyers.example.com").includes("Your membership payments have stopped"),
    noticeTo("joantwo@buyers.example.com").includes("Your membership payments have stopped"),
    noticeTo("joantwo@buyers.example.com").includes("you may still be charged until that day"),
    noticeTo("joantwo@buyers.example.com").includes("asked to refund you"),
  ], [true, false, true, true]);

  part("A refund the balance did not cover is tried again when the creator adds funds; only the closing day makes it final");
  world.refunds.length = 0;
  const kit = await storeWith("kit");
  member("kit", "kityear1", 24_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "kit", yearly: "1" } });
  clockAt(Date.UTC(2026, 10, 12, 12));
  const K = await ended(kit);
  await daily(kit, K, 0, 10);
  const kitStore = (await storeForEmail(kit))!;
  const kitDay = (await closingOf(kitStore, K + 10 * DAY))!.day;
  world.balance = 50;
  const kitFolder = await storeFolder(kit);
  const budgetOf = async () => ((await redis.pipeline([["HMGET", `nl:closing:work:${kitFolder}`, "calls", "rcalls"]]))[0] as unknown[]).map(Number);
  const [kitCalls, kitReserve] = await budgetOf();
  const noFunds = await giveBackUnused(kitStore, kitDay, { mark: reviewMark(await unusedRows(kitStore, kitDay)) });
  const [kitCallsAfter, kitReserveAfter] = await budgetOf();
  is("a press that cannot refund takes only the two calls it made, from the budget, never the reserve", [kitCalls - kitCallsAfter, kitReserveAfter - kitReserve], [2, 0]);
  is("pressed without the funds: nothing refunded, and the member is still listed to try again", [typeof noFunds === "object" && noFunds.short.length, world.refunds.length, (await unusedRows(kitStore, kitDay)).length], [1, 0, 1]);
  world.balance = 1_000_000;
  const withFunds = await giveBackUnused(kitStore, kitDay, { mark: reviewMark(await unusedRows(kitStore, kitDay)) });
  is("pressed again after the funds came: refunded once", [typeof withFunds === "object" && withFunds.done.length, world.refunds.length], [1, 1]);
  is("the button's words say it can be tried again, not that it is final", readFileSync(join(process.cwd(), "components/closing-refunds-confirm.tsx"), "utf8").includes("press the button again. On the closing day they are tried once more"), true);

  part("A balance in another currency than the sale: weighed in the currency it settles in");
  world.refunds.length = 0;
  const lia = await storeWith("lia");
  member("lia", "liayear1", 24_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "lia", yearly: "1" } });
  clockAt(Date.UTC(2026, 10, 13, 12));
  const Li = await ended(lia);
  await daily(lia, Li, 0, 10);
  const liaStore = (await storeForEmail(lia))!;
  const liaDay = (await closingOf(liaStore, Li + 10 * DAY))!.day;
  const liaOwed = (await unusedRows(liaStore, liaDay))[0].unused;
  // The account settles in euros at 0.9 a dollar; it holds a few euros less than the refund costs.
  world.settles = "eur";
  world.rate = 0.9;
  world.balance = Math.ceil(liaOwed * 0.9) - 1;
  await giveBackUnused(liaStore, liaDay, { mark: reviewMark(await unusedRows(liaStore, liaDay)) });
  is("a euro balance a little short of the refund in euros: nothing refunded", world.refunds.length, 0);
  world.balance = Math.ceil(liaOwed * 0.9);
  await giveBackUnused(liaStore, liaDay, { mark: reviewMark(await unusedRows(liaStore, liaDay)) });
  is("enough euros: refunded in the sale's currency, the proportional amount", world.refunds.map((r) => r.amount), [liaOwed]);
  world.settles = "usd";
  world.rate = 1;
  world.balance = 1_000_000;

  part("Out of time: the refunds stop and say what is left, never pretend it is done");
  const max = await storeWith("maxine");
  member("maxine", "maxyear1", 24_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "maxine", yearly: "1" } });
  clockAt(Date.UTC(2026, 10, 14, 12));
  const Mx = await ended(max);
  await daily(max, Mx, 0, 2);
  const maxStore = (await storeForEmail(max))!;
  const maxDay = (await closingOf(maxStore, Mx + 2 * DAY))!.day;
  const late = await giveBackUnused(maxStore, maxDay, { until: Date.now() - 1 });
  is("with no time left, nothing is refunded and the row is counted as left", [typeof late === "object" && late.left, typeof late === "object" && late.done.length], [1, 0]);
  is("the route sets its own maxDuration and a time budget below it", [readFileSync(join(process.cwd(), "app/api/store/closing-refunds/route.ts"), "utf8").includes("export const maxDuration = 60"), readFileSync(join(process.cwd(), "app/api/store/closing-refunds/route.ts"), "utf8").includes("{ mark, until }")], [true, true]);

  part("Once its memberships ended at Stripe, a store closes: starting a plan does not bring it back");
  const ned = await storeWith("ned");
  member("ned", "nedmonth", 1_000, S(Date.UTC(2026, 11, 30)));
  buyer("ned", "nedbuyer");
  clockAt(Date.UTC(2026, 10, 15, 12));
  const N = await ended(ned);
  await daily(ned, N, 0, CLOSING_DAYS - 1);
  // The closing day starts, and its files cannot be removed today (a stand-in failure), so it is not done yet.
  const failing: Hands = { ...hands, remove: async () => { throw new Error("stand-in file store down"); }, list: async () => ["vault/x/y.pdf"] };
  console.error = () => {};
  clockAt(N + CLOSING_DAYS * DAY + 60_000);
  const half = await closeOne(ned, N + CLOSING_DAYS * DAY + 60_000, failing, Number.POSITIVE_INFINITY);
  console.error = real;
  is("the day began: its membership ended, the store not removed yet", [half.state, world.subs.get("sub_nedmonth")!.status], ["held", "canceled"]);
  await setSubscription(ned, { customerId: "cus_ned0001", subscriptionId: "sub_nedplan02", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const nedBefore = sent.length;
  await releaseRestarted(Date.now() + 60_000, tellStaysOpen, Date.now());
  is("no \"it stays open\" is sent: what its buyers paid for has ended", sent.slice(nedBefore).filter((m) => m.subject.includes("staying open")).length, 0);
  const next = await closeOne(ned, N + (CLOSING_DAYS + 1) * DAY, hands, Number.POSITIVE_INFINITY);
  is("and the next day the closing is seen through", next.state, "removed");

  part("A plan paid three minutes before the closing day, not in Stripe's search yet: the store is saved");
  const nina = await storeWith("nina");
  member("nina", "ninamonth", 1_000, S(Date.UTC(2027, 0, 30)));
  clockAt(Date.UTC(2026, 10, 15, 13));
  const Ni = await ended(nina);
  console.error = () => {};
  await daily(nina, Ni, 0, CLOSING_DAYS - 1);
  console.error = real;
  const ninaDay = (await closingOf((await storeForEmail(nina))!, Ni + (CLOSING_DAYS - 1) * DAY + 60_000))!.day;
  const paidAt = S(ninaDay) - 180;
  world.plans.push({ id: "sub_ninaplan02", object: "subscription", status: "active", created: paidAt, customer: { id: "cus_nina0001", email: nina }, metadata: { store: "nina", tier: "creator" }, cancel_at_period_end: false, items: { data: [{ quantity: 1, current_period_start: paidAt, current_period_end: paidAt + 30 * 86_400, price: { unit_amount: PLAN_PRICES.creator.month, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } });
  const ninaBefore = sent.length;
  const ninaWrites = world.writes.length;
  clockAt(ninaDay + 60_000);
  const saved = await closeOne(nina, ninaDay + 60_000, hands, Number.POSITIVE_INFINITY);
  is("the closing check reads Stripe's list by customer, so the plan keeps the store: it runs", [saved.state, (await storeForEmail(nina))?.subscriptionActive, (await storeForEmail(nina))?.subscriptionId], ["running", true, "sub_ninaplan02"]);
  is("nothing is refunded, its memberships are not ended and no closing letter goes", [world.writes.slice(ninaWrites).filter((w) => w.path === "/refunds" || w.body === "DELETE").length, world.subs.get("sub_ninamonth")!.status, sent.slice(ninaBefore).filter((m) => m.to === nina).length], [0, "active", 0]);
  world.plans.length = 0;

  part("A paid invoice with a proration: the membership's own line is what counts");
  world.refunds.length = 0;
  const ola = await storeWith("ola");
  const olaSub = member("ola", "olayear1", 12_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "ola", yearly: "1" }, proration: 3_000 });
  clockAt(Date.UTC(2026, 10, 16, 12));
  const O = await ended(ola);
  await daily(ola, O, 0, 0);
  const olaPaid = (await paidPeriods((await storeForEmail(ola))!)).get("sub_olayear1")!;
  is("the period and amount are the membership line's, not the credit's; the invoice's total caps any refund", [olaPaid.ps, olaPaid.pe, olaPaid.amt, olaPaid.tot], [olaSub.pe - 365 * 86_400, olaSub.pe, 12_000, 9_000]);
  is("and a line that is a proration is never taken for the membership", membershipLineOf({ lines: { data: [{ type: "invoiceitem", proration: true, amount: 500, period: { start: 1, end: 2 } }] }, subtotal: 500, total: 500 }), null);

  part("Addresses the cap does not cover are counted once each, however often they bought");
  const pat = await storeWith("pat", { trial: true });
  for (let i = 0; i < 100; i += 1) buyer("pat", `patx${String(i).padStart(3, "0")}`);
  for (let i = 0; i < 3; i += 1) {
    buyer("pat", "patrepeat");
    buyer("pat", "patrepeat");
  }
  clockAt(Date.UTC(2026, 10, 17, 12));
  const P = await ended(pat);
  await daily(pat, P, 0, CLOSING_DAYS - 1);
  is("one address past the cap, bought from six times, is one not told", (await closingOf((await storeForEmail(pat))!, P + (CLOSING_DAYS - 1) * DAY))!.buyers?.untold, 1);
  const patNotice = sent.find((m) => m.to === "patx000@buyers.example.com")!;
  is("a buyer's notice gives the creator's published way to reach them, never their sign-in address", [patNotice.text.includes("reply to this email"), patNotice.text.includes("pat@example.com"), patNotice.reply_to], [true, false, "pat@example.com"]);

  part("A coupon: the refund is of what was really paid, not the list price");
  world.refunds.length = 0;
  const qin = await storeWith("quinn");
  // $20 a month at 50% off: $10 paid. The closing day falls half-way through the period.
  clockAt(Date.UTC(2026, 10, 18, 12));
  const Q = await ended(qin);
  const qDay = Q + CLOSING_DAYS * DAY + 60_000;
  const qSub = member("quinn", "quinnhalf", 2_000, S(qDay) + 15 * 86_400, { discount: 1_000 });
  await daily(qin, Q, 0, 0);
  const qPaid = (await paidPeriods((await storeForEmail(qin))!)).get("sub_quinnhalf")!;
  is("the membership's worth is its line less the coupon, as a share of what was paid", [qPaid.amt, qPaid.tot], [1_000, 1_000]);
  is("half its period left is half of the $10 paid, never half of $20", unusedOf(qPaid, S(qDay) * 1000 >= 0 ? qDay : qDay), Math.round((1_000 * (qSub.pe - S(qDay))) / (30 * 86_400)));
  is("and the rule reads the coupon from the line", membershipLineOf({ lines: { data: [{ type: "subscription", proration: false, amount: 2_000, discount_amounts: [{ amount: 1_000 }], period: { start: 0, end: 30 } }] }, amount_paid: 1_000 })?.amt, 1_000);
  // A coupon on the membership's line only, beside a one-off line at full price: $20 less $10 off, and $10 more, $20 paid.
  // The membership is worth $10 of it; read without the coupon it would be $13.33.
  is("a coupon on the membership's line beside another line is taken off that line only", membershipLineOf({ lines: { data: [{ type: "subscription", proration: false, amount: 2_000, discount_amounts: [{ amount: 1_000 }], period: { start: 0, end: 30 } }, { type: "invoiceitem", proration: false, amount: 1_000, discount_amounts: [], period: { start: 0, end: 0 } }] }, amount_paid: 2_000 })?.amt, 1_000);

  part("The membership's own paid invoice is found behind a proration-only one");
  const rae = await storeWith("raelyn");
  member("raelyn", "raeyear1", 12_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "raelyn", yearly: "1" }, prorationOnlyLast: true });
  clockAt(Date.UTC(2026, 10, 19, 12));
  const Ra = await ended(rae);
  await daily(rae, Ra, 0, 0);
  const raePaid = (await paidPeriods((await storeForEmail(rae))!)).get("sub_raeyear1");
  is("looked back past the proration, in the same one call: its own line and payment are written down", [raePaid?.inv, raePaid?.amt], ["in_raeyear1", 12_000]);

  part("A draft kept at the hold goes on again when the plan starts again; voided invoices do not come back");
  const sam = await storeWith("samira");
  const samSub = member("samira", "samdraft1", 1_000, S(Date.UTC(2026, 11, 5)), { draft: { id: "in_samdraft1d", auto_advance: true, metadata: {} } });
  clockAt(Date.UTC(2026, 10, 20, 12));
  const Sm = await ended(sam);
  await daily(sam, Sm, 0, 0);
  is("at the hold the draft is kept as a draft, marked", [samSub.draft!.auto_advance, samSub.draft!.metadata.closing_draft], [false, String(Sm)]);
  await setSubscription(sam, { customerId: "cus_sam0001", subscriptionId: "sub_samplan02", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await releaseRestarted(Date.now() + 60_000, tellStaysOpen, Date.now());
  is("on the release it goes on as it was", [samSub.draft!.auto_advance, samSub.draft!.metadata.closing_draft], [true, undefined]);
  is("and the creator's letter says voided invoices do not come back", sent.filter((m) => m.to === sam)[0]?.text.includes("invoices we voided when your plan ended do not come back"), true);

  part("On the closing day with the budget spent, the refunds set aside at the hold are still made; with none left, the member is told");
  world.refunds.length = 0;
  const tia = await storeWith("tiago");
  member("tiago", "tiagoyear", 24_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "tiago", yearly: "1" } });
  member("tiago", "tiagonone", 24_000, S(Date.UTC(2027, 9, 1)), { metadata: { store: "tiago", yearly: "1" } });
  clockAt(Date.UTC(2026, 10, 21, 12));
  const T = await ended(tia);
  await daily(tia, T, 0, CLOSING_DAYS - 1);
  const tiaFolder = await storeFolder(tia);
  // Daily retries and everything else have spent the budget; and one member's reserve is gone too.
  await redis.pipeline([["HSET", `nl:closing:work:${tiaFolder}`, "calls", 0, "rcalls", 3]]);
  const tiaBefore = sent.length;
  console.error = () => {};
  const tiaLast = await daily(tia, T, CLOSING_DAYS, CLOSING_DAYS);
  console.error = real;
  const tiaUnmade = sent.slice(tiaBefore).filter((m) => m.subject === "Your refund from Tiago Shop was not made automatically");
  const tiaBalance = sent.slice(tiaBefore).filter((m) => m.subject === "Your refund from Tiago Shop could not be made");
  is("the reserve makes one refund; the member it does not cover is emailed, never left silent; the store closes", [world.refunds.length, tiaUnmade.length, tiaLast[0].split(":")[1]], [1, 1, "removed"]);
  is("and told honestly: not made automatically, never that the balance did not cover it, with what was left to give and the creator's contact", [tiaBalance.length, tiaUnmade[0]?.text.includes("balance"), /up to \$\d/.test(tiaUnmade[0]?.text ?? ""), tiaUnmade[0]?.text.includes("If Tiago Shop has not refunded it to you already")], [0, false, true, true]);

  part("Buyers are found by the store's own payments, a capped number of pages, and the rest counted, never waited on");
  const uma = await storeWith("uma", { trial: true });
  // A trial's cap is 100 buyers: buyerPagesCap(100) = 7 pages. 1,000 payments by 1,000 buyers is 10 pages.
  for (let i = 0; i < 1_000; i += 1) buyer("uma", `uma${String(i).padStart(4, "0")}`);
  world.payments.push({ id: "pi_someoneelse01", status: "succeeded", receipt_email: "other@buyers.example.com", metadata: { store: "another-store" } });
  clockAt(Date.UTC(2026, 10, 22, 12));
  const U = await ended(uma);
  const searchesBefore = world.searches;
  const umaDays = await daily(uma, U, 0, CLOSING_DAYS);
  const umaNotice = sent.filter((m) => m.to === uma).at(-1)!;
  is("it reads at most its cap of pages, then closes on its day with the rest counted", [world.searches - searchesBefore, umaDays.at(-1)?.split(":")[1], umaNotice.text.includes("more payments than this closing can read")], [7, "removed", true]);
  is("and never a payment of another store", sent.some((m) => m.to === "other@buyers.example.com"), false);

  part("On its closing day a store cannot be given a plan: the checkout refuses, and refuses when it cannot tell");
  const route = readFileSync(join(process.cwd(), "app/api/billing/checkout/route.ts"), "utf8");
  is("the plan checkout asks first, and a failure to ask is a refusal", [route.includes("store.planEndedAt ? await inClosingDay(ref).catch(() => true) : false"), route.includes('studio("billing=closing")')], [true, true]);
  const vic = await storeWith("victor");
  member("victor", "victormonth", 1_000, S(Date.UTC(2026, 11, 30)));
  clockAt(Date.UTC(2026, 10, 23, 12));
  const V = await ended(vic);
  await daily(vic, V, 0, CLOSING_DAYS - 1);
  console.error = () => {};
  clockAt(V + CLOSING_DAYS * DAY + 60_000);
  await closeOne(vic, V + CLOSING_DAYS * DAY + 60_000, { ...hands, remove: async () => { throw new Error("stand-in file store down"); }, list: async () => ["vault/x/y.pdf"] }, Number.POSITIVE_INFINITY);
  console.error = real;
  is("while its closing day runs, the checkout's question says so", await inClosingDay(vic), true);
  const vicClosing = await closingOf((await storeForEmail(vic))!);
  is("and the studio says it is closing today", [vicClosing?.today, readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8").includes('"Your store is closing today"')], [true, true]);

  part("The closing's emails are capped before any goes; none past the cap, never silent");
  const fay = await storeWith("fay", { trial: true });
  for (let i = 0; i < 103; i += 1) buyer("fay", `fay${String(i).padStart(3, "0")}`);
  clockAt(Date.UTC(2026, 10, 7, 12));
  const F = await ended(fay);
  await daily(fay, F, 0, CLOSING_DAYS - 1);
  const fayFolder = await storeFolder(fay);
  const fayTold = sent.filter((m) => m.to.startsWith("fay") && m.to.endsWith("@buyers.example.com")).length;
  const fayClosing = (await closingOf((await storeForEmail(fay))!, F + (CLOSING_DAYS - 1) * DAY))!;
  is("a store that never paid tells up to a trial's orders, and counts the rest for its creator", [fayTold, fayClosing.buyers?.untold, Number((await redis.pipeline([["GET", creditKey(fayFolder)]]))[0])], [100, 3, 100 * EMAILS_PER_BUYER_PER_ENDING - 100 * EMAILS_PER_BUYER_PER_ENDING]);
  is("the creator's last notice says how many and asks them to tell those buyers", sent.filter((m) => m.to === fay).at(-1)?.text.includes("3 addresses were not covered"), true);

  part("Without a company postal address no buyer is written to, and the store does not close");
  process.env.COMPANY_POSTAL_ADDRESS = "";
  is("there is no address in the code yet", companyPostal(), null);
  const gus = await storeWith("gus");
  buyer("gus", "gusbuyer");
  clockAt(Date.UTC(2026, 10, 8, 12));
  const G = await ended(gus);
  console.error = () => {};
  const gusDays = await daily(gus, G, 0, CLOSING_DAYS + 3);
  console.error = real;
  is("the buyers' notice waits, and so does the closing", [sent.some((m) => m.to === "gusbuyer@buyers.example.com"), gusDays.at(-1)], [false, `${CLOSING_DAYS + 3}:held:no company postal address for its buyers' notice`]);
  process.env.COMPANY_POSTAL_ADDRESS = POSTAL;

  part("What the creator's notices and studio say");
  const letter = closingLetter("ended", "Anna Shop", E, E + CLOSING_DAYS * DAY, E, { buyersBy: E + (CLOSING_DAYS - 7) * DAY, untold: 0, members: 1, unused: "$10" });
  is("the letter says the members' charges stopped, when buyers are told and the refund, from the first", [letter.text.includes("none of your members is charged again"), letter.text.includes("at least 7 days before your store closes"), letter.text.includes("1 member has paid for time after")], [true, true, true]);
  const studio = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  is("the studio says buyers are told and when, and leads to the review screen", [studio.includes("we email everyone who bought from it, once, from Marktmorgen"), studio.includes('"closing-refunds"')], [true, true]);
  const review = readFileSync(join(process.cwd(), "app/studio/closing-refunds/page.tsx"), "utf8");
  is("the review screen shows each amount before the one button, with a way back", [review.includes("<table"), review.includes("ClosingRefundsConfirm"), readFileSync(join(process.cwd(), "components/closing-refunds-confirm.tsx"), "utf8").includes("Go back without refunding")], [true, true, true]);
  is("the closing job lets restarted stores go every day", readFileSync(join(process.cwd(), "app/api/cron/closing/route.ts"), "utf8").includes("releaseRestarted(start + 12_000, tellStaysOpen)"), true);
  is("and the two notices before it are still the creator's", [WARN_MONTH_DAYS, WARN_WEEK_DAYS], [14, 7]);

  part("Before buying: the fixed sentence on every checkout of what lasts, and on the receipt");
  Date.now = realNow;
  const box = renderToStaticMarkup(createElement(DigitalConsentBox, { id: "dc-test", lang: "de" }));
  is("the box every paying checkout of something digital draws carries the sentence, marked as English, whatever the store's language", [box.includes(CLOSING_ACCESS_SENTENCE.replace(/'/g, "&#x27;")), box.includes('lang="en"')], [true, true]);
  // Every place a buyer pays for a course, a download, a private podcast, a community or a membership (tests/digital-consent.test.ts holds that each draws the box).
  const paths = ["components/store-product.tsx", "components/store-cart.tsx", "components/pick-bundle-form.tsx", "app/[handle]/course/[product]/page.tsx", "app/[handle]/renew/[product]/page.tsx", "app/[handle]/move/[product]/page.tsx", "app/[handle]/free/page.tsx", "app/[handle]/thanks/page.tsx"];
  is("every checkout path listed draws it", paths.filter((path) => !readFileSync(join(process.cwd(), path), "utf8").includes("<DigitalConsentBox")), []);
  is("and the creator cannot change or remove it: it is drawn by the code, from one constant", readFileSync(join(process.cwd(), "components/digital-consent-box.tsx"), "utf8").includes("{CLOSING_ACCESS_SENTENCE}"), true);
  const owner = "receipt@example.com";
  await claimHandle(owner, "receiptshop", "Receipt Shop", "");
  await setSubscription(owner, { customerId: "cus_Receipt0001", subscriptionId: "sub_Receipt0001", active: true });
  const pdf = await addProduct(owner, "Recipe pack", "", "27", null);
  const book = await addProduct(owner, "Printed cookbook", "", "35", null);
  if (!pdf.ok || !book.ok) throw new Error("no products");
  await setProductLink(owner, pdf.product.id, "https://example.com/pack");
  await setProductShipping(owner, book.product.id, parseShipping({ cents: 600, region: "na", note: "" })!);
  const shop = (await storeForEmail(owner))!;
  const digital = (await readProduct(shop, pdf.product.id))!;
  const physical = (await readProduct(shop, book.product.id))!;
  const paid = (product: string) => ({ id: `cs_test_${"f".repeat(24)}`, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 2700, currency: "usd", customer_details: { email: "buyer@example.com" }, metadata: { store: shop.handle, product } });
  is("the receipt of something that lasts says it; a shipped book's does not", [confirmationFor(shop, paid(digital.id) as never, Date.now() / 1000, [], [digital])?.text.includes(CLOSING_ACCESS_SENTENCE), confirmationFor(shop, paid(physical.id) as never, Date.now() / 1000, [], [physical])?.text.includes(CLOSING_ACCESS_SENTENCE)], [true, false]);
  const offer = (product: typeof digital) => offerConfirmationFor(shop, { reference: `pi_${"a".repeat(24)}`, parent: `cs_test_${"f".repeat(24)}`, product, email: "buyer@example.com", amountCents: 900, currency: "usd" });
  is("an offer taken after paying says it only for what lasts", [offer(digital)?.text.includes(CLOSING_ACCESS_SENTENCE), offer(physical)?.text.includes(CLOSING_ACCESS_SENTENCE)], [true, false]);
  is("the box links the limit to the exact place in the Terms, and the receipt gives its address", [box.includes('href="/terms#closing-members"'), confirmationFor(shop, paid(digital.id) as never, Date.now() / 1000, [], [digital])?.text.includes("Our Terms explain the limit: "), readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8").includes('id="closing-members"')], [true, true, true]);
  is("the Terms and the Refund policy no longer promise that no member is ever charged", [readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8").includes("A member we could not pause may"), readFileSync(join(process.cwd(), "app/refunds/page.tsx"), "utf8").includes("unless the store is past its closing&rsquo;s limit")], [true, true]);
  is("and the sentence states the limit, as the Terms do", [CLOSING_ACCESS_SENTENCE.includes("up to a limit set by its plan"), readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8").includes("we cannot promise that you are among those we")], [true, true]);
  const terms = readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8"), refunds = readFileSync(join(process.cwd(), "app/refunds/page.tsx"), "utf8"), privacy = readFileSync(join(process.cwd(), "app/privacy/page.tsx"), "utf8");
  is("the Terms, the Refund policy and the Privacy policy say it in plain words", [terms.includes("refunded automatically from the creator&rsquo;s own Stripe account"), refunds.includes("refunded to you automatically from the creator&rsquo;s"), privacy.includes('id="store-closing"'), terms.includes("never pays these refunds")], [true, true, true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
