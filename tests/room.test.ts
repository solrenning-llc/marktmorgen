/**
 * The live room: how often it asks, who may ask, and what the asking is
 * counted as (lib/chat-pace.ts, lib/chat-pass.ts, lib/chat-grant.ts).
 *
 * The room used to ask a route that read the store, the member and the
 * room every four seconds for as long as its tab was in front, and nothing
 * was set against what that cost. What is held here:
 *
 *   - the pace follows the room and the reader, and stops when nobody is
 *     there;
 *   - what is asked every few seconds is one read, opened by a pass, that
 *     the CDN may answer for everybody at once;
 *   - a pass opens a room for the ten minutes it was made in and the ten
 *     after, and no other room;
 *   - each ten minutes of asking is counted toward the store's visits once
 *     for a member, at what it can cost at the most, never for the creator,
 *     and a store with no plan to charge is given none past its visits;
 *   - what it is counted as is more than it costs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET as news } from "@/app/api/store/community/chat/new/route";
import { type Grant, grantRoom } from "@/lib/chat-grant";
import { AWAY_AFTER_MS, GRANT_MS, IDLE_LOOKS, IDLE_MS, LIVE_LOOKS, LIVE_MS, ROOM_GRANT_MINUTES, TALKING_FOR_MS, askEvery, isTalking, paceFor, shareFor } from "@/lib/chat-pace";
import { passFits, roomPass, slotOf } from "@/lib/chat-pass";
import { HELP_SECTIONS } from "@/lib/help-content";
import { lastSaid, parseChatSetting, quietFor, room, say } from "@/lib/community-chat";
import { monthKey } from "@/lib/delivery";
import { allowanceWindow } from "@/lib/allowance-window";
import { claimHandle, setCommunity, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { readConfig, saveConfig } from "@/lib/community";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as roomRoute } from "@/app/api/store/community/chat/route";
import { NextRequest } from "next/server";
import { isResting, recordParts, recordVisit, trafficIn, visitedFolders, visitsIn } from "@/lib/traffic";
import { PARTS_PER_VISIT, ROOM_IDLE_PARTS, ROOM_LIVE_PARTS, SETUP_VISITS, VISITS_INCLUDED, partsWords, roomHourWords } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { STORE_READS, roomLeaveCost, roomLookCost, roomMinutesCost, visitCost } from "./traffic-cost";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ROOM = "c".repeat(32);
const OTHER = "d".repeat(32);
const ANA = "a1a1a1a1a1a1";
const BIA = "b2b2b2b2b2b2";
const open = parseChatSetting({ on: true });

let commands = 0;
/** Reads of a store's whole record (lib/store.ts, nl:store:owner:), priced by the byte (tests/traffic-cost.ts, STORE_READS). */
let records = 0;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  for (const command of list) if (command[0] === "GET" && String(command[1]).startsWith("nl:store:owner:")) records += 1;
  return real(list);
}) as typeof redis.pipeline;

const ask = (query: string) => news(new Request(`https://marktmorgen.com/api/store/community/chat/new?${query}`) as never);
const leave = (given: Grant | "resting" | null): Grant => {
  if (!given || given === "resting") throw new Error("no leave was given");
  return given;
};

