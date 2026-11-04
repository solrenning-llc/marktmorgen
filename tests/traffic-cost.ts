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
import { CAPPED_COUNT } from "@/lib/capped-count";
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { MAX_STORE_BYTES } from "@/lib/store";
import { RESEND_TIMEOUT_MS, SES_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { UPSTASH_MICRO_USD_PER_GB_TRANSFER } from "@/lib/spend-cost-table";
import { READ_SAMPLE } from "@/lib/page-read-sample";
import { SHARE_COMMANDS_PER_REQUEST } from "@/lib/traffic-rules";

export const CDN_PER_REQUEST = 2.0 / 1_000_000;
export const COMMAND = 2.0 / 1_000_000;
const CALL = 0.6 / 1_000_000;
const CPU_PER_SECOND = 0.128 / 3600;
const MEMORY_PER_SECOND = (0.0106 * 2) / 3600;
/** What a function sends the CDN, by the byte. */
const ORIGIN_PER_BYTE = 0.06 / 1_000_000_000;
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
   *
   * Since October 31, 2026 (313 [CV1]) what is BILLED, not what is sent:
   * Upstash bills a script as one command plus one for every redis.call it
   * runs (https://upstash.com/docs/redis/overall/billing, read that day),
   * and the count script (lib/capped-count.ts) was counted as one. Billed,
   * a returning visitor's view was 18 commands, and 32 at its heaviest (a
   * medium and a campaign beside its source, nine counts, with the day's
   * record at its most fields). The script was rewritten the same day to
   * read each hash's length once rather than before every count: 15, and 21
   * at the heaviest, measured in tests/traffic.test.ts. The most one view
   * can send is the store's first of the day, by somebody new, with both
   * records at their most: 29 measured, held by tests/traffic.test.ts at
   * this and firstOfDay together (25 + 4 = 29). Held at 25.
   */
  frontCount: 25,
  /**
   * What a visitor new to the day adds, once: the visit, how long the day
   * is kept, and the store's all-time visitors. Since October 11, 2026 also
   * the expiry of the day's visitors, written with the visitor new to the
   * day rather than with every view. What the month is marked with is
   * counted apart, monthMark.
   */
  firstOfDay: 4,
  /**
   * What a month is marked with (lib/traffic.ts, markMonth): how long its
   * counts are kept, the line of stores the daily job reads and whose folder
   * this is, five commands. Written with the month's first visit and every
   * hundredth after, and the same with the live room's hundredths (each
   * hundred visits' worth); tests/traffic.test.ts measures it landing on the
   * heaviest view there is, the store's first of the day (4 November 2026:
   * until then it was said to fit inside firstOfDay, which it did not).
   * Priced on every visit at MONTH_MARKS_PER_VISIT.
   */
  monthMark: 5,
  /**
   * Drawing another page of the store, and saying it was opened. On a
   * product's own page that also counts the page's view (lib/stats.ts, added
   * 8 October 2026): two commands more, measured, and a third once a day.
   */
  laterPage: 10,
  /**
   * Saying another page was opened, billed (October 31, 2026, as frontCount):
   * 10 measured on a product's page, and 11 with the day's record at its
   * most. 8 before, counting the script as one command.
   */
  laterCount: 11,
  /**
   * How a page was read (lib/page-read.ts), sent as a visitor leaves it by
   * one visitor in READ_SAMPLE: one command, and an expiry the first time a
   * block of a sales page is counted at all, which is once per block and not
   * per visit. Until October 11, 2026 this went through the store's general
   * count at seven commands and was in none of these sums.
   *
   * Billed (October 31, 2026, as frontCount): its count is the count script
   * with one name, its length read and its count, and the expiry the first
   * time: 4 at the most, 3 and 4 measured. It was held at 1, the script alone.
   */
  readBeacon: 4,
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
   * visit and starts the day's count of it, and each time after.
   */
  feedFirst: 13,
  feed: 9,
  /**
   * A signal that is not a page (app/api/store/hit, k "l", "a" or "f"): a
   * click on one of the store's links, an arrival through an affiliate's
   * link, a step of a funnel. Measured on the path that counts (4 November
   * 2026, independent review of #1496), by a visitor signed in to another
   * store, whose session is read, with an approved affiliate and a funnel's
   * real step, each taking its place on the store's count of signals
   * (lib/traffic.ts, takeSignal): held in tests/traffic.test.ts at the
   * heaviest of the three, never more than two over it. 15 measured for a
   * link's click (its count script billed with what it runs), 13 for an
   * affiliate's visit and 10 for a funnel's step. Third round of the review
   * (4 November 2026): the address's and the store's allowances asked before
   * the store is read, the count's expiry in the same write, and the heavier
   * paths measured too (a link's first click of the day, an affiliate's visit
   * from a paid ad by another affiliate's browser): 19 at the most. A store
   * in its trial reads its place in the pool as well, one more, priced in
   * nonPayingWorst.
   */
  signal: 19,
};

