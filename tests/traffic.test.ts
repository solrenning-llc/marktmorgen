/**
 * Visits to a store, counted and set against its plan
 * (lib/traffic-rules.ts, lib/traffic.ts, lib/traffic-billing.ts).
 *
 * Every page of a store that is opened costs us a little, and until this
 * was written nothing was set against it: a store on the smallest plan
 * could be sent a hundred thousand visits in a month, and a store with no
 * plan any number, both at our cost.
 *
 * What these hold, against stand-ins for Stripe and the email sender:
 *
 *   - a visit is one address on one day for one store, whatever it opens,
 *     and a new-style address is counted by its network;
 *   - the store's owner and a robot are never counted;
 *   - a store that pays is never rested, and is not even asked about;
 *   - a store with no plan to charge rests at the visits it has, and what
 *     its buyers have stays outside that;
 *   - visits past a plan's are put on the next invoice once, by the plan
 *     the store is on, and never twice;
 *   - a page sends the database no more commands than the cost of a visit
 *     is worked out with (tests/traffic-cost.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { offeredItems } from "@/lib/bundles";
import { readListings, readPage } from "@/lib/catalog";
import { monthKey } from "@/lib/delivery";
import { outOfKeys } from "@/lib/licence-keys";
import { PLAN_PRICES } from "@/lib/plan";
import { readAbout } from "@/lib/product-about";
import { withinLimit } from "@/lib/request-guard";
import { summaries, summaryOf } from "@/lib/reviews";
import { stockLeft } from "@/lib/stock";
import { addProduct, addStoreLink, claimHandle, setAffiliateSetting, setProductFile, setSubscription, storeFolder, storeForEmail, storeForHandle, storeForPage } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { MAX_FUNNEL_NAME, MAX_FUNNEL_PAGES, MAX_FUNNEL_SLUG } from "@/lib/page-funnel";
import { readPageFunnel } from "@/lib/page-funnel-store";
import { isResting, recordVisit, signalsShortWords, visitedFolders, visitsIn } from "@/lib/traffic";
import { directoryNumbers } from "@/lib/affiliate-directory";
import { HELP_SECTIONS } from "@/lib/help-content";
import { affiliateCookieName } from "@/lib/affiliates";
import { createHash } from "node:crypto";
import { answering } from "./security/next-headers";
import { firstWordOnVisits } from "@/lib/traffic-billing";
import {
  SETUP_VISITS,
  TRIAL_VISITS,
  VISITS_INCLUDED,
  VISIT_CENTS_PER_THOUSAND_OVER,
  BUYER_RESERVE_BPS,
  publicVisitLimit,
  countWords,
  SIGNALS_PER_VISIT,
  signalsWords,
  SIGNALS_SHORT_BEFORE,
  SIGNALS_SHORT_THIS_MONTH,
  SHARE_BATCH,
  clientDayShare,
  signalLimitFor,
  visitLimitFor,
  visitorAddress,
  visitsIncluded,
  visitsWords,
} from "@/lib/traffic-rules";
import { storeOf } from "@/lib/usage-billing";
import { DAY_FIELDS_MAX, LIFE_WRITE_MAX } from "@/lib/stats";
import { countHit, countVisit } from "@/lib/visit";
import { isSoon, soonProducts } from "@/lib/waitlist";
import { centsWords } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { COMMANDS, EVALS, EVAL_BYTES, PAGES_PER_VISIT, SIGNAL_READ_BYTES, STATIC_FILES, STORE_READS, visitCost } from "./traffic-cost";
import { POST as readRoute } from "@/app/api/store/read/route";
import { POST as hitRoute } from "@/app/api/store/hit/route";
import { NextRequest } from "next/server";
import { STORE_SCOPE, readToken } from "@/lib/page-read";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { addMonthsMs, allowanceWindow } from "@/lib/allowance-window";
import { REQUEST_COMMANDS } from "./plan-cost-registry";

/** A store's window at a moment (lib/allowance-window.ts): its billing month when it pays, the calendar month or its trial otherwise. */
const windowOf = (store: Parameters<typeof allowanceWindow>[0], at = Date.now()) => allowanceWindow(store, at)!.id;

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------ Stripe

type Line = { id: string; customer: string; subscription: string; amount: number; description: string; mark: string; created: number };
const lines: Line[] = [];
const keys = new Map<string, Line>();
const monthly: string[] = [];
/** up; down, nothing happens and nothing is answered; lost, the request is carried out and never answered. */
const stripe = "up" as "up" | "down" | "lost";
const stripeAsked: string[] = [];
/** What time it is at Stripe: the time of the run that is asking. */
let clock = Date.now();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin !== "https://api.stripe.com") return json({}, 404);
  const path = url.pathname.replace(/^\/v1/, "");
  stripeAsked.push(`${method} ${path}`);
  if (stripe === "down") throw new TypeError("fetch failed");
  const body = new URLSearchParams(String(init?.body ?? ""));
  if (path === "/invoiceitems" && method === "POST") {
    const key = (init?.headers as Record<string, string>)["Idempotency-Key"] ?? "";
    let line = keys.get(key);
    if (!line) {
      line = {
        id: `ii_${String(lines.length + 1).padStart(14, "0")}`,
        customer: body.get("customer") ?? "",
        subscription: body.get("subscription") ?? "",
        amount: Number(body.get("amount")),
        description: body.get("description") ?? "",
        mark: body.get("metadata[mark]") ?? "",
        created: Math.floor(clock / 1000),
      };
      if (body.get("currency") !== "usd" || !(line.amount > 0)) return json({ error: { code: "parameter_invalid" } }, 400);
      lines.push(line);
      if (key) keys.set(key, line);
    }
    if (stripe === "lost") throw new TypeError("fetch failed");
    return json({ id: line.id, amount: line.amount });
  }
  if (path === "/invoiceitems" && method === "GET") {
    const since = Number(url.searchParams.get("created[gte]") ?? "0");
    const found = lines.filter((l) => l.customer === url.searchParams.get("customer") && l.created >= since);
    return json({ data: found.map((l) => ({ id: l.id, amount: l.amount, metadata: { mark: l.mark } })), has_more: false });
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "POST") {
    if (body.get("pending_invoice_item_interval[interval]") === "month") monthly.push(sub[1]);
    return json({ id: sub[1] });
  }
  return json({ error: { code: "resource_missing" } }, 404);
}) as typeof fetch;

// ---------------------------------------------------------------- counting

/**
 * How many commands the database billed while something ran: each command
 * sent, and each one a script ran inside it. Upstash bills an EVAL as one
 * command plus one for every redis.call it runs
 * (https://upstash.com/docs/redis/overall/billing, read 31 October 2026);
 * until that day only what was sent was counted here, so a view's count,
 * held at 12, was billed up to 32 for a returning visitor (313 [CV1]). The stand-in counts what
 * lib/capped-count.ts runs inside (lib/redis-memory.ts, scriptCalls), and
 * scripts/test_capped_count_redis.py holds it to what a real server runs.
 */
let commands = 0;
/** Any other script a counted request sent: its inside is not counted here, so a visit must send none. */
const uncounted: string[] = [];
let measuring = false;
/**
 * The count scripts sent while something ran: each is sent whole, its bytes
 * moved through the database every time, priced in tests/traffic-cost.ts
 * (EVALS). The last measurement's, read after counted().
 */
