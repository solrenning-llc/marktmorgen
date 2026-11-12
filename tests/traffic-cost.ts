/**
 * What a visit to a store costs us, worked out once for the two test files
 * that need it: tests/traffic.test.ts, which holds the counts below to what
 * the code really does, and tests/plan-margin.test.ts, which sets the sum
 * against what each plan brings in.
 *
 * The rates are the published ones, read on October 7, 2026, and they move
 * only when the vendors' do:
 *
 *   Vercel, CDN requests       $2.00 / million   (Flat Rate CDN, which this
 *                                                 account is on: each tier
 *                                                 is this much a million,
 *                                                 and the bytes sent are in
 *                                                 the tier, so a picture
 *                                                 costs a request and no
 *                                                 more whatever it weighs)
 *   Vercel, function calls     $0.60 / million
 *   Vercel, function CPU       $0.128 / hour
 *   Vercel, function memory    $0.0106 / GB-hour (2 GB for as long as a
 *                                                 request is being answered)
 *   Upstash, commands          $2.00 / million   (pay as you go, $0.20 a
 *                                                 hundred thousand)
 *
 * And what was measured on the live site that day. A store's front page,
 * opened for the first time: the page, 13 files of script and type that a
 * browser then keeps for a year, the count, the owner's photo and one
 * picture for each product drawn. The page took up to a second to answer
 * from the other side of the world.
 *
 * The visitor this is worked out for is heavier than visitors are: every one
 * of the 24 pictures a full page can hold is loaded, and two more pages are
 * opened after the first, each with pictures of its own. A visit is counted
 * once however many pages are opened (lib/traffic-rules.ts), so the pages
 * have to be in the cost of the one.
 *
 * What these figures count on, and what nothing here can check: that Flat
 * Rate CDN stays switched on in the host's billing settings. Without it the
 * bytes of every picture are charged by the gigabyte, and a visit can cost
 * thirty times this.
 *
 * One more rate, which Flat Rate CDN does not cover: what a function sends
 * the CDN ("Fast Origin Transfer", $0.06 a gigabyte in the region this runs
 * in). A page of a store is 44 KB as it travels, compressed, and 460 KB
 * before, measured on October 7, 2026; the host said on July 15, 2024 that
 * what travels between a function and the CDN is compressed, and the page is
 * costed as it travels, a little over. This is the figure to hold against
 * the host's own bill once real stores are visited: charged uncompressed, a
 * visit would cost a third more than is worked out here, which no plan's
 * price would fail to cover and every plan's margin would feel.
 *
 * And one more setting these figures count on, in the same place: that
 * Observability Plus stays switched off in the host's billing settings. It
 * was on by default (teams made on or after April 3, 2026 have it so) and
 * charged $1.20 for a million events, one for each call of a function and
 * more for what a function asks of the database: in the cycle to October
 * 7, 2026 it was 475,000 events against 137,000 calls. That is a tenth
 * more on a visit and nearly half as much again on a look at the live
 * room, in none of these sums. It was switched off that day; with it off
 * the host keeps a day of logs and charges nothing for them. The site
 * sends none of the host's Web Analytics or Speed Insights events, which
 * are charged by the event too.
 *
 * The same rates cost the two things a buyer's device does by itself: the
 * live room asking what is new (lib/chat-pace.ts), and a podcast app asking
 * for its feed (lib/podcast-access.ts). tests/room.test.ts and
 * tests/podcast.test.ts hold what each is counted as over what it costs.
 */
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { READ_SAMPLE } from "@/lib/page-read-sample";

export const CDN_PER_REQUEST = 2.0 / 1_000_000;
export const COMMAND = 2.0 / 1_000_000;
const CALL = 0.6 / 1_000_000;
const CPU_PER_SECOND = 0.128 / 3600;
const MEMORY_PER_SECOND = (0.0106 * 2) / 3600;
/** What a function sends the CDN, by the byte. */
export const ORIGIN_PER_BYTE = 0.06 / 1_000_000_000;
/** A page of a store as it leaves the function: 44 KB measured, costed at 48. */
export const PAGE_BYTES = 48_000;

/** Files of script and type a first visit fetches, as counted on the live page. */
export const STATIC_FILES = 13;
/** Pages a visit is costed at: the front page and two more. */
export const PAGES_PER_VISIT = 3;
/** Pictures on a page after the first. */
const PICTURES_ON_A_LATER_PAGE = 4;

/**
 * Commands a page may send to the database, at the most: what the model
 * allows for, which tests/traffic.test.ts holds the code under.
 */
