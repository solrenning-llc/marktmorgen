/**
 * What four reads cost at the most, and how many units of a store's window
 * each takes before it reads anything (owner's rule MR, 27 October 2026: a
 * ceiling before every spend; an unknown cost is never zero). Found by the
 * inventory of public and studio reads without a ceiling (C4-4):
 *
 *   community search   app/[handle]/community/search/page.tsx: a member's
 *                      search takes SEARCH_REQUEST_UNITS of the store's
 *                      figure for buyers (takeAllowance "buyer", never the
 *                      visits' requests), more for the room and the messages
 *                      when they are on, and WALK_STEP_UNITS for each step of
 *                      the one-time walk (lib/community-walk.ts); the
 *                      creator's own search takes its studio requests
 *                      (countStudio), each counted in its figure's units.
 *   booking calendar   app/api/store/calendar/[token]/route.ts: the
 *                      creator's private feed, read by their calendar app,
 *                      takes CALENDAR_READ_UNITS studio requests on every
 *                      answer and CALENDAR_BUILD_UNITS more before the file
 *                      is made again from Stripe.
 *   product update     lib/product-updates.ts, startUpdate: reading the
 *                      store's paid sales to find a product's buyers takes
 *                      UPDATE_READ_UNITS studio requests first.
 *   studio totals      app/studio/totals/page.tsx: each store's numbers
 *                      (its sales and memberships, read from Stripe) take
 *                      TOTALS_STORE_UNITS of that store's studio requests.
 *
 * Each worst case is a ReadShape: wall seconds held at 2 GB, CPU seconds,
 * database commands, bytes moved through the database, bytes sent on to the
 * browser, and pages of the creator's Stripe account waited on (each at
 * EXPORT_PAGE_SECONDS, as lib/store-export.ts prices them; Stripe bills no
 * API call). tests/plan-cost-registry.test.ts prices each shape with the
 * registry's own rates and fails when its units cost less than it. Sizes no
 * code caps are review ceilings, said so where they are set.
 */
import { MAX_CHAT_KEPT, MAX_CHAT_TEXT } from "@/lib/community-chat-rules";
import { MAX_DISPLAY_NAME, MAX_EVENT_ABOUT, MAX_EVENT_TITLE, MAX_POST_TEXT, MAX_POST_TITLE, MAX_SPACES } from "@/lib/community-text";
import { MAX_INDEXED_WORDS, SEARCH_PAGE } from "@/lib/community-search";
import { MAX_MESSAGE_TEXT, SEARCH_CONVERSATIONS, SEARCH_MESSAGES } from "@/lib/community-dm";
import { MAX_BODY_LENGTH, MAX_LESSONS, MAX_MODULES } from "@/lib/course";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_STORE_BYTES } from "@/lib/store";
import { MAX_UPDATE_RECIPIENTS } from "@/lib/product-updates-rules";
import { ALL_TIME_PAGES, STATS_DAYS } from "@/lib/stats";
import { CALENDAR_MAX_EVENTS } from "@/lib/calendar-sync";

export type ReadShape = {
  /** Wall seconds, held at 2 GB. */
  seconds: number;
  /** CPU seconds. */
  cpu: number;
  /** Database commands. */
  commands: number;
  /** Bytes moved through the database, both ways. */
  dbBytes: number;
  /** Bytes sent on to the browser or the calendar app. */
  outBytes: number;
  /** Pages of the creator's Stripe account waited on, one after another. */
  stripePages: number;
};

/** Bytes a stored character can take: three in UTF-8, a quote or backslash escaped in JSON two. */
const CHAR_BYTES = 3;
/** What a stored record adds around its text (ids, times, flags): a review ceiling. */
const RECORD_BYTES = 512;
/** A listing read from the catalog, at the most: the review ceiling tests/plan-cost-registry.ts already reads one at (NEXT_OFFER_READ). */
export const LISTING_READ_BYTES = 16_384;
/** A course's own record: its modules and lessons, each with five files at most. A review ceiling, 4 KB a lesson and 1 KB a module. */
export const COURSE_RECORD_BYTES = MAX_LESSONS * 4_096 + MAX_MODULES * 1_024;
/** A community member's record (name, address, answers): a review ceiling. */
export const MEMBER_RECORD_BYTES = 8_192;
/** What one access check of the community's door reads and writes in the database (lib/community-access.ts, ticketFor): its kept answer, the list's contact, what was brought over, the answer kept. */
export const GATE_COMMANDS = 6;
export const GATE_BYTES = 8_192;
/** The words an index write moves, both ways: what it held and what it writes (lib/community-search.ts, index). */
const INDEX_TRAFFIC_BYTES = 2 * MAX_INDEXED_WORDS * 96;
/** Commands one index write takes at the most: its read, a ZADD or ZREM for every word that came or went, and the SADD and SREM of its own list. */
export const INDEX_WRITE_COMMANDS = 1 + 2 * MAX_INDEXED_WORDS + 2;

// ---- The community search --------------------------------------------------

/** The search page's own time limit (its maxDuration), so the door's Stripe questions are bounded in time. */
export const SEARCH_SECONDS = 30;