let evals = 0;
/** Reads of a store's whole record (lib/store.ts, nl:store:owner:), priced by the byte in tests/traffic-cost.ts (STORE_READS). */
let records = 0;
/** Bytes the database answered with, other than the store's record (priced apart) and the count scripts' answers: the last measurement's. */
let replyBytes = 0;
/** Every write sent while something was measured, as sent: which commands went together. */
const sentPipelines: (string | number)[][][] = [];
const sizeOf = (value: unknown): number => (typeof value === "string" ? Buffer.byteLength(value) : Array.isArray(value) ? value.reduce((n: number, v) => n + sizeOf(v), 0) : 0);
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
  commands += list.length;
  for (const command of list) {
    if (command[0] === "GET" && String(command[1]).startsWith("nl:store:owner:")) records += 1;
    if (command[0] !== "EVAL") continue;
    if (String(command[1]).startsWith("-- marktmorgen:capped-count:")) evals += 1;
    else if (measuring) uncounted.push(String(command[1]).split("\n")[0]);
  }
  if (measuring) sentPipelines.push(list.map((command) => [...command]));
  const replies = await real(list);
  list.forEach((command, i) => {
    if (!(command[0] === "GET" && String(command[1]).startsWith("nl:store:owner:")) && command[0] !== "EVAL") replyBytes += sizeOf((replies as unknown[])[i]);
  });
  return replies;
}) as typeof redis.pipeline;
async function counted(work: () => Promise<unknown>): Promise<number> {
  commands = 0;
  evals = 0;
  records = 0;
  replyBytes = 0;
  const inside = redis.scriptCalls;
  measuring = true;
  try {
    await work();
  } finally {
    measuring = false;
  }
  return commands + redis.scriptCalls - inside;
}

/** The request a page's count arrives as. */
function asking(ip: string, userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", session = ""): never {
  const request = new Request("https://marktmorgen.com/api/store/hit", { method: "POST", headers: { "user-agent": userAgent, "x-forwarded-for": ip, "x-vercel-ip-country": "US" } });
  (request as unknown as { cookies: unknown }).cookies = { get: (name: string) => (name === SESSION_COOKIE && session ? { value: session } : undefined) };
  return request as never;
}

type Made = { email: string; handle: string; folder: string };

async function storeWith(handle: string, plan: "paid" | "trial" | "none" | "ended", tier: "creator" | "pro" | "scale" = "creator", cycle: "month" | "year" = "month"): Promise<Made> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, handle, "");
  if (plan !== "none") {
    await setSubscription(email, {
      customerId: `cus_${handle}0001`,
      subscriptionId: `sub_${handle}0001`,
      active: true,
      tier,
      cycle,
      trialEnds: plan === "trial" ? Math.floor(Date.now() / 1000) + 10 * 86_400 : 0,
      ...(plan === "paid" ? { period: paidPeriod() } : {}),
    });
    if (plan === "ended") await setSubscription(email, { active: false });
  }
  return { email, handle, folder: await storeFolder(email) };
}

