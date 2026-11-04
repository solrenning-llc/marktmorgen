/**
 * 639 [GL7](25): every reading of a page has its ceiling before it costs
 * anything (lib/page-read.ts, app/api/store/read; the cost lane's finding of
 * 4 November 2026), and since the review of the same day (inbox C3-57) the
 * ceiling is the readings' own, never the window of public requests a
 * store's pages are drawn from. Through the real route with the stand-in
 * database:
 *
 *   - the same token sent twice counts once, and the repeat costs one command;
 *   - a call made by hand with a nonce the server's draw did not pick counts
 *     nothing and costs nothing, even signed;
 *   - a token older than READ_TOKEN_SECONDS counts nothing;
 *   - a reading is never one of the store's public requests: the Store plan's
 *     whole visible visits (3,400, three pages each) are drawn with every
 *     reading its window can take, and its pages never rest early;
 *   - the window's readings stop at their ceiling, exactly, even when they
 *     all arrive at once; past it a reading costs the mark and the count and
 *     nothing else; a new window has a new count;
 *   - a resting or suspended store's page gets no token;
 *   - the studio says the window's readings are partial once they went past
 *     the ceiling, and nothing when they did not;
 *   - the draw is the server's: one page view in READ_SAMPLE gets a token,
 *     and the browser sends whatever it was given, and nothing past its time.
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  READ_SAMPLE,
  READ_TOKEN_MAX,
  READ_TOKEN_SECONDS,
  READ_WINDOWS_HELD,
  STORE_SCOPE,
  noteReadStore,
  readCeiling,
  readSampled,
  readToken,
  readTokenPass,
  readingsPartial,
  spendReadToken,
} from "@/lib/page-read";
import { readingsPartialWords } from "@/lib/page-read-sample";
import { readDepth } from "@/lib/page-depth";
import { timeShares } from "@/lib/page-depth-rules";
import { readStats, studioStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { EXTRA_REQUESTS, REQUESTS_PER_VISIT, VISITS_INCLUDED, publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { isResting } from "@/lib/traffic";
import { deriveKey } from "@/lib/secret-box";
import { POST as readRoute } from "@/app/api/store/read/route";
import { PageTime } from "@/components/page-time";
import { COMMANDS } from "./traffic-cost";
import { readingsAtCeiling } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "reader@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const PRODUCT = "prod000001";

/** How many commands were sent to the database while something ran, and which. */
let commands = 0;
let sent: (string | number)[][] = [];
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  sent.push(...list);
  return real(list);
}) as typeof redis.pipeline;
async function counted(work: () => Promise<unknown>): Promise<number> {
  commands = 0;
  sent = [];
  await work();
  return commands;
}

let seed = 0;
/** A fresh visit nonce, drawn (`yes`) or not by the server's own draw. */
function nonce(yes: boolean): string {
  for (;;) {
    const n = `visit${String((seed += 1)).padStart(11, "0")}`;
    if (readSampled(n) === yes) return n;
  }
}

const send = (body: Record<string, unknown>) =>
  readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": PHONE }, body: JSON.stringify(body) }) as never);
const sale = (t: string, b = "blok0001", s: unknown = 42) => send({ t, k: "d", p: PRODUCT, b, s });