/**
 * Commands of one search past the page itself (which isResting already
 * counts): the walk's mark (1); the four kinds searched at once, each a
 * ZINTERSTORE, EXPIRE, page and DEL (16); one more page of one kind (4); the
 * door of each of MAX_SPACES spaces (GATE_COMMANDS each); the tab built, the
 * dearest being lessons (one listing read and one door for each of
 * SEARCH_PAGE products, and their courses), events (each read and its door),
 * or posts (each read, its numbers and its poll); the names (1), the badge of
 * requests (1) and the unread notices (1).
 */
const TAB_COMMANDS = Math.max(
  SEARCH_PAGE * (1 + GATE_COMMANDS + 1),
  SEARCH_PAGE * (1 + GATE_COMMANDS),
  SEARCH_PAGE * (1 + 3 + 2),
);
export const SEARCH_COMMANDS = 1 + 16 + 4 + MAX_SPACES * GATE_COMMANDS + TAB_COMMANDS + 3;

/** A post's record at its longest. */
const POST_BYTES = (MAX_POST_TITLE + MAX_POST_TEXT) * CHAR_BYTES + 2 * RECORD_BYTES;
/** An event's record at its longest. */
const EVENT_BYTES = (MAX_EVENT_TITLE + MAX_EVENT_ABOUT) * CHAR_BYTES + 2 * RECORD_BYTES;
/** The tab built, at its dearest: SEARCH_PAGE lessons of as many courses, events, posts with their numbers and polls, or members. */
const TAB_BYTES = Math.max(
  SEARCH_PAGE * (LISTING_READ_BYTES + COURSE_RECORD_BYTES + GATE_BYTES),
  SEARCH_PAGE * (EVENT_BYTES + GATE_BYTES),
  SEARCH_PAGE * (POST_BYTES + 4_096),
  SEARCH_PAGE * MEMBER_RECORD_BYTES,
);
/** The names of whoever wrote what is listed: a page of posts, or the room's or messages' fifty shown, with the posts'. */
const NAMES_BYTES = (SEARCH_PAGE + 50) * MEMBER_RECORD_BYTES;
export const SEARCH_DB_BYTES = TAB_BYTES + NAMES_BYTES + MAX_SPACES * GATE_BYTES + 5 * SEARCH_PAGE * 2 * 64;
/** The page sent: fifty messages or twenty posts at their longest, and the page around them. */
export const SEARCH_OUT_BYTES = 50 * MAX_MESSAGE_TEXT * CHAR_BYTES + 200_000;

export const SEARCH_SHAPE: ReadShape = {
  seconds: SEARCH_SECONDS,
  // A review ceiling: parsing what is read and drawing the page. The door's waits are wall time, in `seconds`.
  cpu: 2,
  commands: SEARCH_COMMANDS,
  dbBytes: SEARCH_DB_BYTES,
  outBytes: SEARCH_OUT_BYTES,
  stripePages: 0,
};
/** The room read for the search, where it is on (lib/community-chat.ts, searchRoom): one read of its last MAX_CHAT_KEPT messages. */
export const SEARCH_ROOM_SHAPE: ReadShape = {
  seconds: 0, cpu: 0, commands: 1, outBytes: 0, stripePages: 0,
  dbBytes: MAX_CHAT_KEPT * (MAX_CHAT_TEXT * CHAR_BYTES + RECORD_BYTES),
};
/** This person's messages read for the search, where they are on (lib/community-dm.ts, searchMessages): SEARCH_CONVERSATIONS lists of SEARCH_MESSAGES. */
export const SEARCH_DM_SHAPE: ReadShape = {
  seconds: 0, cpu: 0, commands: 1 + SEARCH_CONVERSATIONS, outBytes: 0, stripePages: 0,
  dbBytes: SEARCH_CONVERSATIONS * SEARCH_MESSAGES * (MAX_MESSAGE_TEXT * CHAR_BYTES + RECORD_BYTES),
};

/** Members the one-time walk indexes in one step (lib/community-walk.ts). */
export const WALK_MEMBER_PAGE = 40;
/** A member's words: the name chosen, up to MAX_DISPLAY_NAME characters, at two letters and a space a word. */
const MEMBER_WORDS = Math.ceil(MAX_DISPLAY_NAME / 3);
/**
 * One step of the one-time walk: the dearest of one lesson (its listing, its
 * course, its body and its index write), one event (its place, the event and
 * its index write) or WALK_MEMBER_PAGE members (a page of the directory and an
 * index write each); with the walk's lock, place and mark (6).
 */
export const WALK_STEP_SHAPE: ReadShape = {
  seconds: 0,
  cpu: 0.2,
  commands: 6 + Math.max(3 + INDEX_WRITE_COMMANDS, 2 + INDEX_WRITE_COMMANDS, 2 + WALK_MEMBER_PAGE * (1 + 2 * MEMBER_WORDS + 2)),
  dbBytes: Math.max(
    LISTING_READ_BYTES + COURSE_RECORD_BYTES + MAX_BODY_LENGTH * CHAR_BYTES + INDEX_TRAFFIC_BYTES,
    EVENT_BYTES + INDEX_TRAFFIC_BYTES,
    (WALK_MEMBER_PAGE + 1) * MEMBER_RECORD_BYTES + WALK_MEMBER_PAGE * 2 * MEMBER_WORDS * 96,
  ),
  outBytes: 0,
  stripePages: 0,
};