/** Writes down a month's visits for a store, as lib/traffic.ts would have. */
async function visited(made: Made, month: string, visits: number): Promise<void> {
  await real([
    ["SET", `nl:traffic:n:${made.folder}:${month}`, visits],
    ["SADD", `nl:traffic:folders:${month}`, made.folder],
    ["SET", `nl:store:folder-owner:${made.folder}`, made.email],
  ]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("What a plan covers, and where a month's visits stop");
  is("a larger plan covers more", [VISITS_INCLUDED.creator < VISITS_INCLUDED.pro, VISITS_INCLUDED.pro < VISITS_INCLUDED.scale, visitsIncluded("pro")], [true, true, VISITS_INCLUDED.pro]);
  is("public pages rest at 95% of the figure, the rest kept for buyers' pages", [publicVisitLimit(VISITS_INCLUDED.creator), publicVisitLimit(VISITS_INCLUDED.pro), publicVisitLimit(SETUP_VISITS), BUYER_RESERVE_BPS], [Math.floor(VISITS_INCLUDED.creator * 0.95), Math.floor(VISITS_INCLUDED.pro * 0.95), Math.floor(SETUP_VISITS * 0.95), 500]);
  is("a figure that is not one rests everything", [publicVisitLimit(Number.NaN), publicVisitLimit(-5)], [0, 0]);
  is("in words", [visitsWords(0), visitsWords(1), visitsWords(4812.9), countWords(30000), centsWords(VISIT_CENTS_PER_THOUSAND_OVER)], ["0 visits", "1 visit", "4,812 visits", "30,000", "$0.50"]);
  // The old price past a plan: a visit's cost is more than 17.2% of it, the most a cost may be
  // of a price and still leave 60% after a 27.5% tax, which is why visits are no longer sold.
  is("the price visits were billed at did not keep the floor", (1000 * visitCost()) / (VISIT_CENTS_PER_THOUSAND_OVER / 100) > 0.172, true);


  part("Who a visitor is, for a day");
  is("an old-style address is itself", [visitorAddress("203.0.113.9"), visitorAddress(" 203.0.113.9 ")], ["203.0.113.9", "203.0.113.9"]);
  is("a new-style address is its network: one subscriber's every address is one visitor", [visitorAddress("2001:db8:85a3:1:8a2e:370:7334:1"), visitorAddress("2001:db8:85a3:1::2"), visitorAddress("2001:0DB8:85A3:0001:ffff:ffff:ffff:ffff")], ["2001:db8:85a3:1::/64", "2001:db8:85a3:1::/64", "2001:db8:85a3:1::/64"]);
  is("another network is another visitor", visitorAddress("2001:db8:85a3:2::2"), "2001:db8:85a3:2::/64");
  is("an old address written the new way is the old address", visitorAddress("::ffff:203.0.113.9"), "203.0.113.9");
  is("what is not an address is kept as it came, and nothing is one visitor", [visitorAddress("not:an:address"), visitorAddress("")], ["not:an:address", "unknown"]);

  part("A visit is one person, one day, one store");
  const ana = await storeWith("ana", "paid");
  const anaStore = (await storeForEmail(ana.email))!;
  // A paying store counts in its billing month (lib/allowance-window.ts): ten days into it, at two in the afternoon.
  const t0 = Math.floor((anaStore.period!.start * 1000 + 10 * DAY) / DAY) * DAY + 14 * 3_600_000;
  const month = windowOf(anaStore, t0);
  is("the first time somebody comes it is a visit", [await recordVisit(anaStore, "203.0.113.9", t0), await visitsIn(ana.folder, month)], [true, 1]);
  is("however many pages they open that day, it is the one", [await recordVisit(anaStore, "203.0.113.9", t0 + 60_000), await recordVisit(anaStore, "203.0.113.9", t0 + 5 * 3_600_000), await visitsIn(ana.folder, month)], [false, false, 1]);
  is("somebody else is another", [await recordVisit(anaStore, "198.51.100.7", t0), await visitsIn(ana.folder, month)], [true, 2]);
  is("every address of one new-style network is one visitor", [await recordVisit(anaStore, "2001:db8:1:2::a", t0), await recordVisit(anaStore, "2001:db8:1:2:ffff::b", t0), await recordVisit(anaStore, "2001:db8:1:2:1234:5678:9abc:def0", t0), await visitsIn(ana.folder, month)], [true, false, false, 3]);
  is("the next day the same person is a visit again", [await recordVisit(anaStore, "203.0.113.9", t0 + DAY), await visitsIn(ana.folder, month)], [true, 4]);
  const ben = await storeWith("ben", "paid");
  const benStore = (await storeForEmail(ben.email))!;
  is("and at another store, a visit to that store", [await recordVisit(benStore, "203.0.113.9", t0), await visitsIn(ben.folder, month), await visitsIn(ana.folder, month)], [true, 1, 4]);
  is("the stores visited in a month are known, and whose each is", [await visitedFolders(new Date(t0).toISOString().slice(0, 7)), (await storeOf(ana.folder))?.handle, (await storeOf(ben.folder))?.handle], [[ana.folder, ben.folder].sort(), "ana", "ben"]);
  // The day the billing month renews: the next one, which begins exactly there.
  const renewed = anaStore.period!.end * 1000 + 5 * 60_000;
  is("a visit belongs to the billing month of its moment", [await recordVisit(anaStore, "203.0.113.9", renewed), await visitsIn(ana.folder, windowOf(anaStore, renewed)), await visitsIn(ana.folder, month), windowOf(anaStore, renewed) !== month], [true, 1, 4, true]);
  const [kept] = await real([["SMEMBERS", `nl:traffic:day:${ana.folder}:${new Date(t0).toISOString().slice(0, 10)}`]]);
  is("what is kept of a visitor is a few letters, not their address", [(kept as string[]).length, (kept as string[]).every((member) => /^[0-9a-f]{16}$/.test(member))], [3, true]);

  part("Who is never counted");
  const anaNow = () => windowOf(anaStore);
  const before = await visitsIn(ana.folder, anaNow());
  await countVisit(asking("192.0.2.10", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), anaStore);
  is("a robot that says it is one", (await visitsIn(ana.folder, anaNow())) - before, 0);
  const session = await openSession(ana.email);
  await countVisit(asking("192.0.2.11", undefined, session), anaStore);
  is("the store's owner, looking at their own store", (await visitsIn(ana.folder, anaNow())) - before, 0);
  await countVisit(asking("192.0.2.12", undefined, await openSession(ben.email)), anaStore);
  is("somebody signed in who is not the owner is a visitor like any other", (await visitsIn(ana.folder, anaNow())) - before, 1);
  await countVisit(asking("192.0.2.13"), anaStore);
  is("and so is anybody else", (await visitsIn(ana.folder, anaNow())) - before, 2);

  part("Paid plans also have a finite visit threshold");
  const onScale = { ...anaStore, tier: "scale" as const };
  is("each paid plan is held to its published counted-visit threshold", [visitLimitFor(anaStore), visitLimitFor(onScale)], [VISITS_INCLUDED.creator, VISITS_INCLUDED.scale]);
  await visited(ana, anaNow(), 5_000_000);
  is("at five million visits its public pages rest", await isResting((await storeForEmail(ana.email))!), true);
  is("a paid store is checked with the same strict read", await counted(() => isResting(anaStore)), 1);
  await visited(ana, anaNow(), 2);

  part("A store with no plan to charge rests at the visits it has");
  const cyd = await storeWith("cyd", "none");
  const cydStore = (await storeForEmail(cyd.email))!;
  is("before a plan, and after one, it has a few hundred", [visitLimitFor(cydStore), SETUP_VISITS, SETUP_VISITS * 5 <= VISITS_INCLUDED.creator], [SETUP_VISITS, 500, true]);
  await visited(cyd, monthKey(), publicVisitLimit(SETUP_VISITS) - 1);
  is("one short of where public pages stop, its pages are open", await isResting(cydStore), false);
  await visited(cyd, monthKey(), publicVisitLimit(SETUP_VISITS));
  is("there, its public pages rest; buyers' pages go on to the whole figure", [await isResting(cydStore), await isResting(cydStore, Date.now(), "buyer")], [true, false]);
  await visited(cyd, monthKey(), SETUP_VISITS);
  is("at the whole figure, they rest too", await isResting(cydStore, Date.now(), "buyer"), true);
  is("which is asked in one read", await counted(() => isResting(cydStore)), 1);
  const dee = await storeWith("dee", "ended");
  const deeStore = (await storeForEmail(dee.email))!;
  await visited(dee, monthKey(), SETUP_VISITS + 40);
  is("a store whose plan ended is held to the same figure", [visitLimitFor(deeStore), await isResting(deeStore)], [SETUP_VISITS, true]);
  const eve = await storeWith("eve", "trial", "scale");
  const eveStore = (await storeForEmail(eve.email))!;
  is("a free trial has its own figure, whichever plan it is a trial of, no more than the smallest plan's", [visitLimitFor(eveStore), TRIAL_VISITS <= VISITS_INCLUDED.creator], [TRIAL_VISITS, true]);
  // A free trial is one window, from the day it began (lib/allowance-window.ts).
  await visited(eve, windowOf(eveStore), publicVisitLimit(TRIAL_VISITS) - 1);
  const open = await isResting(eveStore);
  await visited(eve, windowOf(eveStore), publicVisitLimit(TRIAL_VISITS));
  is("and rests there", [open, await isResting(eveStore)], [false, true]);
  await setSubscription(eve.email, { active: true, trialEnds: 0, period: paidPeriod() });
  is("a paid Scale plan starts its own billing month, below its own larger threshold", await isResting((await storeForEmail(eve.email))!), false);
  is("when the month turns, so are a resting store's", await isResting(cydStore, Date.now() + 40 * DAY), false);
  is("an acknowledged unused month remains open", await isResting({ ...cydStore, email: "nobody-with-visits@example.com" }), false);

  part("Visits past a plan are never billed: pages rest instead");
  const fay = await storeWith("fay", "paid", "creator");
  const now = Date.UTC(2026, 9, 20, 9, 30, 0);
  clock = now;
  await setSubscription(fay.email, { active: true, period: paidPeriod(now) });
  const fayStore = (await storeForEmail(fay.email))!;
  const fayMonth = windowOf(fayStore, now);
  await visited(fay, fayMonth, publicVisitLimit(VISITS_INCLUDED.creator) - 1);
  is("under 95% of the figure, every page is open", [await isResting(fayStore, now), await isResting(fayStore, now, "buyer")], [false, false]);
  await visited(fay, fayMonth, publicVisitLimit(VISITS_INCLUDED.creator));
  is("at 95%, public pages rest and buyers' pages stay open", [await isResting(fayStore, now), await isResting(fayStore, now, "buyer")], [true, false]);
  await visited(fay, fayMonth, VISITS_INCLUDED.creator);
  is("at the whole figure, buyers' pages rest too", await isResting(fayStore, now, "buyer"), true);
  is("and no line is put on any invoice for it", lines.length, 0);
  const gil = await storeWith("gil", "paid", "pro", "year");
  await setSubscription(gil.email, { active: true, period: { start: Math.floor(now / 1000) - 40 * 86_400, end: Math.floor(now / 1000) + 325 * 86_400, renews: true } });
  const gilStore = (await storeForEmail(gil.email))!;
  is("a yearly plan's month starts on the day of the month its year began", windowOf(gilStore, now), new Date(addMonthsMs(gilStore.period!.start * 1000, 1)).toISOString().slice(0, 10));
  await visited(gil, windowOf(gilStore, now), VISITS_INCLUDED.creator + 4000);
  is("the same visits on a larger plan are inside it", await isResting((await storeForEmail(gil.email))!, now), false);
  is("a creator is written to about a month once", [await firstWordOnVisits(fay.folder, "2026-12"), await firstWordOnVisits(fay.folder, "2026-12"), await firstWordOnVisits(fay.folder, "2027-01")], [true, false, true]);
  void eve; void cyd; void monthly; void stripe; void stripeAsked;

  part("What a page sends to the database is inside what a visit is costed at");
  const joy = await storeWith("joy", "paid");
  for (let i = 0; i < 26; i += 1) {
    const added = await addProduct(joy.email, `Product ${i}`, "", "19", null);
    if (added.ok) await setProductFile(joy.email, added.product.id, { pathname: `stores/${joy.folder}/${added.product.id}/f.pdf`, name: "f.pdf", bytes: 10, contentType: "application/pdf", addedAt: "2026-01-01T00:00:00.000Z" });
  }
  const drawFront = async () => {
    const store = (await storeForPage("joy"))!;
    await isResting(store);
    const ratings = store.reviewed ? summaries(store.statsId).catch(() => new Map()) : Promise.resolve(new Map());
    const { listings, related } = await readPage(store, 1);
    const bundles = offeredItems(store, [...listings, ...related]).catch(() => new Map());
    await Promise.all(listings.map((p) => Promise.all([stockLeft(store, p).catch(() => null), outOfKeys(store, p).catch(() => false)])));
    await ratings;
    await bundles;
    await soonProducts(store).catch(() => new Set());
    return listings;
  };
  const listings = await drawFront();
  // And the request the page is, counted in the store's window: priced apart (tests/plan-cost-registry.ts, public-requests).
  is("a full page of a store that pays is drawn in a few reads", [listings.length, (await counted(drawFront)) <= COMMANDS.frontPage + REQUEST_COMMANDS], [24, true]);
  const evalsSent = { page: [evals], front: [] as number[], later: [] as number[], read: [] as number[] };
  const recordsRead = { page: [records], front: [] as number[], later: [] as number[], read: [] as number[] };
  const countFront = async (ip: string) => {
    const store = (await storeForHandle("joy"))!;
    await withinLimit("hit", `${ip}|${store.handle}`, 120, 600);
    await countHit(asking(ip), store, { kind: "view", source: "instagram", medium: "", campaign: "" });
    await countVisit(asking(ip), store);
  };
  // Somebody before them this month: what a month's first visit writes
  // beside the count is written once in a hundred visits, not by each.
  await countFront("192.0.2.49");
  const firstView = await counted(() => countFront("192.0.2.50"));
  evalsSent.front.push(evals);
  recordsRead.front.push(records);
  const secondView = await counted(() => countFront("192.0.2.50"));
  evalsSent.front.push(evals);
  recordsRead.front.push(records);
  is("counting it a second time that day is inside the model", secondView <= COMMANDS.frontCount, true);
  is("and with what somebody new to the day adds, the whole view is too", firstView <= COMMANDS.frontCount + COMMANDS.firstOfDay, true);
  const product = listings[0];
  const drawLater = async () => {
    const store = (await storeForPage("joy"))!;
    await isResting(store);
    await readListings(store, [product.id]);
    await Promise.all([
      product.about ? readAbout(store.statsId, product.id) : Promise.resolve(""),
      stockLeft(store, product).catch(() => null),
      outOfKeys(store, product).catch(() => false),
      summaryOf(store.statsId, product.id).catch(() => null),
      isSoon(store, product.id).catch(() => false),
    ]);
  };
  is("a product's page is drawn inside it", (await counted(drawLater)) <= COMMANDS.laterPage + REQUEST_COMMANDS, true);
  evalsSent.page.push(evals);
  recordsRead.page.push(records);
  const countLater = async (ip: string) => {
    const store = (await storeForHandle("joy"))!;
    await withinLimit("hit", `${ip}|${store.handle}`, 120, 600);
    await countVisit(asking(ip), store);
    // A product's own page also counts its visitor for that product, once a day (lib/stats.ts).
    await countHit(asking(ip), store, { kind: "product", id: product.id });
  };
  // Somebody before them today: the product's first visitor of the day also gives the day's record its end, once.
  await countLater("192.0.2.52");
  const laterCount = await counted(() => countLater("192.0.2.51"));
  evalsSent.later.push(evals);
  recordsRead.later.push(records);
  is("and saying it was opened is too, with the product's own visitor", laterCount <= COMMANDS.laterCount, true);
  // The heaviest view (313 [CV1], 31 October 2026): a medium and a campaign
  // beside its source, nine counts in all (lib/stats.ts), with the day's
  // record already at its most fields and the all-time one near its own, so
  // the count script also asks which names are there (lib/capped-count.ts).
  const countTagged = async (ip: string) => {
    const store = (await storeForHandle("joy"))!;
    await withinLimit("hit", `${ip}|${store.handle}`, 120, 600);
    await countHit(asking(ip), store, { kind: "view", source: "newsletter", medium: "email", campaign: "fall" });
    await countVisit(asking(ip), store);
  };
  const joyStats = (await storeForHandle("joy"))!.statsId;
  const today = new Date().toISOString().slice(0, 10);
  // The keys lib/stats.ts counts a day's and the all-time record under.
  for (let i = 0; redis.run(["HLEN", `nl:stats:${joyStats}:${today}`]) as number < DAY_FIELDS_MAX; i += 1) redis.run(["HSET", `nl:stats:${joyStats}:${today}`, `f:${i}`, "1"]);
  for (let i = 0; i < LIFE_WRITE_MAX - 2; i += 1) redis.run(["HSET", `nl:stats:${joyStats}:life`, `f:${i}`, "1"]);
  const fullFirst = await counted(() => countTagged("192.0.2.60"));
  evalsSent.front.push(evals);
  recordsRead.front.push(records);
  const fullSecond = await counted(() => countTagged("192.0.2.60"));
  evalsSent.front.push(evals);
  recordsRead.front.push(records);
  is("the heaviest view is inside the model too, at its record's most", [fullSecond <= COMMANDS.frontCount, fullFirst <= COMMANDS.frontCount + COMMANDS.firstOfDay], [true, true]);
  is("and what it counted beyond the most is kept under ~, so the day's total stays right", Number(redis.run(["HGET", `nl:stats:${joyStats}:${today}`, "~"])) >= 2, true);
  // What was counted before 31 October 2026 for this view, and what it is now (printed for the record of 313 [CV1]).
  console.log(`a view's count, billed: ${secondView} (${firstView} by somebody new to the day); the heaviest: ${fullSecond} (${fullFirst})`);
  // The store's first view of the day, by somebody new, arriving when the
  // day's record is already one name short of its most (products, links and
  // checkouts counted earlier that day) and the all-time one at its own: the
  // nine counts, both lookups of which names are there, and the writes made
  // once a day with the day's first view (lib/stats.ts). The most a single
  // view can send; held to the model with somebody new to the day's share.
  await storeWith("kim", "paid");
  const kimStore = (await storeForHandle("kim"))!;
  const kimDay = `nl:stats:${kimStore.statsId}:${new Date().toISOString().slice(0, 10)}`;
  const tagged = async (handle: string, ip: string) => {
    const store = (await storeForHandle(handle))!;
    await withinLimit("hit", `${ip}|${store.handle}`, 120, 600);
    await countHit(asking(ip), store, { kind: "view", source: "newsletter", medium: "email", campaign: "fall" });
    await countVisit(asking(ip), store);
  };
  // Somebody before them this month (so the month's first-visit writes are not in it), then the day's record made one short.
  await tagged("kim", "192.0.2.70");
  redis.run(["DEL", kimDay]);
  for (let i = 0; i < DAY_FIELDS_MAX - 1; i += 1) redis.run(["HSET", kimDay, `f:${i}`, "1"]);
  for (let i = 0; i < LIFE_WRITE_MAX; i += 1) redis.run(["HSET", `nl:stats:${kimStore.statsId}:life`, `f:${i}`, "1"]);
  const dayFirst = await counted(() => tagged("kim", "192.0.2.71"));
  evalsSent.front.push(evals);
  recordsRead.front.push(records);
  is("the store's first view of the day, by somebody new, at its records' most, is inside the model", dayFirst <= COMMANDS.frontCount + COMMANDS.firstOfDay, true);
  is("and it is the day's first: its expiry is written with it", redis.run(["TTL", kimDay]) as number > 0, true);
  console.log(`a view's count, billed, the store's first of the day at its records' most, by somebody new: ${dayFirst}`);
  // The same view, when the visit it adds is the month's hundredth: what the
  // month is marked with (lib/traffic.ts, markMonth) lands on it too. It is
  // counted apart, COMMANDS.monthMark, and priced on every visit at a share
  // (tests/traffic-cost.ts, MONTH_MARKS_PER_VISIT).
  const lia = await storeWith("lia", "paid");
  const liaStore = (await storeForHandle("lia"))!;
  const liaDay = `nl:stats:${liaStore.statsId}:${new Date().toISOString().slice(0, 10)}`;
  await tagged("lia", "192.0.2.80");
  for (let i = 0; i < 98; i += 1) await recordVisit(liaStore, `198.18.0.${i + 1}`);
  redis.run(["DEL", liaDay]);
  for (let i = 0; i < DAY_FIELDS_MAX - 1; i += 1) redis.run(["HSET", liaDay, `f:${i}`, "1"]);
  for (let i = 0; i < LIFE_WRITE_MAX; i += 1) redis.run(["HSET", `nl:stats:${liaStore.statsId}:life`, `f:${i}`, "1"]);
  const before100 = await visitsIn(lia.folder, windowOf(liaStore));
  const marked = await counted(() => tagged("lia", "192.0.2.81"));
  evalsSent.front.push(evals);
  recordsRead.front.push(records);
  is("and when that visit is the month's hundredth, with what the month is marked with", [before100, marked <= COMMANDS.frontCount + COMMANDS.firstOfDay + COMMANDS.monthMark, marked - dayFirst <= COMMANDS.monthMark], [99, true, true]);
  console.log(`the same view as the month's hundredth visit, billed: ${marked}`);
  // A product page opened with the day's record at its most (made so above): its one count asks which names are there.
  const laterFull = await counted(() => countLater("192.0.2.61"));
  evalsSent.later.push(evals);
  recordsRead.later.push(records);
  is("and so is a product's page with the day's record at its most", laterFull <= COMMANDS.laterCount, true);
  console.log(`a later page's count, billed: ${laterCount}; with the day's record at its most: ${laterFull}`);
  // How a page was read, sent by one visitor in eight as they leave (lib/page-read.ts):
  // the route, with a block of a sales page counted before and one of the store's page.
  const readStore = (await storeForHandle("joy"))!;
  const readRequest = (body: Record<string, unknown>) =>
    readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": "Mozilla/5.0 (iPhone)" }, body: JSON.stringify(body) }) as never);
  await readRequest({ t: readToken(readStore.statsId, product.id), k: "d", p: product.id, b: "blok0001" });
  const depthCount = await counted(() => readRequest({ t: readToken(readStore.statsId, product.id), k: "d", p: product.id, b: "blok0001" }));
  evalsSent.read.push(evals);
  recordsRead.read.push(records);
  const reachCount = await counted(() => readRequest({ t: readToken(readStore.statsId, STORE_SCOPE), k: "s", n: 2, b: `p:${product.id}`, c: "" }));
  evalsSent.read.push(evals);
  recordsRead.read.push(records);
  is("and every count script a visit sends is in what its bytes are priced at", [Math.max(...evalsSent.page), Math.max(...evalsSent.front) <= EVALS.frontCount, Math.max(...evalsSent.later) <= EVALS.laterCount, Math.max(...evalsSent.read) <= EVALS.readBeacon, Math.min(...evalsSent.front, ...evalsSent.later, ...evalsSent.read) >= 1], [0, true, true, true, true]);
  // The store's record, read whole (4 November 2026, independent review of #1496): once by each page drawn and
  // once by each count it sends, never by a reading. Each read is priced at MAX_STORE_BYTES (tests/traffic-cost.ts).
  is("and every read of the store's whole record is in what a visit is priced at", [
    Math.max(...recordsRead.page) <= STORE_READS.page,
    Math.max(...recordsRead.front, ...recordsRead.later) <= STORE_READS.count,
    Math.min(...recordsRead.page, ...recordsRead.front, ...recordsRead.later) >= 1,
    Math.max(...recordsRead.read),
  ], [true, true, true, 0]);
  console.log(`store records read: a page drawn ${recordsRead.page.join("/")}, a view's count ${recordsRead.front.join("/")}, a later page's count ${recordsRead.later.join("/")}, a reading ${recordsRead.read.join("/")}`);
  console.log(`count scripts sent, each ${EVAL_BYTES} bytes: a view ${evalsSent.front.join("/")}, a later page ${evalsSent.later.join("/")}, a reading ${evalsSent.read.join("/")}`);
  // A click on one of the store's links, a visit through an affiliate's link
  // and a funnel's step (app/api/store/hit, k "l", "a", "f") are not a page
  // of a visit: each takes one of the store's signals, a count of their own
  // (lib/traffic.ts, takeSignal; lib/traffic-rules.ts, SIGNALS_PER_VISIT),
  // never one of the requests its pages are drawn from, and is priced on its
  // own line at what is measured here (tests/traffic-cost.ts, signalCost;
  // tests/plan-cost-registry.ts, signals). Independent review of #1496, 4
  // November 2026: measured on the path that counts, an approved affiliate and
  // a funnel's real step, by a visitor signed in to another store, whose
  // session is read to know they are not this store's people.
  const linked = await addStoreLink(joy.email, "My site", "https://example.com/site");
  const linkId = linked.ok ? linked.store.links[linked.store.links.length - 1].id : "";
  await setAffiliateSetting(joy.email, { ...NO_AFFILIATES, enabled: true });
  const AFF = "aaaaaaaaaaaa";
  await real([
    ["HSET", `nl:aff:${joyStats}:people`, AFF, JSON.stringify({ id: AFF, email: "partner@example.com", code: "partner", status: "approved", appliedAt: Date.now() - 30 * DAY, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${joyStats}:codes`, "partner", AFF],
  ]);
  // A funnel at its most steps, the first of which is the product the visitor is on.
  const funnelId = "fnl0000001";
  const funnelSteps = [{ kind: "product", id: product.id }, ...Array.from({ length: MAX_FUNNEL_PAGES - 1 }, (_, i) => ({ kind: "page", id: `page${String(i + 1).padStart(6, "0")}` }))];
  await real([["HSET", `nl:pfunnels:${joyStats}`, funnelId, JSON.stringify({ id: funnelId, name: "N".repeat(MAX_FUNNEL_NAME), slug: "s".repeat(MAX_FUNNEL_SLUG), steps: funnelSteps, on: true, since: 1760000000 })]]);
  is("the funnel measured is a real one, at its most steps", (await readPageFunnel(joyStats, funnelId))?.steps.length, MAX_FUNNEL_PAGES);
  const stranger = await openSession(ben.email);
  const signal = (body: Record<string, string>, ip: string, session = stranger) =>
    hitRoute(new NextRequest("https://marktmorgen.com/api/store/hit", { method: "POST", headers: { "user-agent": "Mozilla/5.0 (iPhone)", "x-forwarded-for": ip, cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const joyNow = (await storeForHandle("joy"))!;
  const joyRequests = `nl:traffic:r:${joy.folder}:${windowOf(joyNow)}`;
  const joySignals = `nl:traffic:s:${joy.folder}:${windowOf(joyNow)}`;
  const clicks: Record<string, Record<string, string>> = {
    l: { h: "joy", k: "l", id: linkId },
    a: { h: "joy", k: "a", c: "partner" },
    f: { h: "joy", k: "f", f: funnelId, t: "p", id: product.id },
  };
  const counts = (): Record<string, number> => ({
    // The day's and all-time records, where the click is under its link or, past a record's most fields, under "~" (lib/capped-count.ts).
    l: ["day", "life"].reduce((sum, which) => sum + ["l:" + linkId, "~"].reduce((n, field) => n + Number(redis.run(["HGET", `nl:stats:${joyStats}:${which === "day" ? today : "life"}`, field]) ?? 0), 0), 0),
    a: Number(redis.run(["HGET", `nl:aff:${joyStats}:clicks`, AFF]) ?? 0),
    f: redis.keys().filter((k) => k.startsWith(`nl:pfunnel:seen:${joyStats}:${funnelId}:`)).length,
  });
  const clickCost: string[] = [];
  const signalMeasured: number[] = [];
  let clickIp = 90;
  const measureSignal = async (label: string, body: Record<string, string>, ip: string, keys: { requests: string; signals: string }, counter: () => number, extra: { session?: string; cookie?: string } = {}) => {
    const before = [Number(redis.run(["GET", keys.requests]) ?? 0), Number(redis.run(["GET", keys.signals]) ?? 0)];
    const countedBefore = counter();
    const cookie = [`${SESSION_COOKIE}=${extra.session ?? stranger}`, ...(extra.cookie ? [extra.cookie] : [])].join("; ");
    const sentCommands = await counted(() => hitRoute(new NextRequest("https://marktmorgen.com/api/store/hit", { method: "POST", headers: { "user-agent": "Mozilla/5.0 (iPhone)", "x-forwarded-for": ip, cookie }, body: JSON.stringify(body) })));
    const after = [Number(redis.run(["GET", keys.requests]) ?? 0), Number(redis.run(["GET", keys.signals]) ?? 0)];
    signalMeasured.push(sentCommands);
    clickCost.push(`${label} ${sentCommands} commands, ${evals} scripts, ${records} records, ${replyBytes} other bytes read`);
    return { counted: counter() > countedBefore, requests: after[0] - before[0], signals: after[1] - before[1], sentCommands, evals, records, replyBytes };
  };
  const within = (m: { sentCommands: number; evals: number; records: number; replyBytes: number }, pool = 0) =>
    m.sentCommands <= COMMANDS.signal + pool && m.evals <= EVALS.signal && m.records <= STORE_READS.signal && m.replyBytes <= SIGNAL_READ_BYTES;
  const joyKeys = { requests: joyRequests, signals: joySignals };
  for (const [kind, body] of Object.entries(clicks)) {
    const m = await measureSignal(kind, body, `192.0.2.${clickIp++}`, joyKeys, () => counts()[kind]);
    const name = kind === "l" ? "link's click" : kind === "a" ? "visit through an affiliate's link" : "funnel's step";
    is(`a ${name} by a signed-in stranger is counted, takes one of the store's signals and none of its requests, inside what a signal is priced at`, [m.counted, m.requests, m.signals, within(m)], [true, 0, 1, true]);
  }
  // A count and its expiry go in one write (third round, L2): a request that
  // died between two writes left a count kept for ever. The window's requests
  // and its signals alike, with NX so a set expiry is not moved.
  sentPipelines.length = 0;
  await counted(() => signal(clicks.l, `192.0.2.${clickIp++}`));
  await counted(async () => { await isResting((await storeForHandle("joy"))!); });
  const together = (prefix: string, add: string) => sentPipelines.some((list) => list.some((c) => c[0] === add && String(c[1]).startsWith(prefix)) && list.some((c) => c[0] === "EXPIRE" && String(c[1]).startsWith(prefix) && c[3] === "NX"));
  is("a count of the window's signals and of its requests is written with its expiry, in one write", [together("nl:traffic:s:", "INCR"), together("nl:traffic:r:", "INCRBY")], [true, true]);
  // The help center says it, its figures from the rule (third round, M3).
  const helpText = JSON.stringify(HELP_SECTIONS);
  is("the help center says how many clicks, affiliates' visits and funnel steps are counted, and what happens past them", [helpText.includes(JSON.stringify(signalsWords()).slice(1, -1)), signalsWords().includes(countWords(SIGNALS_PER_VISIT * VISITS_INCLUDED.creator)), (helpText.match(/Clicks on your store's links, visits through an affiliate's link and steps of your page funnels are counted up to/g) ?? []).length >= 2], [true, true, true]);
  // The heavier paths (independent review of #1496, third round, 4 November
  // 2026): a link's first click of the day on a store whose day's record is
  // under its most fields, which writes the day's expiry with it; a visit
  // through an affiliate's link reached from a paid ad, by a browser signed in
  // as another of the store's affiliates (its session and that affiliate are
  // read); and a store in its free trial, which reads its place in the
  // month's pool as well (priced apart, nonPayingWorst).
  const kai = await storeWith("kai", "paid");
  const kaiLinked = await addStoreLink(kai.email, "My site", "https://example.com/site");
  const kaiLink = kaiLinked.ok ? kaiLinked.store.links[kaiLinked.store.links.length - 1].id : "";
  await setAffiliateSetting(kai.email, { ...NO_AFFILIATES, enabled: true });
  const kaiNow = (await storeForHandle("kai"))!;
  const kaiStats = kaiNow.statsId!;
  const OTHER = "bbbbbbbbbbbb";
  await real([
    ["HSET", `nl:aff:${kaiStats}:people`, AFF, JSON.stringify({ id: AFF, email: "partner@example.com", code: "partner", status: "approved", appliedAt: Date.now() - 30 * DAY, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${kaiStats}:codes`, "partner", AFF],
    ["HSET", `nl:aff:${kaiStats}:people`, OTHER, JSON.stringify({ id: OTHER, email: "other@example.com", code: "other", status: "approved", appliedAt: Date.now() - 30 * DAY, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${kaiStats}:codes`, "other", OTHER],
  ]);
  // Another affiliate's own session, as lib/affiliates.ts writes it (sessionKey).
  const otherToken = "c".repeat(64);
  await real([["SET", `nl:aff:session:${createHash("sha256").update(`nimbus-aff-session:${otherToken}`).digest("hex").slice(0, 40)}`, JSON.stringify({ s: kaiStats, a: OTHER })]]);
  const kaiKeys = { requests: `nl:traffic:r:${kai.folder}:${windowOf(kaiNow)}`, signals: `nl:traffic:s:${kai.folder}:${windowOf(kaiNow)}` };
  const kaiToday = new Date().toISOString().slice(0, 10);
  const kaiLinkCount = () => Number(redis.run(["HGET", `nl:stats:${kaiStats}:${kaiToday}`, `l:${kaiLink}`]) ?? 0);
  const kaiClicks = () => Number(redis.run(["HGET", `nl:aff:${kaiStats}:clicks`, AFF]) ?? 0);
  const kaiFirst = await measureSignal("l, the store's first of the day", { h: "kai", k: "l", id: kaiLink }, `192.0.2.${clickIp++}`, kaiKeys, kaiLinkCount);
  const kaiPaid = await measureSignal("a, from a paid ad, signed in as another affiliate", { h: "kai", k: "a", c: "partner", p: "1" }, `192.0.2.${clickIp++}`, kaiKeys, kaiClicks, { cookie: `${affiliateCookieName("kai")}=${otherToken}` });
  is("a link's first click of the day, and an affiliate's visit from a paid ad by another affiliate's browser, are inside what a signal is priced at", [kaiFirst.counted, within(kaiFirst), kaiPaid.counted, kaiPaid.signals, within(kaiPaid)], [true, true, true, 1, true]);
  const tia = await storeWith("tia", "trial");
  const tiaLinked = await addStoreLink(tia.email, "My site", "https://example.com/site");
  const tiaLink = tiaLinked.ok ? tiaLinked.store.links[tiaLinked.store.links.length - 1].id : "";
  const tiaNow = (await storeForHandle("tia"))!;
  const tiaKeys = { requests: `nl:traffic:r:${tia.folder}:${windowOf(tiaNow)}`, signals: `nl:traffic:s:${tia.folder}:${windowOf(tiaNow)}` };
  const tiaCount = () => Number(redis.run(["HGET", `nl:stats:${tiaNow.statsId}:${kaiToday}`, `l:${tiaLink}`]) ?? 0);
  // Its first count of the month takes the store's place in the pool (lib/free-pool.ts), as its first page would have; every one after reads it.
  await signal({ h: "tia", k: "l", id: tiaLink }, `192.0.2.${clickIp++}`);
  const tiaNext = await measureSignal("l, a store in its trial", { h: "tia", k: "l", id: tiaLink }, `192.0.2.${clickIp++}`, tiaKeys, tiaCount);
  is("a store in its trial counts one too, with its place in the month's pool read beside it (priced in nonPayingWorst)", [tiaNext.counted, tiaNext.signals, within(tiaNext, 1)], [true, 1, true]);
  console.log(`signals that are not a page, billed: ${clickCost.join("; ")}`);
  // The model is not a figure far over what is sent: within two commands of the heaviest paid store's.
  const paidMeasured = signalMeasured.slice(0, -1);
  is("and the commands a signal is priced at are the heaviest measured, near enough", [COMMANDS.signal >= Math.max(...paidMeasured), COMMANDS.signal - Math.max(...paidMeasured) <= 2], [true, true]);
  // Only what is written spends one (third round, H1): a code nobody has, an
  // affiliate's click already counted today for this visitor, and a funnel
  // step its visitor already opened give theirs back.
  const heldIp = `192.0.2.${clickIp++}`;
  const spentAt0 = Number(redis.run(["GET", joySignals]) ?? 0);
  for (let i = 0; i < 5; i += 1) await signal({ h: "joy", k: "a", c: `madeup${i}` }, `192.0.2.${clickIp++}`);
  await signal(clicks.a, heldIp);
  const afterFirst = Number(redis.run(["GET", joySignals]) ?? 0);
  await signal(clicks.a, heldIp);
  await signal(clicks.f, heldIp);
  const afterStep = Number(redis.run(["GET", joySignals]) ?? 0);
  await signal(clicks.f, heldIp);
  is("a made-up code, a click already counted today and a step already opened spend none of the store's signals", [afterFirst - spentAt0, Number(redis.run(["GET", joySignals]) ?? 0) - afterStep, afterStep - afterFirst], [1, 0, 1]);
  // The store's own people, and a robot, never spend one.
  const ownerSession = await openSession(joy.email);
  const spentBefore = Number(redis.run(["GET", joySignals]) ?? 0);
  for (const body of Object.values(clicks)) await signal(body, `192.0.2.${clickIp++}`, ownerSession);
  await hitRoute(new NextRequest("https://marktmorgen.com/api/store/hit", { method: "POST", headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "x-forwarded-for": "192.0.2.200" }, body: JSON.stringify(clicks.l) }));
  is("the store's own people and a robot never spend one of its signals", Number(redis.run(["GET", joySignals]) ?? 0), spentBefore);
  // One connection takes its share of a day at most (clientDayShare of the window's signals), and another is still counted.
  const shareOf = clientDayShare(signalLimitFor(joyNow));
  const busyIp = "198.51.100.77";
  const shareDay = new Date().toISOString().slice(0, 10);
  // The connection is read from the request being answered, as Next.js hands it (tests/security/next-headers.ts).
  const signalAnswered = async (body: Record<string, string>, ip: string) => {
    const request = new NextRequest("https://marktmorgen.com/api/store/hit", { method: "POST", headers: { "user-agent": "Mozilla/5.0 (iPhone)", "x-forwarded-for": ip, cookie: `${SESSION_COOKIE}=${stranger}` }, body: JSON.stringify(body) });
    answering(request);
    try {
      await hitRoute(request);
    } finally {
      answering(null);
    }
  };
  for (let i = 0; i < SHARE_BATCH; i += 1) await signalAnswered(clicks.l, busyIp);
  const shareKeyNow = `nl:traffic:sc:${joy.folder}:${windowOf(joyNow)}`;
  const fields = (redis.run(["HKEYS", shareKeyNow]) as string[]).filter((f) => f.startsWith(`${shareDay}:`));
  is("a connection's signals are added to its share of the day, apart from its requests'", fields.length >= 1, true);
  for (const field of fields) redis.run(["HSET", shareKeyNow, field, String(shareOf)]);
  const linkBefore = counts().l;
  for (let i = 0; i < SHARE_BATCH; i += 1) await signalAnswered(clicks.l, busyIp);
  const busyAfter = counts().l;
  await signalAnswered(clicks.l, `192.0.2.${clickIp++}`);
  // Each click counts on the day's and the all-time record, two in counts().
  is("past its share of the day one connection is not counted, and another still is", [busyAfter - linkBefore < 2 * SHARE_BATCH, counts().l - busyAfter], [true, 2]);
  // Past the window's signals nothing is counted, the store's pages do not rest
  // for it, and its rates are said to be incomplete rather than shown too high.
  const spentAt = redis.run(["GET", joySignals]);
  redis.run(["SET", joySignals, String(signalLimitFor(joyNow))]);
  is("before they run out, no rate is said to be incomplete", await signalsShortWords(joyNow), "");
  const pastBefore = counts();
  for (const body of Object.values(clicks)) await signal(body, `192.0.2.${clickIp++}`);
  is("once the store's signals are spent, a click, an affiliate's visit and a funnel's step are not counted", [counts(), Number(redis.run(["GET", joySignals]))], [pastBefore, signalLimitFor(joyNow)]);
  is("and its pages do not rest for it", await isResting((await storeForHandle("joy"))!), false);
  is("and its rates say they are not complete this month", [await signalsShortWords(joyNow), await signalsShortWords(joyNow, Date.now() + 40 * DAY)], [SIGNALS_SHORT_THIS_MONTH, SIGNALS_SHORT_BEFORE]);
  const fullNumbers = { affiliates: 2, since: 1, clicks: 500, clickSales: 50, clickEarnedCents: 10_000, sales: 50, earnedCents: 10_000, paidCents: 0 };
  is("the directory then shows no share of clicks that became a sale, and says why", [directoryNumbers(fullNumbers as never)?.conversion, directoryNumbers(fullNumbers as never, SIGNALS_SHORT_THIS_MONTH)?.conversion, directoryNumbers(fullNumbers as never, SIGNALS_SHORT_THIS_MONTH)?.per100Cents, directoryNumbers(fullNumbers as never, SIGNALS_SHORT_THIS_MONTH)?.incomplete], [10, null, null, SIGNALS_SHORT_THIS_MONTH]);
  const directoryPage = read("components/affiliate-directory.tsx");
  const funnelEditor = read("components/page-funnel-editor.tsx");
  is("the directory's page and the funnel's counts say it where the rate would be", [/numbers\.incomplete\s*\?/.test(directoryPage), /incomplete \? `\$\{incomplete\} ` : funnelReachRatioMetric/.test(funnelEditor), /signalsShortWords\(store\)/.test(read("app/studio/funnels/page.tsx")), /signalsShortWords\(store\)/.test(read("lib/affiliate-directory.ts"))], [true, true, true, true]);
  redis.run(["SET", joySignals, String(spentAt)]);
  redis.run(["DEL", `nl:traffic:sshort:${joy.folder}`]);
  // A count refused for its address, or for the store's ten minutes, reads nothing of the store (third round, M2).
  for (let i = 0; i < 125; i += 1) await withinLimit("hit", `192.0.2.250|joy`, 120, 600);
  const refusedReads = await counted(() => signal(clicks.l, "192.0.2.250")).then(() => records);
  is("a count refused for its address reads none of the store's record", refusedReads, 0);
  // And past what one store's pages may say in ten minutes from every address together (HIT_STORE_LIMIT, 3,000).
  for (let i = 0; i < 3_000; i += 1) await withinLimit("hit-store", "joy", 3_000, 600);
  const floodReads = await counted(() => signal(clicks.l, `192.0.2.${clickIp++}`)).then(() => records);
  is("a count past the store's ten minutes reads none of its record either", [floodReads, /withinLimit\("hit-store", handle, HIT_STORE_LIMIT, 600\)[\s\S]*storeForHandle\(handle\)/.test(read("app/api/store/hit/route.ts"))], [0, true]);
  // Billed, the count script with its one name inside (lib/capped-count.ts): never more than the model,
  // and never one or none, which would mean the script's inside or the count itself went uncounted.
  is("and how a page was read is too, without reading the store", [depthCount <= COMMANDS.readBeacon, reachCount <= COMMANDS.readBeacon, depthCount >= 3, reachCount >= 3], [true, true, true, true]);
  is("every script a visit sends is billed in what is counted here", uncounted, []);
  // Between $0.0002 and $0.0003 until October 31, 2026, when the count
  // scripts were costed as Upstash bills them (313 [CV1]): $0.000304. From
  // 4 November 2026 also the six reads of the store's whole record a visit
  // makes, a megabyte each at the most (STORE_READS): $0.000484.
  is("the visit this is all worked out for is a heavy one", [PAGES_PER_VISIT, STATIC_FILES, visitCost() > 0.0004, visitCost() < 0.0005], [3, 13, true, true]);
  console.log(`a visit at the most: ${visitCost().toFixed(7)} dollars`);

  part("Where it is counted, and where a store rests");
  const hit = read("app/api/store/hit/route.ts");
  // Any other page's is one visit, and on a product's own page that product's visitor too
  // (lib/stats.ts, kind "product"), which is a figure for the creator and no second visit.
  is("the front page's count is a visit too, and any other page's is only that", [
    /kind === "v"[\s\S]*?countVisit\(request, store\)/.test(hit),
    /kind === "p"\) \{[\s\S]*?await countVisit\(request, store\);(?:(?!countVisit)[\s\S])*?kind: "product"[\s\S]*?\} else if/.test(hit),
  ], [true, true]);
  const beacon = read("components/store-beacon.tsx");
  is("a page other than the front one says only that it was opened", [/k: "p"/.test(beacon), /front = true/.test(beacon)], [true, true]);
  for (const page of ["app/[handle]/p/[product]/page.tsx", "app/[handle]/book/[product]/page.tsx", "app/[handle]/free/page.tsx", "app/[handle]/waitlist/page.tsx"]) {
    is(`${page.split("/")[2]}: somebody who arrives straight at it is counted`, /<StoreTracking[^>]*\bpresence\b/.test(read(page).replace(/\s+/g, " ")), true);
  }
  for (const page of ["app/[handle]/page.tsx", "app/[handle]/p/[product]/page.tsx"]) {
    is(`${page.includes("/p/") ? "a product's page" : "the store's page"} rests with the store, before anything else is read for it`, /if \(await isResting\(store\)\) return <StoreResting store=\{store\} \/>;/.test(read(page)), true);
  }
  const resting = read("components/store-resting.tsx");
  is("a resting page keeps the way back to what a buyer has, and counts nothing", [/\/orders/.test(resting), /\/community/.test(resting), /StoreTracking|StoreBeacon/.test(resting.replace(/\/\*[\s\S]*?\*\//, ""))], [true, true, false]);
  for (const page of ["app/[handle]/orders", "app/[handle]/manage", "app/api/store/download"]) {
    is(`${page.split("/").pop()}: what a buyer has is never part of the rest`, /isResting/.test(readDir(page)), false);
  }
  is("courses, the community and podcasts rest only at the whole figure", [/isResting\(store, undefined, "buyer"\)/.test(readDir("app/[handle]/course")), /isResting\(store, Date\.now\(\), "buyer"\)/.test(read("lib/community-page.ts")), /isResting\(store, Date\.now\(\), "buyer", \{ shared: true \}\)/.test(read("app/api/store/podcast/feed/[token]/route.ts"))], [true, true, true]);
  const job = read("app/api/cron/usage/route.ts");
  is("the daily job writes and never bills visits, and it is scheduled", [/settleAllVisits/.test(job), /firstWordOnVisits\(folder, month\)/.test(job), /\/api\/cron\/usage/.test(read("vercel.json"))], [false, true, true]);

  part("What the pages say");
  const terms = read("app/terms/page.tsx");
  is("the Terms give finite plan visit thresholds, and say nothing is billed", [/countWords\(VISITS_INCLUDED\.creator\)/.test(terms), /countWords\(VISITS_INCLUDED\.pro\)/.test(terms), /countWords\(VISITS_INCLUDED\.scale\)/.test(terms), /public pages \(its page/.test(terms), /Visits are not billed/.test(terms)], [true, true, true, true, true]);
  is("what a visit is, and who is never counted", [/one person opening your store on one day/.test(terms), /never counted/.test(terms)], [true, true]);
  is("and what happens with no paid plan", [/countWords\(TRIAL_VISITS\)/.test(terms), /countWords\(SETUP_VISITS\)/.test(terms), /rest/.test(terms)], [true, true, true]);
  const help = read("lib/help-content.ts");
  is("the help pages disclose counted visits, page pauses and that nothing is billed", [help.includes("countWords(VISITS_INCLUDED.creator)} visits a billing month"), help.includes("Visits are never billed"), help.includes("public pages"), help.includes("countWords(SETUP_VISITS)")], [true, true, true, true]);
  const home = read("components/home-parts.tsx");
  is("the price list says it beside the plan, with no price past it", [/VISITS_INCLUDED\.creator/.test(home), /VISITS_INCLUDED\.pro/.test(home), /VISIT_CENTS_PER_THOUSAND_OVER/.test(home), /nothing is billed past it/.test(home)], [true, true, false, true]);
  const feature = read("lib/feature-pages.ts");
  is("the store feature page discloses finite public-page visits", [feature.includes("public pages pause"), feature.includes("shown for \" + countWords(publicVisitLimit(SETUP_VISITS))")], [true, true]);
  const privacy = read("app/privacy/page.tsx");
  is("the privacy policy says what is kept of a visitor for the count, and for how long", [/keep its first sixteen\s+characters/.test(privacy), /deleted two days later/.test(privacy), /made with a secret key of our own/.test(privacy)], [true, true, true]);
  const studio = read("app/studio/page.tsx");
  is("the studio shows visits and their finite threshold", [/Visits this month/.test(studio), /trafficForAdmission\(folder, usageId\)/.test(studio), /visitLimitFor\(store\)/.test(studio), /Visits are never billed/.test(studio)], [true, true, true, true]);
  is("a plan's price is far more than its visits cost us", (VISITS_INCLUDED.creator * visitCost()) / (PLAN_PRICES.creator.month / 100) < 0.05, true);

  done();
}

/** Every source file under a folder, joined: for a check that a word appears nowhere in it. */
function readDir(path: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(process.cwd(), path));
  return out.join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