/** A store of the Store plan, paying, in its billing month. */
async function paying(email: string, handle: string) {
  await claimHandle(email, handle, "A Paying Store", "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: `cus_${handle.padEnd(10, "0")}`, subscriptionId: `sub_${handle.padEnd(10, "0")}`, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  return (await storeForEmail(email))!;
}

/** The readings key of a store's window, as the route counts it. */
const readsKey = (statsId: string, window: string) => `nl:traffic:read:${statsId}:${window}`;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lantern", "Lantern Books", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  part("The token carries its window and ceiling, learned from the page's check");
  is("before any page check, a drawn visit gets no token: never one without its ceiling", readToken(statsId, PRODUCT, Date.now(), nonce(true)), "");
  is("the check every store page makes before it is drawn leaves them", [await isResting(store), readToken(statsId, PRODUCT, Date.now(), nonce(true)).length > 0], [false, true]);
  const window = allowanceWindow(store, Date.now())!;
  const ceiling = readCeiling(store);
  const made = readTokenPass(readToken(statsId, PRODUCT, Date.now(), nonce(true)), PRODUCT)!;
  is("the token says the store's window, its end and its ceiling", [made.window, made.end, made.cap], [window.id, Math.ceil(window.end / 1000), ceiling]);
  is("the ceiling: one reading for every READ_SAMPLE requests the public pages may answer", ceiling, Math.ceil(publicVisitLimit(requestLimitFor(store)) / READ_SAMPLE));
  const longest = readToken("z".repeat(40), PRODUCT, Date.now(), nonce(true));
  noteReadStore("z".repeat(40), store);
  const longToken = readToken("z".repeat(40), PRODUCT, Date.now(), nonce(true));
  is("the longest statistics id still fits READ_TOKEN_MAX", [longest, longToken.length <= READ_TOKEN_MAX, readTokenPass(longToken, PRODUCT) !== null], ["", true, true]);
  is("a token's room, counted", READ_TOKEN_MAX, 119);

  part("The draw is the server's");
  let given = 0;
  for (let i = 0; i < 4_000; i += 1) if (readToken(statsId, PRODUCT)) given += 1;
  is("about one page view in READ_SAMPLE gets a token, the rest none", Math.abs(given / 4_000 - 1 / READ_SAMPLE) < 0.03, true);
  is("a nonce not drawn gets no token", readToken(statsId, PRODUCT, Date.now(), nonce(false)), "");
  // Signed with this deployment's own key, as only the server could: still refused, since the draw is checked again.
  const issued = Math.floor(Date.now() / 1000).toString(36);
  const undrawn = nonce(false);
  const tail = [window.id, made.end.toString(36), ceiling.toString(36)];
  const signature = createHmac("sha256", deriveKey("page-read")!).update([statsId, PRODUCT, issued, undrawn, ...tail].join("|")).digest("base64url").slice(0, 22);
  const handMade = [statsId, issued, undrawn, ...tail, signature].join(".");
  is("a token for a nonce not drawn is refused even when signed", readTokenPass(handMade, PRODUCT), null);
  // A larger ceiling or another window written into a good token breaks its signature.
  const good = readToken(statsId, PRODUCT, Date.now(), nonce(true)).split(".");
  is("a ceiling raised by hand is refused", readTokenPass([...good.slice(0, 5), (ceiling * 100).toString(36), good[6]].join("."), PRODUCT), null);
  is("so is a window named by hand", readTokenPass([...good.slice(0, 3), "2099-01", ...good.slice(4)].join("."), PRODUCT), null);
  // Not 22 base64url letters: refused before it is compared, where a non-ASCII signature of 22 UTF-16 units threw.
  let threw = false;
  let odd: unknown = "unset";
  try {
    odd = readTokenPass([...good.slice(0, 6), "é".repeat(22)].join("."), PRODUCT);
  } catch {
    threw = true;
  }
  is("a signature that is not 22 base64url letters is refused, and nothing throws", [threw, odd], [false, null]);
  const page = readFileSync("components/page-depth.tsx", "utf8") + readFileSync("components/store-reach.tsx", "utf8");
  is("the browser no longer draws: it sends what it was given", page.includes("Math.random"), false);
  is("the browser no longer sends the store's address: the token says everything", [/\bh: handle\b/.test(page), /useParams|useStoreHandle/.test(page)], [false, false]);
  is("and sends nothing past the token's time, measured on the page's own clock", [page.match(/if \(!stillReadable\(since\)\) return;/g)?.length, page.includes("const since = performance.now();"), page.includes("READ_SEND_MS")], [2, true, true]);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy says the server picks, the code lasts two hours and a reading counts once", privacy.includes("Our server picks one page view in eight") && privacy.includes("we keep the code for those two hours only, so the same reading is\n          never counted twice"), true);
  is("and that a store counts a set number of readings a month, kept as a count", privacy.includes("Each store counts at most a set number of these") && privacy.includes("and nothing about who sent them, until a day after the month ends") && !privacy.includes("with that code and the store&apos;s address"), true);

  part("A call made by hand");
  const byHand = await counted(() => sale(handMade));
  is("counts nothing and costs no command", [(await readDepth(statsId, PRODUCT)).visitors, byHand], [0, 0]);
  noteReadStore(statsId, store, Date.now() - (READ_TOKEN_SECONDS + 60) * 1000);
  const old = readToken(statsId, PRODUCT, Date.now() - (READ_TOKEN_SECONDS + 60) * 1000, nonce(true));
  noteReadStore(statsId, store);
  is("an expired token counts nothing and costs no command", [old.length > 0, await counted(() => sale(old)), (await readDepth(statsId, PRODUCT)).visitors], [true, 0, 0]);
  const ahead = readToken(statsId, PRODUCT, Date.now() + 3_600_000, nonce(true));
  is("nor one dated ahead of the clock (none is even made: its page check is too far behind)", [ahead, await counted(() => sale(ahead))], ["", 0]);

  part("Once a visit");
  const token = readToken(statsId, PRODUCT, Date.now(), nonce(true));
  const first = await counted(() => sale(token));
  const firstSent = sent.map((c) => String(c[0]));
  const after = await readDepth(statsId, PRODUCT);
  is("a drawn, good reading counts once in both records", [after.visitors, after.stopped, after.time], [1, { blok0001: 1 }, { "@t2": 1 }]);
  const again = await counted(() => sale(token, "blok0002", 400));
  const againSent = sent.map((c) => c[0]);
  const twice = await readDepth(statsId, PRODUCT);
  is("the same token again counts nothing, in either record", [twice.visitors, twice.stopped, twice.time], [1, { blok0001: 1 }, { "@t2": 1 }]);
  is("and costs the one command that says it was used", [again, againSent], [1, ["SET"]]);
  // The most one reading counted sends, each a command of the stand-in's pipeline (a script is one): the mark;
  // the window's count of readings and its expiry; the reading's count, one script, and each record's expiry the
  // first time it is written (two). No read of the store, no public request, no place in the month's free pool.
  const MOST = 1 + 2 + 3;
  const steady = await counted(() => sale(readToken(statsId, PRODUCT, Date.now(), nonce(true)), "blok0001", 42));
  console.log(`  commands: first reading ${first}, a later one ${steady}, a repeat ${again}`);
  is("a reading counted is bounded: the mark, the count of readings, the reading's count", [first <= MOST, steady <= 1 + 2 + 1, MOST <= COMMANDS.readBeacon], [true, true, true]);
  is("and in that order: the mark, then the count with its expiry, then the reading", firstSent.slice(0, 3), ["SET", "INCR", "EXPIRE"]);
  const mark = `nl:read:once:${readTokenPass(token, PRODUCT)!.nonce}`;
  const ttl = Number(redis.run(["TTL", mark]));
  is("the mark lasts until two hours after the page was drawn, not after the reading", ttl > READ_TOKEN_SECONDS - 60 && ttl <= READ_TOKEN_SECONDS + 60, true);
  noteReadStore(statsId, store, Date.now() - (READ_TOKEN_SECONDS - 600) * 1000);
  const late = readTokenPass(readToken(statsId, PRODUCT, Date.now() - (READ_TOKEN_SECONDS - 600) * 1000, nonce(true)), PRODUCT)!;
  noteReadStore(statsId, store);
  await spendReadToken(late.nonce, late.issued);
  const lateTtl = Number(redis.run(["TTL", `nl:read:once:${late.nonce}`]));
  is("a token used near its end is marked only for the minutes it has left", lateTtl > 0 && lateTtl <= 600 + 60, true);

  part("The store page, the same way");
  const reach = readToken(statsId, STORE_SCOPE, Date.now(), nonce(true));
  await send({ t: reach, k: "s", n: 1, b: "p:prod000001", c: "" });
  await send({ t: reach, k: "s", n: 2, b: "l:link01", c: "l:link01" });
  is("counted once a visit too", (await readStats(store))!.windows.d7.reach, { "1.p:prod000001>": 1 });

  part("Never one of the store's public requests");
  const requests = `nl:traffic:r:${await storeFolder(storeRef(store))}:${window.id}`;
  const before = Number(redis.run(["GET", requests]) ?? 0);
  await sale(readToken(statsId, PRODUCT, Date.now(), nonce(true)), "blok0003", 5);
  is("a reading leaves the window's requests as they were", Number(redis.run(["GET", requests]) ?? 0) - before, 0);
  redis.run(["SET", requests, "100000000"]);
  const spentWindow = await counted(() => sale(readToken(statsId, PRODUCT, Date.now(), nonce(true)), "blok0004", 5));
  is("a token made before the pages rested still counts, under its own ceiling", [(await readDepth(statsId, PRODUCT)).stopped.blok0004, spentWindow <= MOST], [1, true]);
  is("a resting store's page gets no token", [await isResting(store), readToken(statsId, PRODUCT, Date.now(), nonce(true))], [true, ""]);
  redis.run(["DEL", requests]);

  part("The Store plan's whole visible visits, with every reading its window can take");
  const shop = await paying("shop@example.com", "fullshop");
  const shopWindow = allowanceWindow(shop)!;
  const shopCeiling = readCeiling(shop);
  const whole = requestLimitFor(shop);
  const publicPages = REQUESTS_PER_VISIT * publicVisitLimit(VISITS_INCLUDED.creator);
  const buyerPages = REQUESTS_PER_VISIT * VISITS_INCLUDED.creator - publicPages;
  is("the Store plan: 3,400 visits, three pages each, public pages at 95%", [VISITS_INCLUDED.creator, whole, publicPages, shopCeiling], [3_400, 3 * 3_400 + EXTRA_REQUESTS.creator, 9_690, Math.ceil(publicVisitLimit(whole) / READ_SAMPLE)]);
  is("which, counted among the requests as before, would have made the pages rest early", publicPages + shopCeiling > publicVisitLimit(whole), true);
  let rested = 0;
  let readings = 0;
  for (let i = 0; i < publicPages; i += 1) {
    if (await isResting(shop)) rested += 1;
    // A reading on every seventh page, past the ceiling: every one the window can take, and more.
    if (i % 7 === 0) {
      readings += 1;
      await sale(readToken(shop.statsId, PRODUCT, Date.now(), nonce(true)), "blok0001", 30);
    }
  }
  // Made while the public pages may still be drawn, for the reading past the ceiling below.
  const over = readToken(shop.statsId, PRODUCT, Date.now(), nonce(true));
  for (let i = 0; i < buyerPages; i += 1) if (await isResting(shop, Date.now(), "buyer")) rested += 1;
  const shopRequests = `nl:traffic:r:${await storeFolder(storeRef(shop))}:${shopWindow.id}`;
  is("every page of every visit is drawn: none rests early", [rested, Number(redis.run(["GET", shopRequests]))], [0, publicPages + buyerPages]);
  is("every reading the window takes is counted, and no more", [readings > shopCeiling, (await readDepth(shop.statsId, PRODUCT)).visitors, Number(redis.run(["GET", readsKey(shop.statsId!, shopWindow.id)]))], [true, shopCeiling, readings]);
  is("the readings priced for the plan are exactly the ceiling", readingsAtCeiling(whole), shopCeiling);

  part("Past the ceiling");
  const overCost = await counted(() => sale(over, "blok0002", 30));
  const overSent = sent.map((c) => c[0]);
  is("costs the mark and the count with its expiry, and nothing else", [overCost, overSent], [3, ["SET", "INCR", "EXPIRE"]]);
  is("and counts nothing", [(await readDepth(shop.statsId, PRODUCT)).visitors, (await readDepth(shop.statsId, PRODUCT)).stopped.blok0002], [shopCeiling, undefined]);
  is("the same token again still costs one command", await counted(() => sale(over, "blok0002", 30)), 1);

  part("Readings sent all at once");
  const racer = await paying("racer@example.com", "racershop");
  await isResting(racer);
  const racerCeiling = readCeiling(racer);
  const burst = Array.from({ length: racerCeiling + 20 }, () => readToken(racer.statsId, PRODUCT, Date.now(), nonce(true)));
  await Promise.all(burst.map((t) => sale(t, "blok0001", 30)));
  is("exactly the ceiling is counted, never more", [(await readDepth(racer.statsId, PRODUCT)).visitors, Number(redis.run(["GET", readsKey(racer.statsId!, allowanceWindow(racer)!.id)]))], [racerCeiling, racerCeiling + 20]);

  part("A new window, a new count");
  // The billing month after: its own name, its own count, its own ceiling.
  const next = { ...racer, period: { start: racer.period!.end, end: racer.period!.end + 30 * 86_400, renews: true } };
  const nextAt = racer.period!.end * 1000 + 60_000;
  const realNow = Date.now;
  const racerWindow = allowanceWindow(racer)!;
  Date.now = () => nextAt;
  try {
    noteReadStore(next.statsId, next);
    const nextToken = readToken(next.statsId, PRODUCT, Date.now(), nonce(true));
    const nextWindow = allowanceWindow(next)!;
    await sale(nextToken, "blok0003", 30);
    is("the next billing month counts again, in a count of its own", [nextWindow.id !== racerWindow.id, (await readDepth(racer.statsId, PRODUCT)).stopped.blok0003, Number(redis.run(["GET", readsKey(racer.statsId!, nextWindow.id)]))], [true, 1, 1]);
  } finally {
    Date.now = realNow;
  }
  // A store that pays nothing turns with the calendar month.
  const monthEnd = window.end;
  Date.now = () => monthEnd + 60_000;
  try {
    redis.run(["SET", readsKey(statsId, window.id), String(ceiling + 5)]);
    noteReadStore(statsId, store);
    const turned = readToken(statsId, PRODUCT, Date.now(), nonce(true));
    const turnedWindow = allowanceWindow(store)!;
    const depthBefore = (await readDepth(statsId, PRODUCT)).visitors;
    await sale(turned, "blok0005", 30);
    is("the calendar month turns too: a full month behind, a new one counting", [turnedWindow.id !== window.id, (await readDepth(statsId, PRODUCT)).visitors - depthBefore, Number(redis.run(["GET", readsKey(statsId, turnedWindow.id)]))], [true, 1, 1]);
    is("and the count is kept to the window's end and a day", Number(redis.run(["TTL", readsKey(statsId, turnedWindow.id)])) <= Math.ceil((turnedWindow.end - Date.now()) / 1000) + 86_400, true);
  } finally {
    Date.now = realNow;
  }
  redis.run(["DEL", readsKey(statsId, window.id)]);

  part("A suspended store");
  const suspendedShop = await paying("closed@example.com", "closedshop");
  await isResting(suspendedShop);
  const beforeSuspension = readToken(suspendedShop.statsId, PRODUCT, Date.now(), nonce(true));
  const suspended = { ...suspendedShop, suspended: new Date().toISOString() };
  await isResting(suspended);
  is("its page draws no token", readToken(suspended.statsId, PRODUCT, Date.now(), nonce(true)), "");
  // A token made before it was suspended writes only into its own numbers, under its window's ceiling: harmless, so it counts.
  await sale(beforeSuspension, "blok0001", 30);
  const closedCount = Number(redis.run(["GET", readsKey(suspendedShop.statsId!, allowanceWindow(suspendedShop)!.id)]));
  is("a token made before it counts in its own numbers, under the ceiling", [(await readDepth(suspendedShop.statsId, PRODUCT)).visitors, closedCount, closedCount <= readCeiling(suspendedShop)], [1, 1, true]);

  part("What the creator is told");
  is("readings within the ceiling, or none: nothing said", [await readingsPartial(suspendedShop), await readingsPartial(store)], [null, null]);
  const partial = await readingsPartial(shop);
  is("past it: the window is partial, and how many were counted", partial, { counted: shopCeiling, opens: shopWindow.end });
  is("the window is marked once it went past, with the ceiling it passed", redis.run(["GET", `${readsKey(shop.statsId!, shopWindow.id)}:over`]), String(shopCeiling));
  // The plan grown since: its ceiling is now above what was counted, but the window still went past the old one.
  const grown = { ...shop, tier: "scale" as const };
  is("a plan grown later in the window still says the window is partial, with the readings counted then", readCeiling(grown) > shopCeiling && (await readingsPartial(grown))?.counted === shopCeiling, true);
  const words = readingsPartialWords(partial!.counted, partial!.opens);
  is("said in plain words, with the real figure and the day it opens again, nothing made up", [words.includes(`up to ${shopCeiling.toLocaleString("en-US")} measured visits a month`), words.includes("Only part of this month is counted."), words.includes("(UTC)"), /\d+%|about|estimated/i.test(words)], [true, true, true, false]);
  const shown = renderToStaticMarkup(createElement(PageTime, { ranges: timeShares({ "@t2": 40 }), least: 20, partial }));
  const quiet = renderToStaticMarkup(createElement(PageTime, { ranges: timeShares({ "@t2": 40 }), least: 20 }));
  is("the time on page says it when partial, and not otherwise", [shown.includes(words), shown.includes('role="note"'), quiet.includes("Only part of this month")], [true, true, false]);
  const shopStats = (await readStats(shop))!;
  is("the numbers carry it to the studio, for the store page item by item", [shopStats.readsPartial, studioStats(shop, shopStats, null, "none", []).readsPartial], [partial, partial]);
  is("and nothing when the readings were within it", studioStats(suspendedShop, (await readStats(suspendedShop))!, null, "none", []).readsPartial, null);
  const panel = readFileSync("components/stats-panel.tsx", "utf8");
  const depthRoute = readFileSync("app/api/store/depth/route.ts", "utf8");
  is("the screens say it: the store page's numbers and the sales page editor", [panel.includes("readingsPartialWords(data.readsPartial.counted, data.readsPartial.opens)"), depthRoute.includes("readingsPartial(store)"), readFileSync("components/page-editor.tsx", "utf8").includes("partial={partial}")], [true, true, true]);

  part("What a page check keeps is bounded");
  for (let i = 0; i < READ_WINDOWS_HELD + 5; i += 1) noteReadStore(`held${String(i).padStart(10, "0")}`, store);
  is("the oldest are let go past READ_WINDOWS_HELD", [readToken("held0000000000", PRODUCT, Date.now(), nonce(true)), readToken(`held${String(READ_WINDOWS_HELD + 4).padStart(10, "0")}`, PRODUCT, Date.now(), nonce(true)).length > 0], ["", true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