/**
 * The marks a month gets, shared over its visits: the month's first visit,
 * every hundredth after, and the same for the live room's hundredths (its
 * first and every hundred visits' worth), so 2 + visits / 100 at the most.
 * A fiftieth on every visit pays for them in any month of 200 visits or more;
 * a plan's worst month is every visit it covers, the fewest of which is
 * Store's 3,400 (lib/traffic-rules.ts, VISITS_INCLUDED), and a store under
 * 200 visits costs less in all than one at its plan's figure.
 */
export const MONTH_MARKS_PER_VISIT = 1 / 50;

/**
 * The count script (lib/capped-count.ts, CAPPED_COUNT) is sent whole with
 * every EVAL, not by its hash, so each one moves its bytes through the
 * database, priced by the byte as tests/plan-cost-registry.ts prices them
 * (Upstash's bandwidth, lib/spend-cost-table.ts). How many a visit sends is
 * measured in tests/traffic.test.ts and held to these figures: the front
 * page's count, a later page's, and a reading of a page.
 */
export const EVAL_BYTES = Buffer.byteLength(CAPPED_COUNT);
const DB_BYTE = UPSTASH_MICRO_USD_PER_GB_TRANSFER / 1_000_000 / 1e9;
export const EVALS = {
  /** The front page's view and its visit: the view's counts go in one script (lib/stats.ts, recordHit), 1 measured. */
  frontCount: 1,
  /** A later page's count, with the product's own visitor: 1 measured. */
  laterCount: 1,
  /** A reading of a page (lib/page-depth.ts): 1 measured. */
  readBeacon: 1,
  /** A signal that is not a page: a link's click is one count script, an affiliate's visit and a funnel's step none. */
  signal: 1,
};
const evalCost = (n: number) => n * EVAL_BYTES * DB_BYTE;

/**
 * The store's record is read whole from the database (lib/store.ts,
 * storeForHandle and storeForPage), up to MAX_STORE_BYTES, and every byte read
 * is billed as the EVAL's are. Until 4 November 2026 (independent review of
 * #1496) no visit paid for it. Reads of the record, measured in
 * tests/traffic.test.ts: each page drawn reads it once, each count a page
 * sends (app/api/store/hit) once more, and the live room's leave once
 * (app/api/store/community/chat). A reading of a page does not read it.
 */
export const STORE_READS = { page: 1, count: 1, roomLeave: 1, signal: 1 };
const storeReadCost = (n: number) => n * MAX_STORE_BYTES * DB_BYTE;


/**
 * The busy-day email (lib/stats-report.ts, maybeBusyAlert), asked by a
 * view when the day's views reach 64, 128, 256 and so on: at most once a
 * store a day for each power of two a day's count can reach, and a day's
 * count is a 64-bit integer in the database, so from 2^6 to 2^62, BUSY_POWERS.
 * Commands, as tests/numbers-three.test.ts measures them (4 November 2026).
 * The fortnight is read once a day unless the request reading it dies before
 * writing it down: its claim then lapses after a minute
 * (lib/stats-report.ts, BUSY_CLAIM_SECONDS) and the next power of two reads
 * it again, so the day is priced as if every power of two were its first.
 */
export const BUSY = {
  /** The day's first ask: whether the day is kept, its claim, the fourteen days before, and keeping them. */
  first: 17,
  /** Any later ask that day: the fourteen days read back, or that the email has gone. */
  later: 1,
  /** On a busy day before the email has gone, each ask also: whether the creator stopped the emails. */
  busy: 1,
  /**
   * The one that sends: the day's email claim and its mark and today's
   * channels (3), and the sender's own bookkeeping. Measured on Resend, 2
   * (its monthly count), 5 in all. Read from lib/email.ts and lib/ses.ts for
   * Amazon, which tests here cannot reach: Amazon's state read and, when
   * stale, written again (2), and either what Amazon took counted (2) or,
   * when the account refuses, its state set down (2), the day's notice to
   * the site's inbox claimed (1) and sent through Resend (2), and the email
   * itself sent through Resend (2): 9 at the most. 12 in all.
   */
  send: 12,
};
/**
 * How long the one that sends can hold its function, waiting on the
 * senders, all of it inside the view's request (lib/visit.ts awaits it):
 * Amazon's key borrowed and its account asked (8 s each, SES_TIMEOUT_MS),
 * three tries at Amazon (8 s each) with 1.2 s of pauses, and Resend twice,
 * the site's notice and the email, each three tries of 10 s
 * (RESEND_TIMEOUT_MS) with 3 s of pauses for a 429: 107.2 s, rounded up.
 */
export const BUSY_SEND_SECONDS = Math.ceil((2 * SES_TIMEOUT_MS + 3 * SES_TIMEOUT_MS + 1_200 + 2 * (3 * RESEND_TIMEOUT_MS + 3_000)) / 1000);
/** That time, at the memory held while waiting and a tenth of a second of work. */
export function busySendFunctionCost(): number {
  return BUSY_SEND_SECONDS * MEMORY_PER_SECOND + 0.1 * CPU_PER_SECOND;
}
export const BUSY_POWERS = 62 - 6 + 1;

