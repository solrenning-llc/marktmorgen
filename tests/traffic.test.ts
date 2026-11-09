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
import { badgeInviteCode } from "@/lib/badge-link";
import { PLAN_PRICES } from "@/lib/plan";
import { readAbout } from "@/lib/product-about";
import { withinLimit } from "@/lib/request-guard";
import { summaries, summaryOf } from "@/lib/reviews";
import { stockLeft } from "@/lib/stock";
import { addProduct, claimHandle, setProductFile, setSubscription, storeFolder, storeForEmail, storeForHandle, storeForPage } from "@/lib/store";
import { isResting, recordVisit, visitedFolders, visitsIn } from "@/lib/traffic";
import { firstWordOnVisits } from "@/lib/traffic-billing";
import {
  SETUP_VISITS,
  TRIAL_VISITS,
  VISITS_INCLUDED,
  VISIT_CENTS_PER_THOUSAND_OVER,
  BUYER_RESERVE_BPS,
  publicVisitLimit,
  countWords,
  visitLimitFor,
  visitorAddress,
  visitsIncluded,
  visitsWords,
} from "@/lib/traffic-rules";
import { storeOf } from "@/lib/usage-billing";
import { countHit, countVisit } from "@/lib/visit";
import { isSoon, soonProducts } from "@/lib/waitlist";
import { centsWords } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { COMMANDS, PAGES_PER_VISIT, STATIC_FILES, visitCost } from "./traffic-cost";
import { POST as readRoute } from "@/app/api/store/read/route";
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

/** How many commands were sent to the database while something ran. */
let commands = 0;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return real(list);
}) as typeof redis.pipeline;
async function counted(work: () => Promise<unknown>): Promise<number> {
  commands = 0;
  await work();
  return commands;
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
    await badgeInviteCode(store.sid);
    return listings;
  };
  const listings = await drawFront();
  // And the request the page is, counted in the store's window: priced apart (tests/plan-cost-registry.ts, public-requests).
  is("a full page of a store that pays is drawn in a few reads", [listings.length, (await counted(drawFront)) <= COMMANDS.frontPage + REQUEST_COMMANDS], [24, true]);
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
  const secondView = await counted(() => countFront("192.0.2.50"));
  is("counting it a second time that day is inside the model", secondView <= COMMANDS.frontCount, true);
  is("and what somebody new to the day adds is too", firstView - secondView <= COMMANDS.firstOfDay, true);
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
  is("and saying it was opened is too, with the product's own visitor", laterCount <= COMMANDS.laterCount, true);
  // How a page was read, sent by one visitor in eight as they leave (lib/page-read.ts):
  // the route, with a block of a sales page counted before and one of the store's page.
  const readStore = (await storeForHandle("joy"))!;
  const readRequest = (body: Record<string, unknown>) =>
    readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": "Mozilla/5.0 (iPhone)" }, body: JSON.stringify(body) }) as never);
  await readRequest({ t: readToken(readStore.statsId, product.id), k: "d", p: product.id, b: "blok0001" });
  const depthCount = await counted(() => readRequest({ t: readToken(readStore.statsId, product.id), k: "d", p: product.id, b: "blok0001" }));
  const reachCount = await counted(() => readRequest({ t: readToken(readStore.statsId, STORE_SCOPE), k: "s", n: 2, b: `p:${product.id}`, c: "" }));
  // Exactly one each: none would mean nothing was counted, which would pass the model for the wrong reason.
  is("and how a page was read is too, without reading the store", [depthCount, reachCount], [COMMANDS.readBeacon, COMMANDS.readBeacon]);
  is("the visit this is all worked out for is a heavy one", [PAGES_PER_VISIT, STATIC_FILES, visitCost() > 0.0002, visitCost() < 0.0003], [3, 13, true, true]);

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
  // The orders page instead takes, before anything is read, the buyer requests one opening costs (lib/buyer-orders.ts, openOrders),
  // and every read past them through its meter, again as buyer requests (C3-77, MR, 4 November 2026).
  const ordersLib = read("lib/buyer-orders.ts");
  const ordersPage = read("app/[handle]/orders/page.tsx");
  is("orders: an opening takes ORDERS_OPEN_UNITS buyer requests before its grant is read, and its meter takes more as buyer requests", [
    /takePublicRequest\(store, "buyer", Date\.now\(\), ORDERS_OPEN_UNITS\)\)\) return \{ admitted: false, email: null, meter \};\n\s*return \{ admitted: true, email: await ordersGrant\(store, token\), meter \};/.test(ordersLib),
    /takePublicRequest\(this\.store, "buyer", Date\.now\(\), units\)\)\) \{\n\s*this\.ended \?\?= "busy";\n\s*throw new OrdersBusy\(\)/.test(ordersLib),
    ordersPage.includes("await openOrders(store, token)") && ordersPage.indexOf("await openOrders(store, token)") < ordersPage.indexOf("purchasesFor(store, email, meter)"),
  ], [true, true, true]);
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