export const COMMANDS = {
  /** Drawing the front page of a store that pays. */
  frontPage: 4,
  /**
   * Counting it: the store's stats and the visit. Since October 11, 2026 the
   * view also counts its country and kind of device on the day's record
   * (lib/stats.ts), two commands, paid for by no longer sending the day's
   * expiry and the all-time record's start on every view but with the day's
   * first one only. 12 measured with a country, held at 13; the visit as a
   * whole costs what it did (13 + 4, as 14 + 3 before). The same day it
   * gained who is on the store now (one command) and lost the all-time
   * record's count of views, which is now the sum of its sources (lib/stats.ts,
   * readLife): 12 measured, held at 12.
   */
  frontCount: 12,
  /**
   * What a visitor new to the day adds, once: the visit, how long the day
   * is kept, and the store's all-time visitors. A month's first visit, and
   * each hundredth after, writes five more (lib/traffic.ts, markMonth):
   * a twentieth of a command to the visit, inside what is rounded up here.
   * Since October 11, 2026 also the expiry of the day's visitors, written
   * with the visitor new to the day rather than with every view. Since
   * November 11, 2026 the count that creates the day's record also gives it
   * its expiry inside the script (lib/capped-count.ts, version 3): one
   * command, once a store a day, not once a visit, inside the room here.
   */
  firstOfDay: 4,
  /**
   * Drawing another page of the store, and saying it was opened. On a
   * product's own page that also counts the page's view (lib/stats.ts, added
   * 8 October 2026): two commands more, measured, and a third once a day.
   */
  laterPage: 10,
  laterCount: 8,
  /**
   * How a page was read (lib/page-read.ts), sent as a visitor leaves it by
   * one visitor in READ_SAMPLE: one command, and an expiry the first time a
   * block of a sales page is counted at all, which is once per block and not
   * per visit. Until October 11, 2026 this went through the store's general
   * count at seven commands and was in none of these sums.
   */
  readBeacon: 1,
  /**
   * Handing a member's page ten minutes' leave to ask the room, at the
   * route that knows who is asking: the store, the community's settings,
   * who this is and whether they are still in it, what is new, when the
   * room was last spoken in, and the leave and its count. Counted by
   * reading the code, with room over it: no test holds a member's whole way
   * in.
   */
  roomLeave: 20,
  /**
   * Putting a subscriber's feed together (tests/podcast.test.ts holds the
   * code under both): the day's first time, which also writes the day's
   * visit and starts the day's count of it, and each time after. The day's
   * count sends its expiry with every count since November 7, 2026 (finding
   * L1 on #2888), one command more each time after the first.
   */
  feedFirst: 13,
  feed: 10,
};

/** Answering one page and its count: two calls, a tenth of a second of work, and memory held while the database is waited on. */
const PAGE_AND_COUNT = 2 * CALL + 0.1 * CPU_PER_SECOND + 1.3 * MEMORY_PER_SECOND;

/**
 * One reading of a page sent as a visitor leaves it (lib/page-read.ts): the
 * request, the call, its command, a few thousandths of a second of work and
 * an empty answer.
 */
export function readBeaconCost(): number {
  return CDN_PER_REQUEST + CALL + COMMANDS.readBeacon * COMMAND + 0.005 * CPU_PER_SECOND + 0.04 * MEMORY_PER_SECOND + 500 * ORIGIN_PER_BYTE;
}

/** What one visit costs at the most this is worked out for, in dollars. */
export function visitCost(): number {
  const later = PAGES_PER_VISIT - 1;
  const requests = 1 + STATIC_FILES + 1 + 1 + STORE_PAGE_SIZE + later * (1 + 1 + PICTURES_ON_A_LATER_PAGE);
  const commands = COMMANDS.frontPage + COMMANDS.frontCount + COMMANDS.firstOfDay + later * (COMMANDS.laterPage + COMMANDS.laterCount);
  // Every page of the visit is taken to be measured for how it is read, at the
  // share of visitors the pages send it for: the store's page and two sales pages.
  const reading = (PAGES_PER_VISIT / READ_SAMPLE) * readBeaconCost();
  return requests * CDN_PER_REQUEST + commands * COMMAND + PAGES_PER_VISIT * (PAGE_AND_COUNT + PAGE_BYTES * ORIGIN_PER_BYTE) + reading;
}

/**
 * One page after a visit's first, at the most it costs: its request at the
 * CDN, the page and its count, its pictures, its commands and its bytes.
 * What each of a visit's later pages is costed at inside visitCost, and what
 * every public request a store answers past its visits' own pages is costed
 * at (tests/plan-cost-registry.ts, public-requests): a review ceiling for a
 * cart, a search, a download or the page after paying, none of which draws
 * more than a page does.
 */
export function laterPageCost(): number {
  return (1 + 1 + PICTURES_ON_A_LATER_PAGE) * CDN_PER_REQUEST + (COMMANDS.laterPage + COMMANDS.laterCount) * COMMAND + PAGE_AND_COUNT + PAGE_BYTES * ORIGIN_PER_BYTE;
}

/**
 * One look at what is new in a room, with the CDN holding no answer for it:
 * the request, the call, one read of the room, a few thousandths of a
 * second of work, memory held while the read is waited on, and an answer of
 * a couple of kilobytes. Every look is costed this way, though readers of
 * one room share most of theirs: a room with one reader in it shares none.
 */
export function roomLookCost(): number {
  return CDN_PER_REQUEST + CALL + COMMAND + 0.005 * CPU_PER_SECOND + 0.04 * MEMORY_PER_SECOND + 2_000 * ORIGIN_PER_BYTE;
}

/** Being handed ten minutes' leave to look: once, at the route that knows who is asking. */
export function roomLeaveCost(): number {
  return CDN_PER_REQUEST + CALL + COMMANDS.roomLeave * COMMAND + 0.03 * CPU_PER_SECOND + 0.3 * MEMORY_PER_SECOND + 4_000 * ORIGIN_PER_BYTE;
}

/** Ten minutes of the room for one member, at a number of looks. */
export function roomMinutesCost(looks: number): number {
  return looks * roomLookCost() + roomLeaveCost();
}

/** A feed as it leaves the function: a long show's, compressed. */
const FEED_BYTES = 40_000;

/**
 * Putting one subscriber's feed together: the request, the call, the reads
 * and the day's visit, a twentieth of a second of work, and memory held for
 * as long as it can take to ask the creator's payment account whether the
 * subscriber still pays.
 */
function feedCost(commands: number): number {
  return CDN_PER_REQUEST + CALL + commands * COMMAND + 0.05 * CPU_PER_SECOND + 0.5 * MEMORY_PER_SECOND + FEED_BYTES * ORIGIN_PER_BYTE;
}

/** A subscriber's day, with their feed put together a number of times. */
export function feedDayCost(times: number): number {
  return times <= 0 ? 0 : feedCost(COMMANDS.feedFirst) + (times - 1) * feedCost(COMMANDS.feed);
}