/**
 * A store's day of the busy-day email at the most, in commands: every power
 * of two reached, each one reading the fortnight as the day's first would
 * (a claim left by a request that died lapses, BUSY.first), every one of them
 * on a busy day, and the email sent. The email itself is priced where emails
 * are (tests/plan-cost-registry.ts).
 */
export function busyDayCommands(): number {
  return BUSY_POWERS * (BUSY.first + BUSY.busy) + BUSY.send;
}

/** Answering one page and its count: two calls, a tenth of a second of work, and memory held while the database is waited on. */
const PAGE_AND_COUNT = 2 * CALL + 0.1 * CPU_PER_SECOND + 1.3 * MEMORY_PER_SECOND;

/**
 * One reading of a page sent as a visitor leaves it (lib/page-read.ts): the
 * request, the call, its command, a few thousandths of a second of work and
 * an empty answer.
 */
export function readBeaconCost(): number {
  return CDN_PER_REQUEST + CALL + COMMANDS.readBeacon * COMMAND + evalCost(EVALS.readBeacon) + 0.005 * CPU_PER_SECOND + 0.04 * MEMORY_PER_SECOND + 500 * ORIGIN_PER_BYTE;
}

/** What one visit costs at the most this is worked out for, in dollars. */
export function visitCost(): number {
  const later = PAGES_PER_VISIT - 1;
  const requests = 1 + STATIC_FILES + 1 + 1 + STORE_PAGE_SIZE + later * (1 + 1 + PICTURES_ON_A_LATER_PAGE);
  const commands = COMMANDS.frontPage + COMMANDS.frontCount + COMMANDS.firstOfDay + MONTH_MARKS_PER_VISIT * COMMANDS.monthMark + later * (COMMANDS.laterPage + COMMANDS.laterCount);
  // Every page of the visit is taken to be measured for how it is read, at the
  // share of visitors the pages send it for: the store's page and two sales pages.
  const reading = (PAGES_PER_VISIT / READ_SAMPLE) * readBeaconCost();
  const evals = evalCost(EVALS.frontCount + later * EVALS.laterCount);
  const records = storeReadCost(PAGES_PER_VISIT * (STORE_READS.page + STORE_READS.count));
  return requests * CDN_PER_REQUEST + commands * COMMAND + evals + records + PAGES_PER_VISIT * (PAGE_AND_COUNT + PAGE_BYTES * ORIGIN_PER_BYTE) + reading;
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
  return (1 + 1 + PICTURES_ON_A_LATER_PAGE) * CDN_PER_REQUEST + (COMMANDS.laterPage + COMMANDS.laterCount) * COMMAND + evalCost(EVALS.laterCount) + storeReadCost(STORE_READS.page + STORE_READS.count) + PAGE_AND_COUNT + PAGE_BYTES * ORIGIN_PER_BYTE;
}

/**
 * What a signal reads from the database besides the store's record and the
 * count script's answer, at the most: the session of a visitor signed in
 * elsewhere, a funnel at its most steps and names, an approved affiliate.
 * 893 bytes measured at the most (a funnel's step), held in
 * tests/traffic.test.ts; priced at 8,000, room for an affiliate's record with
 * every field it can carry.
 */
export const SIGNAL_READ_BYTES = 8_000;

/**
 * One signal that is not a page (app/api/store/hit, k "l", "a", "f"): its
 * request at the CDN, the call, its commands, its count script, the store's
 * record and what else it reads, a hundredth of a second of work, memory held
 * while the database is waited on, and an empty answer, with its connection's
 * share of the day written a batch at a time (SHARE_COMMANDS_PER_REQUEST).
 * Priced on its own line, SIGNALS_PER_VISIT for each visit of a plan's figure
 * (tests/plan-cost-registry.ts, signals).
 *
 * Not measured: a store whose period is funded (store.period.funded) asks
 * reservePaidResourceWindow, an EVAL of its own, before each signal, as before
 * each request. That path must be measured and priced here before
 * commercialMarginReady is switched on (independent review of #1496, 4
 * November 2026).
 */
export function signalCost(): number {
  return CDN_PER_REQUEST + CALL + (COMMANDS.signal + SHARE_COMMANDS_PER_REQUEST) * COMMAND + evalCost(EVALS.signal) + storeReadCost(STORE_READS.signal) + SIGNAL_READ_BYTES * DB_BYTE + 0.01 * CPU_PER_SECOND + 0.3 * MEMORY_PER_SECOND + 500 * ORIGIN_PER_BYTE;
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
  return CDN_PER_REQUEST + CALL + COMMANDS.roomLeave * COMMAND + storeReadCost(STORE_READS.roomLeave) + 0.03 * CPU_PER_SECOND + 0.3 * MEMORY_PER_SECOND + 4_000 * ORIGIN_PER_BYTE;
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