async function main(): Promise<void> {
  redis.clear();
  const MINUTE = 60_000;

  part("How often an open room asks");
  is("while people are talking and the reader is there: every few seconds", [paceFor(0, 0), paceFor(TALKING_FOR_MS - 1, AWAY_AFTER_MS - 1), askEvery("live")], ["live", "live", LIVE_MS]);
  is("while the room is quiet: twice a minute", [paceFor(TALKING_FOR_MS, 0), paceFor(Number.POSITIVE_INFINITY, 0), askEvery("idle")], ["idle", "idle", IDLE_MS]);
  is("a reader who has walked away from the page is asked for nothing, however busy the room", [paceFor(0, AWAY_AFTER_MS), paceFor(0, Number.POSITIVE_INFINITY), paceFor(0, Number.NaN)], ["stopped", "stopped", "stopped"]);
  is("the figures the page prints", [LIVE_MS, IDLE_MS, AWAY_AFTER_MS / MINUTE, ROOM_GRANT_MINUTES], [5_000, 30_000, 20, 10]);
  is("a leave lasts ten minutes, which is so many looks at each pace", [GRANT_MS / MINUTE, LIVE_LOOKS, IDLE_LOOKS], [10, 120, 20]);
  is("an answer is shared for a little under how often its readers ask", [shareFor("live") * 1000 < LIVE_MS, shareFor("idle") * 1000 < IDLE_MS], [true, true]);
  is("a room is talking for a few minutes after anything was said", [isTalking(0), isTalking(TALKING_FOR_MS - 1), isTalking(TALKING_FOR_MS), isTalking(-1)], [true, true, false, false]);
  const page = readFileSync(join(process.cwd(), "components/community-room.tsx"), "utf8");
  is("the page asks nothing while its tab is in the background", /if \(document\.hidden\) return IDLE_MS;/.test(page), true);
  is("what it asks every few seconds is the shared route, without saying who it is", [/\/api\/store\/community\/chat\/new\?c=/.test(page), /credentials: "omit"/.test(page)], [true, true]);
  // The sentence is in the store's language (lib/buyer-words/community.ts); its numbers are these figures, handed over by the page.
  const chatPage = readFileSync(join(process.cwd(), "app/[handle]/community/chat/page.tsx"), "utf8");
  const roomWordsSource = readFileSync(join(process.cwd(), "lib/buyer-words/community.ts"), "utf8");
  is(
    "and it says how often it asks, from the same figures",
    [
      /live: LIVE_MS \/ 1000, idle: IDLE_MS \/ 1000, away: AWAY_AFTER_MS \/ 60_000/.test(chatPage),
      /every \$\{n\} seconds while people are talking and every \$\{more\} while the room is quiet/.test(roomWordsSource),
      /t\.paceNote/.test(page),
    ],
    [true, true, true],
  );

  part("The pass");
  const t0 = Date.UTC(2026, 9, 20, 12, 3, 0);
  const pass = roomPass(ROOM, t0);
  is("it is a few letters, made from the room and the ten minutes", [/^[0-9a-f]{32}$/.test(pass), roomPass(ROOM, t0 + MINUTE) === pass, roomPass(ROOM, t0 + GRANT_MS) === pass], [true, true, false]);
  is("it opens its room for those ten minutes and the ten after", [passFits(ROOM, pass, t0), passFits(ROOM, pass, t0 + GRANT_MS), passFits(ROOM, pass, (slotOf(t0) + 2) * GRANT_MS - 1)], [true, true, true]);
  is("and not a moment longer", passFits(ROOM, pass, (slotOf(t0) + 2) * GRANT_MS), false);
  is("it opens no other room", [passFits(OTHER, pass, t0), roomPass(OTHER, t0) === pass], [false, false]);
  is("nothing else opens one", [passFits(ROOM, "", t0), passFits(ROOM, "0".repeat(32), t0), passFits(ROOM, `${pass}0`, t0), passFits(ROOM, pass.toUpperCase(), t0)], [false, false, false, false]);
  is("an id that is not a community's has no pass", [roomPass("cm1", t0), passFits("cm1", "", t0)], ["", false]);

  part("Asking what is new");
  await say(ROOM, open, ANA, false, "Hello everyone", "Ana");
  await say(ROOM, open, "creator", true, "Welcome", "Harbor Kitchen");
  const now = roomPass(ROOM);
  commands = 0;
  const all = await ask(`c=${ROOM}&p=${now}&s=0`);
  const body = (await all.json()) as { ok: boolean; messages: { i: number; a: string; text: string; n?: string }[]; cursor: number };
  is("with the pass, the room is read", [all.status, body.ok, body.messages.map((m) => m.text)], [200, true, ["Hello everyone", "Welcome"]]);
  is("in one read of the database", commands, 1);
  is("each message carries the name it was said under, so nothing else is looked up", body.messages.map((m) => m.n), ["Ana", "Harbor Kitchen"]);
  is("the CDN may answer everybody who asks the same question, for a few seconds", all.headers.get("cache-control"), "public, max-age=0, s-maxage=3");
  const nothing = await ask(`c=${ROOM}&p=${now}&s=${body.cursor}&i=1`);
  is("asked since the last message, there is nothing, shared a little longer at a quiet room's pace", [((await nothing.json()) as { messages: unknown[] }).messages.length, nothing.headers.get("cache-control")], [0, "public, max-age=0, s-maxage=10"]);
  const refused = await ask(`c=${ROOM}&p=${"0".repeat(32)}&s=0`);
  is("without it, nothing is read and nothing is kept", [refused.status, refused.headers.get("cache-control"), ((await refused.json()) as { error: string }).error], [403, "no-store", "pass"]);
  is("another room's pass is no pass", (await ask(`c=${ROOM}&p=${roomPass(OTHER)}&s=0`)).status, 403);
  is("a room that is not one is not found", (await ask(`c=nope&p=${now}&s=0`)).status, 404);
  is("a message from before names were kept with it still reads", (await room(ROOM)).messages.length, 2);
  is("when the room was last spoken in is one read", [(await lastSaid(ROOM)) > 0, await lastSaid(OTHER), quietFor(0), quietFor(Math.floor(Date.now() / 1000)) <= 1], [true, 0, -1, true]);

  part("Leave to ask, and its count");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  const t1 = Date.UTC(2026, 9, 20, 15, 0, 0);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod(t1) });
  const paid = (await storeForEmail("owner@example.com"))!;
  const folder = await storeFolder("owner@example.com");
  // A paying store's visits are its billing month's (lib/allowance-window.ts); a store with no plan's, the calendar month's.
  const month = allowanceWindow(paid, t1)!.id;
  const calendar = monthKey(new Date(t1));
  const parts = async () => (await trafficIn(folder, month)).parts;
  const first = leave(await grantRoom(paid, ROOM, { key: ANA, owner: false }, false, false, t1));
  is("a member's page is handed ten minutes at a quiet room's pace", [first.pass, first.ms, first.live], [roomPass(ROOM, t1), GRANT_MS, false]);
  is("counted toward the store's visits as that", await parts(), ROOM_IDLE_PARTS);
  const again = leave(await grantRoom(paid, ROOM, { key: ANA, owner: false }, false, false, t1 + 2 * MINUTE));
  is("drawn again, in a second tab or on a phone: the same leave, counted once", [again.ms, await parts()], [GRANT_MS - 2 * MINUTE, ROOM_IDLE_PARTS]);
  const eager = leave(await grantRoom(paid, ROOM, { key: ANA, owner: false }, true, false, t1 + 3 * MINUTE));
  is("a page cannot ask its way into the pace of a talking room while the room is quiet", [eager.live, await parts()], [false, ROOM_IDLE_PARTS]);
  const faster = leave(await grantRoom(paid, ROOM, { key: ANA, owner: false }, true, true, t1 + 4 * MINUTE));
  is("when the room starts talking, the same ten minutes go on at its pace", [faster.live, faster.ms], [true, GRANT_MS - 4 * MINUTE]);
  is("counted for the difference, never twice", await parts(), ROOM_LIVE_PARTS);
  const kept = leave(await grantRoom(paid, ROOM, { key: ANA, owner: false }, false, false, t1 + 5 * MINUTE));
  is("and what was counted is kept to the end of them", [kept.live, await parts()], [true, ROOM_LIVE_PARTS]);
  const next = leave(await grantRoom(paid, ROOM, { key: ANA, owner: false }, true, true, t1 + GRANT_MS));
  is("the next ten minutes are counted again", [next.ms, next.live, await parts()], [GRANT_MS, true, 2 * ROOM_LIVE_PARTS]);
  await grantRoom(paid, ROOM, { key: BIA, owner: false }, false, false, t1);
  is("another member is counted for themselves", await parts(), 2 * ROOM_LIVE_PARTS + ROOM_IDLE_PARTS);
  const own = leave(await grantRoom(paid, ROOM, { key: "creator", owner: true }, true, true, t1));
  is("the creator is given leave and never counted", [own.live, own.ms, await parts()], [true, GRANT_MS, 2 * ROOM_LIVE_PARTS + ROOM_IDLE_PARTS]);

  part("What it adds up to");
  const counted = 2 * ROOM_LIVE_PARTS + ROOM_IDLE_PARTS;
  is("hundredths of a visit become whole visits, rounded down", [(await trafficIn(folder, month)).visits, await visitsIn(folder, month)], [Math.floor(counted / PARTS_PER_VISIT), Math.floor(counted / PARTS_PER_VISIT)]);
  await recordVisit(paid, "203.0.113.9", t1);
  is("beside the people who came", await trafficIn(folder, month), { people: 1, parts: counted, visits: 1 + Math.floor(counted / PARTS_PER_VISIT) });
  is("a store whose only visits are its room is known to the daily job", (await visitedFolders(calendar)).includes(folder), true);
  is("what a page prints of it", [partsWords(ROOM_LIVE_PARTS), partsWords(ROOM_IDLE_PARTS), roomHourWords(ROOM_LIVE_PARTS), roomHourWords(ROOM_IDLE_PARTS)], ["2.6", "0.6", "16", "3.6"]);
  await recordParts(paid, (VISITS_INCLUDED.creator + 2_000) * PARTS_PER_VISIT, t1);
  // Since 17 October 2026 visits past a plan are not sold: the room past the figure rests, and nothing is billed.
  is("and past the plan's visits the room rests like the store's other buyer pages", await isResting(paid, t1, "buyer"), true);
  is("nothing is counted that is not a whole number of hundredths", [await recordParts(paid, 0, t1), await recordParts(paid, 1.5, t1), await recordParts(paid, -5, t1)], [null, null, null]);

  part("A store with no plan to charge");
  await claimHandle("free@example.com", "nobill", "No Bill", "");
  const unpaid = (await storeForEmail("free@example.com"))!;
  const free = await storeFolder("free@example.com");
  const some = leave(await grantRoom(unpaid, OTHER, { key: ANA, owner: false }, true, true, t1));
  is("is given leave while it has visits left, counted like any other", [some.live, (await trafficIn(free, calendar)).parts], [true, ROOM_LIVE_PARTS]);
  await recordParts(unpaid, SETUP_VISITS * PARTS_PER_VISIT, t1);
  is("past them its pages rest", await isResting(unpaid, t1), true);
  const before = (await trafficIn(free, calendar)).parts;
  is("a leave already handed out runs to its end", leave(await grantRoom(unpaid, OTHER, { key: ANA, owner: false }, true, true, t1 + MINUTE)).ms, GRANT_MS - MINUTE);
  is("and then none is given: the room is read by asking for it", [await grantRoom(unpaid, OTHER, { key: ANA, owner: false }, true, true, t1 + GRANT_MS), await grantRoom(unpaid, OTHER, { key: BIA, owner: false }, false, false, t1)], ["resting", "resting"]);
  is("nothing more is counted", (await trafficIn(free, calendar)).parts, before);
  is("its creator is still never refused", leave(await grantRoom(unpaid, OTHER, { key: "creator", owner: true }, false, false, t1)).ms, GRANT_MS);
  is("a paid store at its finite threshold receives no new polling grant", await grantRoom(paid, ROOM, { key: "c3c3c3c3c3c3", owner: false }, false, false, t1), "resting");
  is("the page of a resting room has a button and asks nothing by itself", [/t\.checkNew/.test(page) && /checkNew: "Check for new messages"/.test(roomWordsSource), /pace === "stopped" \|\| restingNow\.current\) return IDLE_MS;/.test(page)], [true, true]);

  part("What it is counted as is never less than what it can cost");
  const part$ = visitCost() / PARTS_PER_VISIT;
  // What the room counts against a plan's visits is never below what it
  // costs. Above that it is not tied to a cost: the talking room's 260
  // hundredths and the quiet room's 60 are the figures the customer is shown
  // (the help page and the Terms), and the owner kept 260 on 4 November 2026
  // (C2-58). Until 4 November 2026 these checks also held each figure within
  // a little of its cost; since a visit pays for reading the store's whole
  // record (tests/traffic-cost.ts, STORE_READS) a visit costs more and the
  // same ten minutes are fewer hundredths of one, so the figures sit well
  // over their cost, printed below. Lowering them is the owner's decision.
  const liveCost = roomMinutesCost(LIVE_LOOKS);
  const idleCost = roomMinutesCost(IDLE_LOOKS);
  is("ten minutes of a talking room, every look answered by the database", liveCost <= ROOM_LIVE_PARTS * part$, true);
  is("ten minutes of a quiet one", idleCost <= ROOM_IDLE_PARTS * part$, true);
  console.log(`ten minutes of a talking room: ${(liveCost / part$).toFixed(1)} hundredths of a visit, counted as ${ROOM_LIVE_PARTS} (${((ROOM_LIVE_PARTS * part$ / liveCost - 1) * 100).toFixed(1)}% over); a quiet one: ${(idleCost / part$).toFixed(1)}, counted as ${ROOM_IDLE_PARTS} (${((ROOM_IDLE_PARTS * part$ / idleCost - 1) * 100).toFixed(1)}% over)`);
  // Being handed leave reads the store's whole record once (STORE_READS.roomLeave), a megabyte at the most.
  is("a look is a small thing, and being handed leave a larger one", [roomLookCost() < 0.000006, roomLeaveCost() < 0.0001, roomLeaveCost() > roomLookCost()], [true, true, true]);
  // Held, not only said (4 November 2026, independent review of #1496): the
  // route that hands the leave (app/api/store/community/chat, GET with
  // grant) reads the store's whole record exactly as often as it is priced.
  await claimHandle("rooms@example.com", "rooms", "Rooms", "");
  await setSubscription("rooms@example.com", { customerId: "cus_Rooms00001", subscriptionId: "sub_Rooms00001", active: true, period: paidPeriod() });
  const roomsId = (await setCommunity("rooms@example.com", true))!.community!.id;
  await saveConfig(roomsId, { ...(await readConfig(roomsId))!, chat: open });
  const roomsSession = await openSession("rooms@example.com");
  const askLeave = () =>
    roomRoute(new NextRequest(`https://marktmorgen.com/api/store/community/chat?handle=rooms&grant=live`, { headers: { cookie: `${SESSION_COOKIE}=${roomsSession}`, "x-forwarded-for": "192.0.2.40" } }));
  records = 0;
  const leaveAnswer = (await (await askLeave()).json()) as { ok: boolean; grant: unknown };
  is("being handed leave reads the store's whole record as often as it is priced, and leave is given", [leaveAnswer.ok, Boolean(leaveAnswer.grant), records, records <= STORE_READS.roomLeave], [true, true, 1, true]);
  // What the room cost before: a look every four seconds at a route that
  // sent about ten commands, for as long as the tab was in front.
  const old = (GRANT_MS / 4_000) * (roomLookCost() + 9 * 0.000002);
  is("the same ten minutes used to cost several times as much, and were counted as nothing", old > 3 * roomMinutesCost(LIVE_LOOKS), true);

  part("What is published");
  const terms = readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8");
  const helpSource = readFileSync(join(process.cwd(), "lib/help-content.ts"), "utf8");
  const help = `${helpSource}\n${HELP_SECTIONS.flatMap((section) => section.items.flatMap((item) => item.a)).join("\n")}`;
  is("the Terms say what a buyer coming back counts as, from the figures the count is made from", [/ROOM_GRANT_MINUTES\} minutes it is open: \{partsWords\(ROOM_LIVE_PARTS\)\}/.test(terms), /partsWords\(ROOM_IDLE_PARTS\)\} of a visit while the room is/.test(terms), /one visit on each day their podcast app checks/.test(terms), /is that\s+day&apos;s visit, once/.test(terms)], [true, true, true, true]);
  is("the help page says the same, in the same figures", [help.includes(`by the ${ROOM_GRANT_MINUTES} minutes it is open, for each member: ${partsWords(ROOM_LIVE_PARTS)} visits while people are talking, when it checks every ${LIVE_MS / 1000} seconds, and ${partsWords(ROOM_IDLE_PARTS)} of a visit while the room is quiet`), help.includes(`one nobody has touched for ${AWAY_AFTER_MS / MINUTE} minutes, checks nothing and counts nothing`)], [true, true]);
  is("both say what a resting store's room does", [/stops checking by itself and shows new\s+messages when a member asks for them/.test(terms), /stops checking by itself,? and shows new messages when a member presses a button/.test(help)], [true, true]);

  const features = readFileSync(join(process.cwd(), "lib/feature-pages.ts"), "utf8");
  is("the page about communities says how often the room checks, and that it counts", features.includes(`The room checks for new messages every ${LIVE_MS / 1000} seconds while people are talking and every ${IDLE_MS / 1000} while it is quiet, and not at all in a background tab or after ${AWAY_AFTER_MS / MINUTE} minutes without a touch. Time in the room counts toward your plan's visits.`), true);

  part("A buyer who comes back is a visit");
  const pages = ["page", "chat/page", "events/page", "events/[event]/page", "leaderboard/page", "members/page", "messages/page", "messages/[pair]/page", "notifications/page", "post/[post]/page", "search/page", "you/page"];
  const sources = pages.map((name) => readFileSync(join(process.cwd(), "app/[handle]/community", `${name}.tsx`), "utf8"));
  is("every page of a community counts the member's day as it is drawn", sources.map((source) => /communityVisitor\(store, await cookies\(\)\)/.test(source) && !/communityViewer\(/.test(source)), pages.map(() => true));
  const door = readFileSync(join(process.cwd(), "lib/community-page.ts"), "utf8");
  is("for somebody who is in, and never for the creator", /viewer\.state === "in" && !viewer\.owner\) \{[\s\S]{0,300}await countDay\(store\)/.test(door), true);
  const course = readFileSync(join(process.cwd(), "app/[handle]/course/[product]/page.tsx"), "utf8");
  const lesson = readFileSync(join(process.cwd(), "app/[handle]/course/[product]/[lesson]/page.tsx"), "utf8");
  is("a course and each of its lessons count a student's day, never the creator's", [/!access\.learner\.owner\) \{[\s\S]{0,500}await countDay\(store\)/.test(course), /if \(student\) await countDay\(store\)/.test(lesson)], [true, true]);
  const day = readFileSync(join(process.cwd(), "lib/day-visit.ts"), "utf8");
  is("counted after the page is sent, by the address it came from, like any visit", [/after\(\(\) => recordVisit\(store, ip\)\)/.test(day), /x-forwarded-for/.test(day)], [true, true]);
  const routes = ["route.ts", "new/route.ts"].map((name) => readFileSync(join(process.cwd(), "app/api/store/community/chat", name), "utf8"));
  is("the routes a page asks things of are part of that visit and count no other", routes.map((source) => /countDay|communityVisitor/.test(source)), [false, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