/**
 * Units one search takes before it reads anything, in each figure's own
 * units: a member's from the store's figure for buyers (lib/store-allowance-rules.ts,
 * "buyer"; never the visits' requests, owner's decision of 4 November 2026,
 * 06h51), the creator's from the studio's requests.
 */
export type SearchUnits = { buyer: number; studio: number };
export const SEARCH_REQUEST_UNITS: SearchUnits = { buyer: 5, studio: 22 };
export const SEARCH_ROOM_UNITS: SearchUnits = { buyer: 1, studio: 1 };
export const SEARCH_DM_UNITS: SearchUnits = { buyer: 5, studio: 19 };
export const WALK_STEP_UNITS: SearchUnits = { buyer: 9, studio: 39 };

/** What one search takes, by what this community has on. */
export function searchUnits(on: { chat: boolean; dm: boolean }): SearchUnits {
  const sum = (by: keyof SearchUnits) => SEARCH_REQUEST_UNITS[by] + (on.chat ? SEARCH_ROOM_UNITS[by] : 0) + (on.dm ? SEARCH_DM_UNITS[by] : 0);
  return { buyer: sum("buyer"), studio: sum("studio") };
}

// ---- The booking calendar's private feed -----------------------------------

/** Pages of the store's checkouts read to make the file (lib/calls.ts, readCallSessions). */
export const CALENDAR_STRIPE_PAGES = 5;
/** Booked calls those pages can hold. */
export const CALENDAR_CALLS = CALENDAR_STRIPE_PAGES * 100;
/** The file at its largest: each event's lines, and each booking's name and address once. A review ceiling of 2 KB an event and 512 bytes a booking. */
export const CALENDAR_FILE_BYTES = CALENDAR_MAX_EVENTS * 2_048 + CALENDAR_CALLS * 512;

/** Every answer: the token and its settings, the store, the kept file, read; the file sent. */
export const CALENDAR_READ_SHAPE: ReadShape = {
  seconds: 1.5,
  cpu: 0.2,
  commands: 6,
  dbBytes: 2 * 4_096 + MAX_STORE_BYTES + CALENDAR_FILE_BYTES,
  outBytes: CALENDAR_FILE_BYTES,
  stripePages: 0,
};
/** The file made again: its Stripe pages, every call listing, four reads of each booking's room, the file kept. */
export const CALENDAR_BUILD_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: MAX_PRODUCTS + 4 * CALENDAR_CALLS + 1,
  dbBytes: MAX_PRODUCTS * LISTING_READ_BYTES + 4 * CALENDAR_CALLS * 1_024 + CALENDAR_FILE_BYTES,
  outBytes: 0,
  stripePages: CALENDAR_STRIPE_PAGES,
};
export const CALENDAR_READ_UNITS = 5;
export const CALENDAR_BUILD_UNITS = 140;

// ---- Telling a product's buyers it was updated ------------------------------

/** A PayPal sale's record, at the most: a review ceiling. */
const PAYPAL_SALE_BYTES = 2_048;
/**
 * Finding a product's buyers (lib/product-updates.ts, startUpdate): both of
 * the store's Stripe lists, ALL_TIME_PAGES pages each; the PayPal sales of
 * as many pages (two reads); and, once a week a product, the buyers written
 * for the send (500 to a command) and the job.
 */
export const UPDATE_READ_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: 2 + 2 + Math.ceil(MAX_UPDATE_RECIPIENTS / 500) + 5,
  dbBytes: ALL_TIME_PAGES * 100 * (PAYPAL_SALE_BYTES + 64) + MAX_UPDATE_RECIPIENTS * 320 + 8_192,
  outBytes: 0,
  stripePages: 2 * ALL_TIME_PAGES,
};
export const UPDATE_READ_UNITS = 16;

// ---- The studio's totals of every store -------------------------------------

/** A day's counts of a store, at the most: a review ceiling. */
const STATS_DAY_BYTES = 32_768;
/**
 * One store's numbers for the totals (lib/stats-report.ts, readNumbers; lib/membership-numbers.ts):
 * its sales (two lists of twenty pages), renewals (ten), refunds (five) and
 * disputes (three) from Stripe, its memberships and their invoices (twenty
 * each) when not kept; its days of counts and its PayPal sales and refunds.
 */
export const TOTALS_STORE_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: 2 * STATS_DAYS + 20,
  dbBytes: 2 * STATS_DAYS * STATS_DAY_BYTES + 2_501 * PAYPAL_SALE_BYTES,
  outBytes: 0,
  stripePages: 2 * 20 + 10 + 5 + 3 + 2 * 20,
};
export const TOTALS_STORE_UNITS = 30;
