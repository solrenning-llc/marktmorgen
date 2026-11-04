/**
 * Every metered feature's per-store worst month, in one registry (added 17
 * October 2026). tests/plan-cost-model.ts sums COST_LINES into worstCost,
 * which tests/spend-floor.test.ts holds to the owner's 60% after the 27.5%
 * stress tax, and tests/plan-cost-registry.test.ts fails when:
 *
 *   - a line's sources do not hold the constants it names (moved or renamed);
 *   - a counter in the code (withinLimit, withinMonth, withinStore,
 *     withinService, countUse) has a scope that no entry of SCOPES classifies,
 *     a store figure (takeAllowance) has a kind no line prices, or a file
 *     sends email with a meter EMAIL_SITES does not allow it;
 *   - an exported limit or cost constant in lib/ (a name with _PER_DAY,
 *     _MONTHLY, _INCLUDED, WORST_, _LIMITS, _BY_TIER, ALLOWANCE...) is cited by
 *     no line, no open item and no entry of NOT_A_COST.
 *
 * So a feature cannot add a per-use cost without saying where it is counted.
 *
 * Each line is the most one store on a plan can cost in one window at every
 * enforced cap at once, in dollars, from the rates in
 * lib/spend-cost-table.ts and tests/traffic-cost.ts. A request is costed by
 * the call, its CPU, 2 GB of memory for its wall time, its database commands
 * and the bytes it moves through the database; the shapes below are review
 * ceilings stated as such, like the visit's own (tests/traffic-cost.ts).
 * Daily windows that start with their first use can touch 32 windows of a
 * 31-day month; UTC-day and calendar-month counters touch 31 and 1.
 *
 * The window (since 17 October 2026, lib/allowance-window.ts) is the store's
 * billing month: one payment, one window, a monthly plan's period or a yearly
 * plan's month on the day it began, at most 31 days. So each allowance is
 * counted once per payment, as the floor test prices it. A billing month
 * touches 32 UTC days (part of its first and last), so a counter by the UTC
 * day is priced at DAY_WINDOWS, and one by the calendar month at two.
 *
 * OPEN lists the per-use costs that no monthly figure bounds yet. They are
 * not in worstCost, so the floor test does not certify them: the owner's rule
 * counts them as failing until each has a figure here.
 *
 * PER_PAYMENT_LINES (since 18 October 2026) are what one payment can leave
 * behind after its plan ends: what the store keeps until its closing day
 * (lib/plan-closing.ts), and its closing itself (closure). They happen once
 * a payment at the most, not once a window, and tests/spend-floor.test.ts
 * adds them once to each payment's worst case: so a store that paid once, a
 * single month, and closed carries all of it in that payment's own margin.
 */
import { paidStorageBytes } from "@/lib/storage-rules";
import { STORE_ALLOWANCES, NON_PAYING_ALLOWANCES, type AllowanceKind } from "@/lib/store-allowance-rules";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { EXTRA_REQUESTS, REQUESTS_PER_VISIT, SHARE_COMMANDS_PER_REQUEST, TRIAL_EXTRA_REQUESTS, TRIAL_VISITS } from "@/lib/traffic-rules";
import { TRIAL_ORDERS } from "@/lib/order-rules";
import { TRIAL_MONTHLY_EMAILS } from "@/lib/plan";
import { TRIAL_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { TRIAL_DAILY_RUNS } from "@/lib/flow-limits";
import { PAID_STORES_PER_FREE_STORE } from "@/lib/free-pool-rules";
import { monthlyEmails, type Tier } from "@/lib/plan";
import { FREE_PAUSE_ABOVE_BYTES } from "@/lib/delivery";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { TOP_HEIGHT, viewingBytes } from "@/lib/stream-rules";
import { VISITS_INCLUDED } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { AUTOMATIC_AI_STORE_MICRO_USD } from "@/lib/ai-spend-policy";
import { uploadWorstCostMicroUsd } from "@/lib/upload-budget-policy";
import { DAILY_RUNS_BY_TIER, WORST_COMMANDS_PER_RUN } from "@/lib/flow-limits";
import { IMPORT_ALLOWANCES, IMPORT_MIN_ROWS_PER_UPLOAD, IMPORT_WORST_BYTES_PER_ROW, IMPORT_WORST_COMMANDS_PER_ROW } from "@/lib/import-limits";
import { BATCH_BYTES, MAX_REPORT_ROWS } from "@/lib/imports";
import { MAX_TRIMMED_PAGE_CHARS } from "@/lib/clickfunnels-page";
import { IMPORTS_PER_SHARE_MONTH, MAX_APPLY_PAGES, PREVIEWS_PER_SHARE_MONTH, SHARE_LIMITS } from "@/lib/funnel-share-rules";
import { MAX_SECTION_BYTES } from "@/lib/saved-blocks";
import { MAX_PAGE_BYTES } from "@/lib/sales-page";
import { QUIZ_MONTHLY_SUBMISSIONS } from "@/lib/quiz-usage-rules";
import { TEAM_LIMITS } from "@/lib/team-scheduling-rules";
import { SYNC_SECONDS } from "@/lib/host-calendar";
import { MAX_TEAM } from "@/lib/team";
import { MAX_TASK_FILE_BYTES, TASK_ROOM_BYTES, TRIAL_TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { COMMUNITY_PICTURES, PICTURE_BYTES, TRIAL_COMMUNITY_PICTURES } from "@/lib/community-picture-rules";
import { CLOSING_DAYS, DEL_BATCH, ENDED_STORE_EXPORTS, FOLLOW_BATCH, RENEWALS_AT_ONCE, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { BUYER_SEND_DAYS, EMAILS_PER_BUYER_PER_ENDING, STRIPE_CALLS_PER_MEMBER, buyerNoticeCap } from "@/lib/closing-buyers-rules";
import { MAX_STORE_BYTES } from "@/lib/store";
import { BODIES_PER_READ } from "@/lib/course";
import { MAX_LEADS } from "@/lib/contact-rules";
import { DATA_ROOM_BYTES, ENTRY_BYTES, NON_PAYING_DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { ORDER_KEY_BYTES } from "@/lib/order-data";
import { PERSON_RECORD_MONTHS } from "@/lib/joined-stores";
import { FOLLOWED_FAMILIES } from "@/lib/data-families";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_LESSONS } from "@/lib/course";
import { MAX_POSTS } from "@/lib/store-blog";
import { MAX_FORMS } from "@/lib/forms";
import { EXPORT_COMMANDS, EXPORT_PAGE_SECONDS, EXPORT_STRIPE_PAGES } from "@/lib/store-export";
import { PATH_REFUND_PAGES, PATH_SALE_PAGES } from "@/lib/path-facts";
import { LIFE_WRITE_MAX } from "@/lib/stats";
import { MARK, cappedByteMonths, closingBytes, followedBytes, reserveBytes } from "./store-data-registry";
import {
  UPSTASH_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";
import { PAGES_PER_VISIT, laterPageCost, visitCost } from "./traffic-cost";
import { assistantMonthWorst } from "@/lib/store-assistant-rules";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { NEXT_OFFER_CHOICES, NEXT_OFFER_COMMANDS, NEXT_OFFER_PRODUCTS } from "@/lib/next-offer-rules";
import { ASSIST_REMIND_COMMANDS, ASSIST_REMIND_PRODUCTS } from "@/lib/assistant-reminder-rules";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";

export const GB = 1024 * 1024 * 1024;
/** Keeping a file, at the dearest of the three stores one may be in. */
export const STORAGE_PER_GB = 0.023;
/** Sending a file that is sold: nothing, from the store they are kept in. */
export const FILE_DELIVERY_PER_GB = 0;
export const STREAM_STORAGE_PER_GB = 0.02;
export const STREAM_DELIVERY_PER_GB = 0.005;
export const FETCHED_AHEAD = 1.25;
export const PER_EMAIL = 0.0009;
/** An order's pages and jobs, set well over a visit's whole page (tests/traffic-cost.ts). */
export const ORDER_COMPUTE = 0.0003;
/**
 * The access emails a plan's window holds (lib/store-allowance-rules.ts):
 * since 17 October 2026 counted and refused past the figure, before sending
 * (lib/email.ts, EmailMeter); until then a figure set high that no counter held.
 */
export const TRANSACTIONAL: Record<Tier, number> = {
  creator: STORE_ALLOWANCES.creator.transactional,
  pro: STORE_ALLOWANCES.pro.transactional,
  scale: STORE_ALLOWANCES.scale.transactional,
};

const micro = (n: number) => n / 1_000_000;
/** One database command, a byte moved through the database, a byte kept there a month. */
export const COMMAND = micro(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1_000_000;
export const DB_BYTE = micro(UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e9;
export const DB_BYTE_MONTH = micro(UPSTASH_MICRO_USD_PER_GB_MONTH) / 1e9;
const CALL = micro(VERCEL_CALL_MICRO_USD_PER_MILLION) / 1_000_000;
const CPU_SECOND = micro(VERCEL_CPU_MICRO_USD_PER_HOUR) / 3600;
const MEMORY_SECOND = (micro(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) * VERCEL_FUNCTION_GB) / 3600;

/**
 * What an order leaves that outlives its store, for its whole life (18
 * October 2026): the buyers' library entries it writes, the buyer's and a
 * gift's recipient's, two at the most, each in a quarter's set kept
 * PERSON_RECORD_MONTHS at the most (lib/joined-stores.ts), since a closing
 * store does not take itself out of them buyer by buyer.
 */
export const ORDER_LIBRARY = 2 * ENTRY_BYTES * PERSON_RECORD_MONTHS * DB_BYTE_MONTH;
/** How long one round of renewals stopped at Stripe, and one page of a store's memberships found there, is waited on at the most, held at 2 GB. */
export const STRIPE_WAIT_SECONDS = 2;
/**
 * The membership or payment plan an order may start, stopped at Stripe when
 * its store closes (lib/closed-store-data.ts, stopRenewals): its share of a
 * round of RENEWALS_AT_ONCE and of a page of a hundred found.
 */
export const ORDER_RENEWAL_STOP = (STRIPE_WAIT_SECONDS / RENEWALS_AT_ONCE + STRIPE_WAIT_SECONDS / 100) * MEMORY_SECOND;
/**
 * Queue item 307 [EC1]: not a line of any plan. What telling a closing
 * store's buyers and settling its members costs at the most, for each buyer
 * its cap allows (queue item 307 [EC1],
 * lib/closing-buyers.ts, lib/closing-holds.ts, lib/closing-refunds.ts): its
 * EMAILS_PER_BUYER_PER_ENDING emails at PER_EMAIL; its address and a
 * member's last payment kept until the store closes or stays, a few
 * kilobytes for the closing days, the day its notice may come early and the
 * week a late last notice adds; its share of a page of a hundred of the
 * store's own payments read to find it (lib/closing-buyers.ts, buyerPagesCap); and, as if every one were a member, the calls to Stripe a
 * membership's closing makes at the most, STRIPE_CALLS_PER_MEMBER, taken
 * from the closing's call budget before each is made (lib/closing-holds.ts,
 * takeCalls; its end is its order's, ORDER_RENEWAL_STOP), each waited on
 * STRIPE_WAIT_SECONDS at 2 GB, and a few commands.
 * One closing's whole cost is closingBuyersCost (below): a post-cancellation
 * funded exposure of docs/funded-exposure-review.md, the company's, bounded
 * per closing by its cap before any of it is spent (lib/closing-credit.ts).
 * At the price list of 18 October 2026 no plan has the room to carry it at
 * every payment (tests/limits-proposal.test.ts would cut Store's figures for
 * a few cents), so whether it moves into the closure line is the owner's.
 */
export const CLOSING_STRIPE_CALLS = STRIPE_CALLS_PER_MEMBER;
export const CLOSING_BUYER_COST = EMAILS_PER_BUYER_PER_ENDING * PER_EMAIL
  + 2 * 1024 * ((CLOSING_DAYS + WARN_WEEK_DAYS + BUYER_SEND_DAYS) / 30) * DB_BYTE_MONTH
  + (CLOSING_STRIPE_CALLS + 1 / 100) * STRIPE_WAIT_SECONDS * MEMORY_SECOND + 6 * COMMAND;
/** One closing's buyers and members at its cap, in dollars: a store of this plan that paid, or one that never did. */
export function closingBuyersCost(tier: Tier, paid = true): number {
  return buyerNoticeCap(tier, paid) * CLOSING_BUYER_COST;
}

/** What one order costs at the most: its confirmation, the email that says it shipped, its compute, and what it leaves for its store's closing. */
export const ORDER_COST = 2 * PER_EMAIL + ORDER_COMPUTE + ORDER_LIBRARY + ORDER_RENEWAL_STOP;

/** The shapes requests are costed at: wall seconds held at 2 GB, and CPU seconds. Review ceilings, not measurements. */
export const SHAPES = {
  /** A studio read or a small write: the visit model's page (tests/traffic-cost.ts). */
  light: { seconds: 1.3, cpu: 0.1 },
  /** A request that reads a body of up to a megabyte and works through it. */
  heavy: { seconds: 2, cpu: 0.5 },
  /** A request that writes many records: an import's step, a funnel made. */
  write: { seconds: 5, cpu: 1 },
  /** An import's step, which works for up to eight seconds (app/api/store/import, STEP_MS). */
  step: { seconds: 10, cpu: 2 },
  /** A studio request: the session, the store and its role read, and what the route does. */
  studio: { seconds: 1.5, cpu: 0.2 },
  /** A call to another service, waited on: a meeting made, a calendar or a site read. */
  wait: { seconds: 10, cpu: 0.2 },
} as const;

/** How often a day the page that says the studio is paused is drawn at the most (app/studio/paused/page.tsx, SHOWN_PER_DAY). */
export const PAUSED_PER_DAY = 20;

/** Commands a store figure costs to take (lib/store-allowance.ts): its count kept, and a store that pays nothing's place. */
export const TAKE_COMMANDS = 4;
/** What a function sends on to the browser, by the byte ("Fast Origin Transfer", tests/traffic-cost.ts). */
export const ORIGIN_PER_BYTE = 0.06 / 1e9;
/**
 * What the file store charges to hand a private file to a function that
 * reads it, by the byte: a review ceiling, twice Vercel Blob's published
 * data transfer rate, for the community pictures that pass through us
 * (app/api/store/community/image).
 */
export const BLOB_TRANSFER_PER_BYTE = 0.1 / 1e9;
/** How long a door's file may be kept before it is used or swept away, in months: a day, and the day the job may take to reach it. */
export const DOOR_KEPT_MONTHS = 2 / 31;
/** What one community picture costs to send: the request, the reads, a second held at 2 GB, and its megabyte from the file store and on to the browser. */
export const PICTURE_READ = request("light", 16) + PICTURE_BYTES * (ORIGIN_PER_BYTE + BLOB_TRANSFER_PER_BYTE);
/**
 * What one next product after a purchase costs besides the model (lib/next-offer.ts),
 * at the most: its commands and its counting, the listings it reads (a product's
 * heavy record among them), and up to five calls to the creator's Stripe account
 * waited on at 2 GB.
 */
export const NEXT_OFFER_READ = request("wait", NEXT_OFFER_COMMANDS + TAKE_COMMANDS, (NEXT_OFFER_PRODUCTS + NEXT_OFFER_CHOICES) * 16_384 + MAX_PRODUCT_BYTES + 4_096);
/**
 * What one Store assistant checkout reminder costs besides the model and its
 * email (lib/assistant-reminder.ts), at the most: its commands and its
 * counting, the store record read by the job (1 MB at the most), a cart's
 * listings and the consent, and two calls to the creator's Stripe account
 * waited on at 2 GB.
 */
export const ASSIST_REMIND_READ = request("wait", ASSIST_REMIND_COMMANDS + TAKE_COMMANDS, 1_000_000 + ASSIST_REMIND_PRODUCTS * 16_384 + 4_096);
/** One unit of each store figure, at the most it costs (lib/store-allowance-rules.ts). */
export const UNIT_COST: Record<AllowanceKind, number> = {
  // A studio request at its shape, its twenty commands and fifty kilobytes through the database.
  studio: request("studio", 20 + TAKE_COMMANDS, 50_000),
  // An API request: the key, the store and the answer.
  api: request("light", 20 + TAKE_COMMANDS, 20_000),
  // A message written to the inbox, and its index.
  inbox: request("light", 12 + TAKE_COMMANDS, 4_000),
  // An email sent from inside a request or a job already counted, and its count.
  email: PER_EMAIL + TAKE_COMMANDS * COMMAND,
  transactional: PER_EMAIL + (6 + TAKE_COMMANDS) * COMMAND,
  // A call out, waited on at 2 GB for ten seconds.
  integration: request("wait", 10 + TAKE_COMMANDS, 20_000),
  // What a buyer does inside what they bought (lib/buyer-actions.ts): the
  // heaviest is a post or comment that tells up to eleven people, their
  // devices pushed at once and waited on, its notices filed, its words
  // indexed, and its deletion later. A hundred commands, 60 KB through the
  // database and on to the browser, and a door's file of up to 10 MB kept
  // for as long as an unused door may be.
  buyer: request("wait", 100 + TAKE_COMMANDS, 60_000) + 60_000 * ORIGIN_PER_BYTE + (MAX_TASK_FILE_BYTES / GB) * STORAGE_PER_GB * DOOR_KEPT_MONTHS,
  // A webhook's try (lib/webhooks.ts): the delivery and the store read and written, the endpoint waited on for up to eight seconds.
  webhook: request("wait", 20 + TAKE_COMMANDS, 40_000),
};
/** A store figure in full, in dollars, for a plan or for a store that pays nothing. */
export function figureCost(allowances: Record<AllowanceKind, number>, kind: AllowanceKind): number {
  return allowances[kind] * UNIT_COST[kind];
}
/**
 * Commands each counted public request adds for a paying store: its count
 * (lib/traffic.ts, countRequest). A route's own burst limit is part of the
 * route, inside the later page it is costed at; a store that pays nothing
 * reads its place as well (nonPayingWorst). Since 18 October 2026 also its
 * connection's share of the day, written a batch of requests at a time
 * (lib/traffic-rules.ts, SHARE_COMMANDS_PER_REQUEST; docs/security-audit-2026-10-18.md,
 * MM-SA-01), priced on every request of the window.
 */
export const REQUEST_COMMANDS = 1 + SHARE_COMMANDS_PER_REQUEST;

/** What one request costs: its call, CPU, memory, database commands and the bytes it moves through the database. */
export function request(shape: keyof typeof SHAPES, commands: number, bytes = 0): number {
  const { seconds, cpu } = SHAPES[shape];
  return CALL + cpu * CPU_SECOND + seconds * MEMORY_SECOND + commands * COMMAND + bytes * DB_BYTE;
}

/**
 * One reading of Marktmorgen Path's money and counts (lib/path.ts, visitPath):
 * the numbers' all-time record at LIFE_WRITE_MAX fields of up to 96 bytes
 * each with the path's own record, the links counted, the record written,
 * and every page of the creator's Stripe account it reads waited on one
 * after another. Counted as PATH_READ_UNITS studio requests, taken before it
 * runs (tests/plan-cost-registry.test.ts holds the units above it).
 */
/** Path page's own bounded reads, including one actual studio-usage count. Money refreshes are separately reserved as PATH_READ_UNITS. */
/** Owner-only Path push: up to ten devices in parallel, eight-second timeout, no full-config rewrite for expired devices. Reserved before dispatch. */
export const PATH_REMINDER_PUSH = request("wait", 45, 500_000);
export const PATH_STUDIO_PAGE = request("heavy", 81, 404_096);
export const PATH_PAGE = request("heavy", 54, 120_000);
export const PATH_BOARD_JOIN = request("heavy",70,30_000);
export const PATH_BOARD_PRIVACY = request("heavy",30,120_000);

export const PATH_READ = request("heavy", 26, LIFE_WRITE_MAX * 96 + 20_480) + (PATH_SALE_PAGES + PATH_REFUND_PAGES) * EXPORT_PAGE_SECONDS * MEMORY_SECOND;

/** One host's calendar read: its commands, and the wait for the calendar, held at 2 GB inside the page that asked. */
export const TEAM_READING = 7 * COMMAND + 1 * MEMORY_SECOND + 0.05 * CPU_SECOND;
/** Commands a view of a team call's page costs: each host's claims, and one MGET of every host's calendar state and connection plus the round-robin counts (lib/team-booking.ts). */
export const TEAM_COMMANDS_PER_HOST_VIEW = 1;
export const TEAM_COMMANDS_PER_VIEW = 2;

/** Windows of a counter that a 31-day month can touch. */
export const DAY_WINDOWS = 32;
export const UTC_DAYS = 31;

/** Historical operating model only: encoded-size assumptions and fetched-ahead factor.
 * This is not a verified bound on provider bytes, replay, invoice rates or taxes. */
export function hourCost(): number {
  const gigabytes = (viewingBytes(3600, TOP_HEIGHT, Number.POSITIVE_INFINITY) / GB) * FETCHED_AHEAD;
  return gigabytes * STREAM_DELIVERY_PER_GB;
}

export type Source = { file: string; names: string[] };
export type CostLine = {
  id: string;
  /** The feature, and the change that added it where it is new. */
  feature: string;
  /** The most one store on this plan costs in a calendar month, in dollars. */
  monthlyUsd: (tier: Tier) => number;
  /** Where the caps and figures it uses are enforced. */
  sources: Source[];
  /** How the figure is worked out. */
  basis: string;
};

const ALL_TIERS_SAME = (usd: number) => () => usd;

export const COST_LINES: CostLine[] = [
  {
    id: "storage",
    feature: "Files and lesson files kept",
    monthlyUsd: (tier) => (paidStorageBytes(tier) / GB) * STORAGE_PER_GB,
    sources: [{ file: "lib/storage-rules.ts", names: ["PAID_STORAGE_BYTES", "paidStorageBytes"] }],
    basis: "The plan's storage, all used, at the dearest store a file may be in.",
  },
  {
    id: "free-delivery",
    feature: "Downloads (sold and free)",
    monthlyUsd: () => (FREE_PAUSE_ABOVE_BYTES / GB) * FILE_DELIVERY_PER_GB,
    sources: [{ file: "lib/delivery.ts", names: ["FREE_PAUSE_ABOVE_BYTES", "DELIVERY_ALLOWANCE_BYTES"] }],
    basis: "Files are sent from a store that charges nothing to send them; the download's request is OPEN item public-requests.",
  },
  {
    id: "video",
    feature: "Lesson video watched",
    monthlyUsd: (tier) => PAID_VIDEO_HOURS[tier] * hourCost(),
    sources: [
      { file: "lib/video-admission-rules.ts", names: ["PAID_VIDEO_HOURS"] },
      { file: "lib/watch-rules.ts", names: ["VIDEO_HOURS_INCLUDED", "VIDEO_SECONDS_INCLUDED", "VIDEO_CENTS_PER_HOUR_OVER"] },
    ],
    basis: "Every admitted hour watched. The legacy invoice line past 400 hours is never reached: admission stops at the plan's hours (tests/plan-cost-registry.test.ts holds it below).",
  },
  {
    id: "visits",
    feature: "Visits, public pages and buyers' pages together (collections #508 and checkout-script cards #518 are visits)",
    monthlyUsd: (tier) => VISITS_INCLUDED[tier] * visitCost(),
    sources: [
      { file: "lib/traffic-rules.ts", names: ["VISITS_INCLUDED", "publicVisitLimit", "BUYER_RESERVE_BPS", "VISIT_CENTS_PER_THOUSAND_OVER"] },
      { file: "lib/traffic.ts", names: ["isResting"] },
    ],
    basis: "The month's figure, every visit made by the heavy visitor a visit is costed as. Nothing is sold past it: public pages rest at 95% and buyers' pages at 100%.",
  },
  {
    id: "orders",
    feature: "Orders (checkouts, carts, offers after paying, PayPal orders, places, free copies; since 17 October 2026 call packages, and each booked call as CALL_ORDER_UNITS; since 18 October 2026 each paid payment request)",
    monthlyUsd: (tier) => ORDERS_INCLUDED[tier] * ORDER_COST,
    sources: [
      { file: "lib/order-rules.ts", names: ["ORDERS_INCLUDED", "paidOrdersLimitFor", "freeCopiesLimitFor", "ORDER_CENTS_PER_THOUSAND_OVER"] },
      { file: "lib/order-admission.ts", names: ["ADMIT_ORDERS", "admitOrders"] },
      { file: "lib/order-rules.ts", names: ["CALL_ORDER_UNITS", "TRIAL_ORDERS"] },
      { file: "lib/calls.ts", names: ["admitOrders(store, CALL_ORDER_UNITS)", "countOrder"] },
      { file: "lib/call-packages.ts", names: ["admitOrders(store, 1)"] },
      { file: "lib/group-buy.ts", names: ["placesHeld", "admitOrders(store, 1)", "settleAdmitted(store, hour)"] },
      // A payment request's checkout is one order, admitted before Stripe's page opens and counted at its receipt (18 October 2026).
      { file: "lib/payment-requests.ts", names: ["admitOrders(store, 1, now, 1)"] },
      { file: "lib/purchase-email.ts", names: ["confirmRequest", "countOrder"] },
      // An affiliate's lead for a free product or a booked call is written inside that order (18 October 2026).
      { file: "lib/calls.ts", names: ["recordLead"] },
      // A cart's checkout reads the offers of each of its products, and what each bundle in it hands over, at most MAX_CART of each, to know whose offers follow it (556 [CT1], 1 and 2 November 2026): reads only, inside that order.
      { file: "lib/cart-offers.ts", names: ["cartOfferOwner", "liveFunnel"] },
      { file: "lib/cart-rules.ts", names: ["MAX_CART = 4"] },
      { file: "app/api/store/free/download/route.ts", names: ["recordAffiliateLead"] },
    ],
    basis: "The plan's figure, each order at the most one costs. An affiliate's lead for a free product claimed or a booked call (lib/affiliate-leads.ts, 18 October 2026) is three or four commands inside that order's own work, which ORDER_COMPUTE prices at well over a whole page, and no email; what it keeps is in the data room, taken before it is written. Nothing is sold past it: new orders are admitted only while the month's orders and the checkouts held from the last day are under the figure. A place in a purchase for several people is an order of the month it is taken in: inside its checkout's hold for a day, admitted when taken after (since 18 October 2026), its emails access emails. A payment request's record is changed under its own lock (since 18 October 2026, docs/security-audit-2026-10-18.md, MM-SA-02): four commands more a change, at most a dozen changes a request (made, sent, reminded twice, opened, paid, refunded), inside the same ORDER_COMPUTE.",
  },
  {
    id: "list-email",
    feature: "The monthly emails: list email, sequences and workflows (#507), their notices to the owner, and emails to people brought over on Studio and Scale",
    monthlyUsd: (tier) => monthlyEmails(tier) * PER_EMAIL,
    sources: [
      { file: "lib/plan.ts", names: ["PRO_MONTHLY_EMAILS", "SCALE_MONTHLY_EMAILS", "TRIAL_MONTHLY_EMAILS"] },
      { file: "lib/mail.ts", names: ["reserve", "takeFromMonth"] },
    ],
    basis: "Every monthly email sent, at the most an email costs.",
  },
  {
    id: "transactional-email",
    feature: "Buyers' access emails: links to their purchases, a course, a private podcast, a community, a membership to manage, a member's sign-in, an affiliate's link (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "transactional"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "transactional"] },
      { file: "lib/email.ts", names: ["EmailMeter", "metered"] },
    ],
    basis: "The plan's access emails, each at the most an email costs and its count; taken from the store's window before sending, refused past it.",
  },
  {
    id: "store-email",
    feature: "The store's own emails outside the monthly ones: inbox notices and replies, a purchase sent again, contact-form and inbound-mail notices, checkout reminders, come-back, welcome and yearly offers, payment and pause notices to members, community events, affiliates, team invites (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "email"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "email"] },
      { file: "lib/email.ts", names: ["EmailMeter", "metered"] },
      { file: "lib/store-contact.ts", names: ["MAX_PER_DAY"] },
      { file: "lib/checkout-ask.ts", names: ["ASKS_PER_STORE_DAY"] },
      { file: "lib/assistant-reminder-rules.ts", names: ["ASSIST_REMINDERS_PER_STORE_DAY"] },
      { file: "lib/winback.ts", names: ["ONCE_PER_DAYS"] },
    ],
    basis: "The plan's store emails, each at the most an email costs and its count; the daily and per-person limits only spread them.",
  },
  {
    id: "ai",
    feature: "AI: writing jobs and visitor answers, AI funnel drafts (#517) and every other AI route",
    monthlyUsd: (tier) => micro(AUTOMATIC_AI_STORE_MICRO_USD[tier]),
    sources: [
      { file: "lib/ai-spend-policy.ts", names: ["AUTOMATIC_AI_STORE_MICRO_USD"] },
      { file: "lib/ai-rules.ts", names: ["AI_MONTHLY", "AI_PER_MINUTE"] },
      { file: "lib/answers-rules.ts", names: ["ANSWERS_MONTHLY", "ASKS_PER_DAY"] },
      { file: "lib/ai-request-rules.ts", names: ["AI_REQUEST_LIMITS"] },
      { file: "lib/funnel-ai.ts", names: ["askModel"] },
    ],
    basis: "The automatic monthly AI ceiling, reserved before every call; a funnel draft takes writing jobs from it like any other.",
  },
  {
    id: "uploads",
    feature: "Upload operations",
    monthlyUsd: (tier) => micro(uploadWorstCostMicroUsd(tier)),
    sources: [{ file: "lib/upload-budget-policy.ts", names: ["uploadWorstCostMicroUsd", "PAID_UPLOAD_OPENS"] }],
    basis: "Every upload operation the automatic upload allowance can start.",
  },
  {
    id: "workflows",
    feature: "Workflow runs (#507)",
    monthlyUsd: (tier) => DAILY_RUNS_BY_TIER[tier] * DAY_WINDOWS * WORST_COMMANDS_PER_RUN * COMMAND,
    sources: [{ file: "lib/flow-limits.ts", names: ["DAILY_RUNS_BY_TIER", "WORST_COMMANDS_PER_RUN", "TRIAL_DAILY_RUNS", "ACTIVE_FLOWS_BY_TIER", "WORKFLOW_LIMITS"] }],
    basis: "Every new run of every UTC day a billing month touches (32) at the run ceiling of commands. Steps run in the five-minute job, whose time the schedule bounds (a company fixed cost); emails and the owner's notices come out of the monthly emails.",
  },
  {
    id: "imports",
    feature: "Imports from another platform: rows, starts, steps, reports, and Store's emails to people brought over",
    monthlyUsd: (tier) => {
      const a = IMPORT_ALLOWANCES[tier];
      const rows = a.rows * (IMPORT_WORST_COMMANDS_PER_ROW * COMMAND + IMPORT_WORST_BYTES_PER_ROW * DB_BYTE);
      const uploads = (a.rows / IMPORT_MIN_ROWS_PER_UPLOAD) * request("heavy", 4, 0);
      const starts = a.starts * request("light", 20);
      const steps = a.steps * request("step", 10);
      const reports = a.reports * request("light", 4, MAX_REPORT_ROWS * 400);
      return rows + uploads + starts + steps + reports + a.movedEmails * PER_EMAIL;
    },
    sources: [
      { file: "lib/import-limits.ts", names: ["IMPORT_ALLOWANCES", "IMPORT_WORST_COMMANDS_PER_ROW", "IMPORT_WORST_BYTES_PER_ROW", "IMPORT_MIN_ROWS_PER_UPLOAD"] },
      { file: "lib/imports.ts", names: ["takeImportRows", "reserveMoved", "IMPORT_LIMITS"] },
      { file: "app/api/store/import/route.ts", names: ["import-start-month", "import-step-month", "import-report-month"] },
    ],
    basis: "Every row of the month at its command and transfer ceiling, every upload at the fewest rows one counts, every start, step and report download; Store's own emails to people brought over (Studio and Scale send theirs from the monthly emails).",
  },
  {
    id: "clickfunnels",
    feature: "Moving from ClickFunnels (#519): dry runs, saved pages read, funnel checks and funnels made",
    monthlyUsd: (tier) => {
      const a = IMPORT_ALLOWANCES[tier];
      return a.checks * request("heavy", 8 + 6, BATCH_BYTES)
        + a.buyerChecks * request("heavy", 506 + 6, BATCH_BYTES)
        + a.pageReads * request("heavy", 4, 2 * MAX_TRIMMED_PAGE_CHARS)
        + a.funnelChecks * request("heavy", 29, 10 * MAX_PAGE_BYTES)
        + a.funnelSaves * request("write", 200, 30 * MAX_PAGE_BYTES);
    },
    sources: [
      { file: "lib/import-limits.ts", names: ["IMPORT_ALLOWANCES"] },
      { file: "app/api/store/import/route.ts", names: ["import-preview-month", "import-preview-buyers-month"] },
      { file: "app/api/store/import/funnel/route.ts", names: ["import-cf-page-month", "import-cf-plan-month", "import-cf-save-month"] },
      { file: "docs/clickfunnels-import.md", names: ["Worst-case commands per call"] },
    ],
    basis: "Each path's monthly figure at docs/clickfunnels-import.md's command ceilings, each request at its shape and the bytes it moves.",
  },
  {
    id: "funnel-share",
    feature: "Sharing and copying funnels, starters and saved sections (#510)",
    monthlyUsd: (tier) => {
      const l = SHARE_LIMITS[tier];
      const kept = (l.shares * 2 * l.bundleBytes + l.savedBlocks * MAX_SECTION_BYTES) * DB_BYTE_MONTH;
      // A link's reads by other stores are counted by the calendar month: a billing month touches two.
      const linkReads = 2 * l.shares * (IMPORTS_PER_SHARE_MONTH * request("light", 6, l.bundleBytes) + PREVIEWS_PER_SHARE_MONTH * request("light", 4, 20_000));
      const own = l.importsPerMonth * request("write", 300, l.bundleBytes + 30 * MAX_PAGE_BYTES)
        + l.previewsPerMonth * request("light", 30, 50_000)
        + l.appliesPerMonth * request("write", MAX_APPLY_PAGES * 10, MAX_APPLY_PAGES * 4 * MAX_PAGE_BYTES)
        + l.sharesPerMonth * request("write", 60, 10 * MAX_PAGE_BYTES + 3 * l.bundleBytes)
        + l.exportsPerMonth * request("write", 40, 10 * MAX_PAGE_BYTES + l.bundleBytes);
      return kept + linkReads + own;
    },
    sources: [
      { file: "lib/funnel-share-rules.ts", names: ["SHARE_LIMITS", "IMPORTS_PER_SHARE_MONTH", "PREVIEWS_PER_SHARE_MONTH", "PREVIEWS_PER_STORE_HOUR", "MAX_APPLY_PAGES"] },
      { file: "lib/funnel-share-store.ts", names: ["storeMonthKey", "shareMonthKey"] },
      { file: "lib/saved-blocks.ts", names: ["MAX_SECTION_BYTES"] },
    ],
    basis: "Links and sections kept, every link read by others at its monthly figure in both calendar months a billing month touches, and every import, preview, update from a section, link made and file exported of the store's window, each page read and written with its earlier version.",
  },
  {
    id: "team-scheduling",
    feature: "Team event types and each host's calendar (#522)",
    monthlyUsd: (tier) => {
      const limits = TEAM_LIMITS[tier];
      // Hosts whose calendars a store's team calls can have read: every host of every team call, at most everybody on the store.
      const hosts = Math.min(limits.eventTypes * limits.hosts, MAX_TEAM + 1);
      const readings = hosts * Math.ceil((UTC_DAYS * 86_400) / SYNC_SECONDS) * TEAM_READING;
      // Every page of every visit after the first a team call's page, each reading each host's claims, state and connection.
      const views = VISITS_INCLUDED[tier] * (PAGES_PER_VISIT - 1) * (limits.hosts * TEAM_COMMANDS_PER_HOST_VIEW + TEAM_COMMANDS_PER_VIEW) * COMMAND;
      return readings + views;
    },
    sources: [
      { file: "lib/team-scheduling-rules.ts", names: ["TEAM_LIMITS", "TRIAL_TEAM_LIMITS", "SETUP_TEAM_LIMITS"] },
      { file: "lib/host-calendar.ts", names: ["SYNC_SECONDS", "STALE_SECONDS", "prefetchHosts"] },
      { file: "lib/team-booking.ts", names: ["prefetchHosts", "readClaims", "rrKey"] },
      { file: "lib/team.ts", names: ["MAX_TEAM"] },
    ],
    basis: "Each host's calendar read at most once a sync interval all month (about seven commands and its wait for the calendar inside the page that asked), and every later page of every visit a team call's page reading each host's claims (one command each), every host's calendar state and connection in one command, and the team's round-robin counts.",
  },
  {
    id: "quizzes",
    feature: "Course quiz submissions",
    monthlyUsd: ALL_TIERS_SAME(QUIZ_MONTHLY_SUBMISSIONS * request("light", 8)),
    sources: [{ file: "lib/quiz-usage-rules.ts", names: ["QUIZ_MONTHLY_SUBMISSIONS"] }],
    basis: "Every submission of the month, a request and its writes.",
  },
  {
    id: "collections",
    feature: "Collections and picks (#508)",
    monthlyUsd: ALL_TIERS_SAME(0),
    sources: [{ file: "app/[handle]/shop/[collection]/page.tsx", names: ["isResting"] }],
    basis: "A collection page is a public page of the store: it rests with them and counts as a visit, so it is inside the visits line.",
  },
  {
    id: "embed",
    feature: "Selling from any website (#518)",
    monthlyUsd: ALL_TIERS_SAME(0),
    sources: [{ file: "lib/embed-open.ts", names: ["isResting", "recordVisit", "OPENS_PER_TEN_MINUTES"] }],
    basis: "Page views load nothing from us; an open of a card counts as a visit and rests with the public pages, so it is inside the visits line, and a checkout from it is an order.",
  },
  {
    id: "public-requests",
    feature: "Requests beyond the counted visit: pages drawn again, the cart, searches, downloads, the page after paying, reviews, members' pages to manage, forms (17 October 2026)",
    monthlyUsd: (tier) => {
      const limit = REQUESTS_PER_VISIT * VISITS_INCLUDED[tier] + EXTRA_REQUESTS[tier];
      return EXTRA_REQUESTS[tier] * laterPageCost() + limit * REQUEST_COMMANDS * COMMAND;
    },
    sources: [
      { file: "lib/traffic-rules.ts", names: ["REQUESTS_PER_VISIT", "EXTRA_REQUESTS", "requestLimitFor"] },
      { file: "lib/traffic.ts", names: ["countRequest", "takePublicRequest", "requestsKey"] },
      { file: "lib/metered-limits.ts", names: ["withinStore"] },
      // A sign-up credited to an affiliate takes one of these before its lead is written (18 October 2026).
      { file: "lib/affiliate-leads.ts", names: ["takePublicRequest(store)", "count?: boolean"] },
      // The offers after a cart read what the buyer already has from the creator's Stripe account, counted before (556 [CT1], 1 November 2026).
      { file: "lib/cart-offers.ts", names: ["takeBuyerRead(store, CART_OFFER_REQUEST_UNITS)", "CART_OFFER_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS"] },
      // A signed proposal or agreement takes one more before the workflows that start on signing are checked (635 [GL3], 2 November 2026).
      { file: "lib/agreement-flow-trigger.ts", names: ["SIGNED_TRIGGER_UNITS", "takePublicRequest(store, \"buyer\", Date.now(), SIGNED_TRIGGER_UNITS)"] },
      // A payment request first written down as paid takes one more before the workflow that starts on it is checked (635 [GL3], 2 November 2026).
      { file: "lib/payment-flow-trigger.ts", names: ["PAID_TRIGGER_UNITS", "takePublicRequest(store, \"buyer\", Date.now(), PAID_TRIGGER_UNITS)"] },
    ],
    basis: "An affiliate's lead for a confirmed sign-up (lib/affiliate-leads.ts, 18 October 2026) takes one of the window's requests before it is written, and is not credited past them; its few commands stay inside a later page's, held in tests/affiliate-leads.test.ts. Every request of the window is counted, pages and public routes together, and the store rests at REQUESTS_PER_VISIT for each visit of its figure and EXTRA_REQUESTS more: the visits line already prices three pages a visit (tests/traffic-cost.ts), so the extra ones are priced here at a later page each (a review ceiling no public route passes), and every one at its count.",
  },
  {
    id: "studio",
    feature: "The studio's own reads and writes: every page of it drawn (STUDIO_PAGE_UNITS each), every save and read, its refreshing; and the never-paused plan, cancel, delete and data-download requests (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "studio") + ESSENTIAL_PER_DAY * DAY_WINDOWS * request("heavy", 40, 200_000) + PAUSED_PER_DAY * DAY_WINDOWS * request("light", 8),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "studio"] },
      { file: "lib/studio-allowance-rules.ts", names: ["STUDIO_PAGE_UNITS", "ESSENTIAL_PER_DAY", "ESSENTIAL_NEEDS"] },
      { file: "lib/studio-route.ts", names: ["countStudio", "studio-essential"] },
      // A deal entering a stage takes one more studio request before the workflow its stage starts is checked (17 October 2026).
      { file: "lib/deal-stage-trigger.ts", names: ["STAGE_TRIGGER_UNITS", "countStudio(store, null, STAGE_TRIGGER_UNITS)"] },
      // Marktmorgen Path reading its store's money and counts again takes PATH_READ_UNITS studio requests first, at most once every PATH_MONEY_SECONDS (18 October 2026).
      { file: "lib/path.ts", names: ["PATH_READ_UNITS", "countStudio(store, null, units)"] },
      { file: "lib/path-atomic.ts", names: ["WRITE_PATH", "FORGET_PATH", "PATH_DATA_CHANGE"] },
      { file: "lib/path-growth-facts.ts", names: ["PATH_GROWTH_READ_UNITS", "PATH_GROWTH_PRODUCTS", "PATH_GROWTH_CAMPAIGNS", "PATH_GROWTH_REVIEWS", "await charge(PATH_GROWTH_READ_UNITS)"] },
      { file: "lib/path-board-rules.ts", names: ["PATH_BOARD_ROOM_BYTES", "PATH_BOARD_ROWS", "PATH_BOARD_JOIN_UNITS"] },
      { file: "app/api/store/path/route.ts", names: ["PATH_BOARD_JOIN_UNITS", "board_leave", "delete"] },
      { file: "components/path-missions.tsx", names: ["PathMissions"] },
      { file: "lib/path-campaign.ts", names: ["pathCampaign"] },
      { file: "lib/path-checkout.ts", names: ["pathCheckoutNotice"] },
      { file: "components/path-studio-reminder.tsx", names: ["readStudioPathInvitation", "PathStudioReminder"] },
      { file: "lib/path-studio-reminder.ts", names: ["readPath", "readStudioPathInvitation"] },
      { file: "lib/path-reminder-rules.ts", names: ["PATH_REMINDER_UNITS"] },
      { file: "lib/path-reminder.ts", names: ["sendPathReminder", "PATH_REMINDER_UNITS"] },
      { file: "lib/path-facts.ts", names: ["PATH_SALE_PAGES", "PATH_REFUND_PAGES", "PATH_MONEY_SECONDS"] },
      { file: "app/studio/paused/page.tsx", names: [`SHOWN_PER_DAY = ${PAUSED_PER_DAY};`, "studio-paused"] },
    ],
    basis: "Every studio request of the window at the studio shape; a page drawn takes STUDIO_PAGE_UNITS of them, more than a heavy read costs (held below). Past the figure the studio shows one page, drawn at most PAUSED_PER_DAY times a day; changing or canceling the plan, deleting the store and downloading its sales take a small daily figure instead.",
  },
  {
    id: "rest-api",
    feature: "The REST API: every request with one of the store's keys, a contact added or a product given as API_WRITE_UNITS of them (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "api"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "API_WRITE_UNITS"] },
      { file: "lib/api-guard.ts", names: ["takeAllowance", "API_RATE"] },
      { file: "lib/api-write.ts", names: ["ADDS_PER_DAY", "GIVES_PER_DAY", "monthly_limit"] },
    ],
    basis: "The plan's API requests at a light request each; a write takes API_WRITE_UNITS of them, more than a write costs (held below). The per-minute and daily limits only spread them.",
  },
  {
    id: "inbox",
    feature: "The inbox: visitors' chats and messages, contact forms filed (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "inbox"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "inbox"] },
      { file: "lib/inbox.ts", names: ["takeAllowance"] },
      { file: "lib/inbox-rules.ts", names: ["NEW_PER_DAY", "VISITOR_PER_HOUR"] },
    ],
    basis: "Every message that arrives in the window, written with its index; the notices and replies it brings are store emails (line store-email).",
  },
  {
    id: "integrations",
    feature: "Calls to other services: meetings and Zoom, a host's calendar checked by hand, Discord, email platforms, Meta ads, PayPal, affiliate kits and pay-to, outreach reads of a business's site, person lookups, the vault, video upload doors and captions, email pictures (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "integration"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "integration"] },
      { file: "lib/metered-limits.ts", names: ["withinService", "withinServiceWhy"] },
    ],
    basis: "Every call of the window, held at 2 GB for ten seconds while the other service answers; what the service charges is nothing to us, and AI captions are bought apart.",
  },
  {
    id: "free-share",
    feature: "This store's share of the stores that pay nothing: free trials, stores with no plan, ended plans (17 October 2026, the owner's \"Teto mínimo pago pela empresa\")",
    monthlyUsd: () => nonPayingWorst() / PAID_STORES_PER_FREE_STORE,
    sources: [
      { file: "lib/free-pool-rules.ts", names: ["PAID_STORES_PER_FREE_STORE", "FREE_POOL_BASE_STORES", "freePoolSize"] },
      { file: "lib/free-pool.ts", names: ["admitNonPaying"] },
      { file: "lib/store-allowance-rules.ts", names: ["NON_PAYING_ALLOWANCES"] },
    ],
    basis: "A store that pays nothing does nothing that costs us without one of the month's places, and each PAID_STORES_PER_FREE_STORE paying stores add one place: so each paying store carries 1/PAID_STORES_PER_FREE_STORE of the worst window one of them can cost (nonPayingWorst). The FREE_POOL_BASE_STORES places the company pays for itself are a fixed cost, covered by the minimum paid base.",
  },
  {
    id: "buyer-actions",
    feature: "What buyers do inside what they bought: community posts, comments, likes, votes, reports, messages, live-room messages, RSVPs, picture doors and phones signed up; lesson comments, hand-ins and their doors, lessons marked done, certificates (18 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "buyer"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "buyer"] },
      { file: "lib/buyer-actions.ts", names: ["takeBuyerAction", "restingAway"] },
      { file: "app/api/store/community/route.ts", names: ["takeBuyerAction(store, owner ? \"owner\" : \"buyer\")", "UNCOUNTED"] },
      { file: "app/api/store/community/rsvp/route.ts", names: ["takeBuyerAction(store)"] },
      { file: "app/api/store/community/chat/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/community/messages/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/community/push/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/community/upload/route.ts", names: ["takeBuyerAction", "takePicturePlace"] },
      { file: "app/api/store/course/comment/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/course/task/route.ts", names: ["takeBuyerAction(store)"] },
      { file: "app/api/store/course/task/upload/route.ts", names: ["takeBuyerAction(on.store)"] },
      { file: "app/api/store/course/progress/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/course/certificate/route.ts", names: ["takeBuyerAction(store)"] },
      { file: "lib/lesson-comments-rules.ts", names: ["COMMENTS_PER_DAY", "COMMENTS_PER_MINUTE"] },
      { file: "lib/community-text.ts", names: ["RATE_LIMITS", "EVENT_WRITES_PER_HOUR"] },
    ],
    basis: "Every action of the window at the heaviest one's cost; the creator's own acts there are studio requests (line studio), a deletion follows an action already counted, and the per-person limits only spread them. The reads beside them (pictures, calendar files, lesson downloads, sign-in links, podcast episodes) are public requests on the buyers' side (line public-requests), a picture as PICTURE_REQUEST_UNITS of them.",
  },
  {
    id: "webhooks",
    feature: "Webhook deliveries: each try to one of the creator's endpoints, the first one, every retry and every test (18 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "webhook"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "webhook"] },
      { file: "lib/webhooks.ts", names: ["takeAllowance(store, \"webhook\", 1, now)", "ATTEMPT_TIMEOUT_MS", "RETRY_MINUTES"] },
    ],
    basis: "Every try of the window, each held at 2 GB while the endpoint answers; past the figure a delivery is not tried and is marked failed with the reason.",
  },
  {
    id: "task-files",
    feature: "Files students hand in (18 October 2026: room by plan)",
    monthlyUsd: (tier) => (TASK_ROOM_BYTES[tier] / GB) * STORAGE_PER_GB,
    sources: [
      { file: "lib/assignment-rules.ts", names: ["TASK_ROOM_BYTES", "taskRoomFor", "TRIAL_TASK_ROOM_BYTES"] },
      { file: "app/api/store/course/task/route.ts", names: ["taskRoomFor(store)"] },
      { file: "app/api/store/course/task/upload/route.ts", names: ["taskRoomFor(on.store)"] },
    ],
    basis: "The plan's room for students' work, all of it kept, at the dearest store a file may be in; it sits beside the plan's own storage, which does not hold students back.",
  },
  {
    id: "database-storage",
    feature: "What a store keeps in the database: its data room, and every record kept outside it (18 October 2026: a room by plan)",
    monthlyUsd: (tier) => (DATA_ROOM_BYTES[tier] + reserveBytes(tier)) * DB_BYTE_MONTH,
    sources: [
      { file: "lib/store-data-rules.ts", names: ["DATA_ROOM_BYTES", "NON_PAYING_DATA_ROOM_BYTES", "ORDER_DATA_BYTES", "ITEM_DATA_BYTES", "orderReserveFor", "contentRoomFor"] },
      { file: "lib/store-data.ts", names: ["TAKE_DATA", "needData", "keepFor"] },
      { file: "lib/order-data.ts", names: ["ORDER_WRITE", "orderWrite", "ORDER_KEY_BYTES", "ORDER_ENTRY_BYTES"] },
      { file: "lib/order-admission.ts", names: ["used + holding + bytes > room", "orderDataBytes(items)"] },
      { file: "tests/store-data-registry.ts", names: ["FAMILIES", "reserveBytes", "partAverage"] },
      { file: "lib/spend-cost-table.ts", names: ["UPSTASH_MICRO_USD_PER_GB_MONTH", "daily average"] },
    ],
    basis: "The plan's data room full every day of the month, at Upstash's storage rate: everything a store keeps and what its orders leave is taken from it before it is written (orders' room held at the checkout at the most an order can take, and charged what each of its writes really adds, lib/order-data.ts), and past it a write is refused, never an order. Every record kept outside it (tests/store-data-registry.ts, which fails for a key family that does not say how it is bounded) at what it keeps on average over a month, which is what Upstash bills: each part at every unit of every window its expiry touches.",
  },
  {
    id: "community-pictures",
    feature: "Pictures in community posts (18 October 2026: a number by plan)",
    monthlyUsd: (tier) => ((COMMUNITY_PICTURES[tier] * PICTURE_BYTES) / GB) * STORAGE_PER_GB,
    sources: [
      { file: "lib/community-picture-rules.ts", names: ["COMMUNITY_PICTURES", "TRIAL_COMMUNITY_PICTURES", "picturesLimitFor"] },
      { file: "lib/community-files.ts", names: ["takePicturePlace", "givePicturePlace", "sweepCommunityUploads"] },
      { file: "app/api/cron/courses/route.ts", names: ["sweepCommunityUploads"] },
    ],
    basis: "Every picture the plan lets a community keep, each at the most one may weigh, at the dearest store a file may be in. A door takes a place before it is given; a picture deleted, or a door never used (swept a day on), gives it back.",
  },
];

/**
 * What one payment can leave behind once its plan ends (18 October 2026):
 * everything the store may keep, its plan's storage, its students' room and
 * its community's pictures, kept until its closing day, CLOSING_DAYS after
 * the end and never sooner than a week after the last notice
 * (lib/plan-closing.ts). Since that day a plan that ends keeps nothing past
 * it (lib/plan-closing-rules.ts, keptRoomFor), so this happens once a
 * payment at most, and is added once to each payment's worst case.
 */
export const PER_PAYMENT_LINES: CostLine[] = [
  {
    id: "retained-files",
    feature: "Files a store keeps after its plan ends, until its closing day (18 October 2026: nothing past it)",
    monthlyUsd: (tier) => ((paidStorageBytes(tier) + TASK_ROOM_BYTES[tier] + COMMUNITY_PICTURES[tier] * PICTURE_BYTES) / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30),
    sources: [
      { file: "lib/plan-closing-rules.ts", names: ["CLOSING_DAYS", "KEEP_NOTHING_FROM", "keptRoomFor"] },
      { file: "lib/plan-closing.ts", names: ["if (!closes && held <= keptRoomFor(endedAt))", "communityFolder(store.community.id)", "removeStored"] },
    ],
    basis: "All a plan may keep, kept for its closing days and the week a late last notice adds, once after the payment that was the last. A plan that ended before 18 October 2026 keeps the old rule (a store with no plan's room, with no date): a legacy exposure of docs/funded-exposure-review.md, when no plan could yet be bought.",
  },
  {
    id: "retained-data",
    feature: "What a store keeps in the database after its plan ends, until its closing day (18 October 2026)",
    monthlyUsd: (tier) => (DATA_ROOM_BYTES[tier] * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30) + cappedByteMonths(tier, CLOSING_DAYS + WARN_WEEK_DAYS)) * DB_BYTE_MONTH,
    sources: [
      { file: "lib/store-data-rules.ts", names: ["DATA_ROOM_BYTES", "NON_PAYING_DATA_ROOM_BYTES"] },
      { file: "lib/plan-closing-rules.ts", names: ["CLOSING_DAYS"] },
      { file: "tests/store-data-registry.ts", names: ["cappedByteMonths", "lifetimeByteMonths", "partAverage"] },
      { file: "docs/funded-exposure-review.md", names: ["What a store keeps in the database after its closing day"] },
      { file: "lib/closed-store-data.ts", names: ["eraseClosed", "WALK_GAP_MS"] },
    ],
    basis: "The room full, and every record outside it with no expiry of its own (capped), for the closing days and the week a late last notice adds. A record a unit writes, which goes by itself, is not counted here a second time: each window's share of the database line is at least the whole life of what that window writes (tests/closing-cost.test.ts, lifetimeByteMonths), so it is paid for to its end, past the plan's end and the store's closing. Until 18 October 2026 this line counted those records again, at the most they hold at once.",
  },
  {
    id: "closure",
    feature: "Closing the store (18 October 2026): its records deleted, its followers read, its whole exports after its plan ended, its last steps",
    monthlyUsd: (tier) => closureCost(tier).total,
    sources: [
      { file: "lib/closed-store-data.ts", names: ["walkPage", "FOLLOWERS", "prepareStore", "stopRenewals", "DEL_BATCH", "FOLLOW_BATCH", "RENEWALS_AT_ONCE"] },
      { file: "lib/plan-closing-rules.ts", names: ["ENDED_STORE_EXPORTS"] },
      { file: "app/api/store/export/route.ts", names: ["ENDED_STORE_EXPORTS", "storeExport(store)"] },
      { file: "lib/store-export.ts", names: ["EXPORT_STRIPE_PAGES", "EXPORT_PAGE_SECONDS", "EXPORT_COMMANDS"] },
      { file: "lib/joined-stores.ts", names: ["QUARTERS_KEPT", "PERSON_RECORD_MONTHS"] },
      { file: "lib/plan-closing-rules.ts", names: ["DEL_BATCH", "FOLLOW_BATCH", "RENEWALS_AT_ONCE"] },
      { file: "tests/store-data-registry.ts", names: ["closingBytes", "followedBytes", "TRIAL_UNITS"] },
      { file: "lib/data-families.ts", names: ["FOLLOWED_FAMILIES", "CLOSING"] },
      { file: "lib/order-data.ts", names: ["ORDER_KEY_BYTES"] },
    ],
    basis: "Once for each store, so against each of its payments: a store that paid one month and closed carries all of it in that month's margin. Its keys deleted, the room's at the fewest bytes a key it counts can weigh and the rest at a mark's, DEL_BATCH at a command, each name sent back once: no longer than KEY_NAME_BYTES, and never more than that share of a key beside the ORDER_KEY_BYTES the room charges it, which the registry counts beside every key too (what Redis keeps beside it); its ENDED_STORE_EXPORTS whole exports once its plan has ended, its own and never refused, each at the largest store there can be: its room and its record, every product, course, lesson, post and form there can be, read together, and every page of its sales at Stripe; what its followers read, the room and what they read outside it, FOLLOW_BATCH entries at a command; and its last steps' commands, for its owner and every one of its team as a host. The walk's own time is its schedule's. Its id left in a person's records across stores that are the company's (the lists they joined, an affiliate's hub: tests/store-data-registry.ts) is the company's as those records are, and runs out with the quarter it was written in (lib/joined-stores.ts).  Reading the whole database to find its keys is the company's, a scheduled job bounded by its schedule (docs/funded-exposure-review.md). What an order leaves for it, a buyer's library entry and a renewal to stop, is in the order's cost (ORDER_COST); what it writes once its plan has ended is a store that pays nothing's, in the share of those (nonPayingWorst).",
  },
];

/** The longest name of a closing store's key, sent back to be deleted: a review ceiling, held to every key a closing store makes (tests/closed-store.test.ts). */
export const KEY_NAME_BYTES = 128;
/**
 * Commands a closing store's last steps take at the most
 * (lib/closed-store-data.ts, prepareStore): for its owner and each of its
 * team as a host, fifty pages of their claims and their deletes, and the
 * stores they serve; and a hundred for its ids, team, keys for the API,
 * webhooks, email platform, phones, address, record and line in the walk.
 */
export const PREPARE_COMMANDS = (1 + MAX_TEAM) * (2 * 50 + 5) + 100;

/** What the whole export reads at the most, for a store of `bytes`: every product, course, lesson, post and form there can be, each read together, and its contacts a thousand at a command (lib/store-export.ts). */
export function exportCommands(bytes: number): number {
  // Every lesson there can be: one with no text takes next to nothing of the room, and is read all the same.
  const lessons = MAX_PRODUCTS * MAX_LESSONS;
  // The contacts' pages: a thousand at a command, as many as the room can hold and never more than lib/free.ts, listAsCsv, reads (MAX_LEADS).
  const contacts = Math.min(Math.ceil(bytes / 100 / 1000), MAX_LEADS / 500 + 10);
  return Math.ceil(EXPORT_COMMANDS.fixed + 3 * Math.ceil(MAX_PRODUCTS / 100) + Math.ceil(MAX_PRODUCTS / 100) + Math.ceil(lessons / BODIES_PER_READ) + Math.ceil(MAX_POSTS / 100) + EXPORT_COMMANDS.form * MAX_FORMS + contacts);
}

/** What one whole export of a store of `bytes` costs at the most: its reads, its time at 2 GB (a step's ten seconds for every 20 MB), and one list of its sales at Stripe waited on page by page, the other read beside it. */
export function exportCost(bytes: number, commands = exportCommands(bytes)): number {
  return request("heavy", commands, bytes) + Math.ceil(bytes / 20_000_000) * request("step", 0) + (EXPORT_STRIPE_PAGES / 2) * EXPORT_PAGE_SECONDS * MEMORY_SECOND;
}

/**
 * What closing one store costs at the most, once nobody pays for it: a store
 * of this plan, or a free trial's (`trial`, its room and its units). The
 * parts are said in the basis of the line closure.
 */
export function closureCost(tier: Tier, trial = false): { deletes: number; follows: number; exports: number; prepare: number; total: number } {
  const room = trial ? NON_PAYING_DATA_ROOM_BYTES.trial : DATA_ROOM_BYTES[tier];
  const roomKeys = room / ORDER_KEY_BYTES;
  const keys = roomKeys + closingBytes(tier, trial) / MARK;
  const outside = followedBytes(tier, trial);
  const names = ((room + closingBytes(tier, trial)) * KEY_NAME_BYTES) / (ORDER_KEY_BYTES + KEY_NAME_BYTES);
  const out = {
    deletes: names * DB_BYTE + Math.ceil(keys / DEL_BATCH) * COMMAND,
    follows: (room + outside) * DB_BYTE + (Math.ceil((roomKeys + outside / MARK) / FOLLOW_BATCH) + FOLLOWED_FAMILIES.length * 4) * COMMAND,
    exports: ENDED_STORE_EXPORTS * exportCost(room + MAX_STORE_BYTES),
    prepare: PREPARE_COMMANDS * COMMAND,
    total: 0,
  };
  out.total = out.deletes + out.follows + out.exports + out.prepare;
  return out;
}

/** What one payment of this plan can leave behind after it, in dollars. */
export function perPaymentCost(tier: Tier): number {
  return PER_PAYMENT_LINES.reduce((sum, line) => sum + line.monthlyUsd(tier), 0);
}

/**
 * The worst window a store that pays nothing can cost (17 October 2026): a
 * free trial, the largest of the three. Its visits, pages and orders at the
 * trial's figures, its emails if it is a trial of a plan with monthly emails,
 * an hour of video, its workflows over the fifteen UTC days a trial touches,
 * every store figure at the trial's, and Store's own imports, moves, shared
 * funnels, team calls and quizzes, which a trial has as Store has them. No AI
 * and no uploads: a trial has none (lib/ai-spend-policy.ts,
 * lib/upload-budget-policy.ts). A store with no plan or an ended one has
 * smaller figures in every one of these (held below).
 */
export function nonPayingWorst(): number {
  const creator = (id: string) => COST_LINES.find((line) => line.id === id)!.monthlyUsd("creator");
  const allowances = NON_PAYING_ALLOWANCES.trial;
  const requests = (REQUESTS_PER_VISIT * TRIAL_VISITS + TRIAL_EXTRA_REQUESTS) * (REQUEST_COMMANDS + 1) * COMMAND + TRIAL_EXTRA_REQUESTS * laterPageCost();
  return TRIAL_VISITS * visitCost()
    + requests
    + TRIAL_ORDERS * ORDER_COST
    + TRIAL_MONTHLY_EMAILS * PER_EMAIL
    + TRIAL_VIDEO_HOURS * hourCost()
    + TRIAL_DAILY_RUNS * 15 * WORST_COMMANDS_PER_RUN * COMMAND
    + (Object.keys(allowances) as AllowanceKind[]).reduce((sum, kind) => sum + figureCost(allowances, kind), 0)
    + ["imports", "clickfunnels", "funnel-share", "team-scheduling", "quizzes"].reduce((sum, id) => sum + creator(id), 0)
    // Its students' work and its community's pictures, kept for the trial and then to its closing day (lib/plan-closing.ts).
    + ((TRIAL_TASK_ROOM_BYTES + TRIAL_COMMUNITY_PICTURES * PICTURE_BYTES) / GB) * STORAGE_PER_GB * (1 + (CLOSING_DAYS + WARN_WEEK_DAYS) / 30)
    // Its data room, and what it keeps outside it at Store's figures, which are more than a trial's, for the trial and to its closing day
    // (what a unit writes is paid for to its end by the window that wrote it, tests/closing-cost.test.ts).
    + (NON_PAYING_DATA_ROOM_BYTES.trial * (1 + (CLOSING_DAYS + WARN_WEEK_DAYS) / 30) + reserveBytes("creator") + cappedByteMonths("creator", CLOSING_DAYS + WARN_WEEK_DAYS)) * DB_BYTE_MONTH
    // And its closing, at its room and its units (closure).
    + closureCost("creator", true).total;
}

/**
 * Add-ons (since 17 October 2026): things a store pays for on its own
 * subscription, beside its plan, priced against what they collect, never
 * against the plan's price. Each is held to the owner's 60% after the 27.5%
 * stress tax by itself (tests/plan-cost-registry.test.ts, and the add-on's
 * own test), with every fee and reserve of its own payment: a plan's worst
 * month does not change when an add-on is bought, because nothing an add-on
 * does is taken from the plan's figures but what those figures already
 * price and refuse past (an inbox message, a store email, a public request).
 */
export type AddOnLine = {
  id: string;
  feature: string;
  /** What one payment of it collects, in dollars. */
  revenueUsd: number;
  /** Everything one payment of it can cost at full use, in dollars: its use, its payment's fees and its reserves. */
  monthlyUsd: () => number;
  /** Maximum total cost after reviewed TX taxes and a positive net cent; null without evidence. */
  allowedUsd: number | null;
  /** Whether it can be bought today: one that costs past its allowance may not be. */
  onSale: boolean;
  sources: Source[];
  basis: string;
};

const assistant = assistantMonthWorst();
export const ADD_ON_LINES: AddOnLine[] = [
  {
    id: "store-assistant",
    feature: "The Store assistant add-on, $49 a month per store: the AI chat on a store's pages, its pool of replies, its conversations and its list of unanswered questions (17 October 2026); the next product after a purchase, from the same pool (function 2); one checkout reminder asked for at checkout, its AI line from the same pool (function 3)",
    revenueUsd: assistant.revenueCents / 100,
    monthlyUsd: () => assistant.totalCents / 100,
    allowedUsd: assistant.allowedCents === null ? null : assistant.allowedCents / 100,
    onSale: ASSISTANT_ON_SALE,
    sources: [
      { file: "lib/store-assistant-rules.ts", names: ["ASSISTANT_PRICE_CENTS", "ASSISTANT_MESSAGES_MONTHLY", "ASSISTANT_INPUT_BYTES", "ASSISTANT_OUTPUT_TOKENS", "ASSISTANT_MESSAGE_COMMANDS", "ASSISTANT_MESSAGE_DB_BYTES", "ASSISTANT_PER_TEN_MINUTES", "ASSISTANT_PER_DAY", "ASSISTANT_STORE_PER_MINUTE", "ADD_ON_FEES", "DISPUTE_RESERVE_BPS", "REFUND_RESERVE_BPS", "REMITTANCE_BPS", "assistantMonthWorst"] },
      { file: "lib/store-assistant.ts", names: ["ASSISTANT_POOL", "pool(\"reserve\"", "pool(\"settle\"", "pool(\"release\"", "ASSISTANT_KEEP_SECONDS", "ASSISTANT_MISSED_KEPT"] },
      { file: "app/api/store/assistant/route.ts", names: ["\"assist\"", "\"assist-day\"", "\"assist-store\"", "withinStore(\"assist-read\"", "withinStore(\"assist-handoff\""] },
      { file: "lib/opening.ts", names: ["ASSISTANT_ON_SALE"] },
      { file: "lib/next-offer.ts", names: ["pool(\"reserve\"", "pool(\"settle\"", "pool(\"release\"", "assistantMessageWorstMicroUsd()", "takeBuyerRead(store, NEXT_OFFER_REQUEST_UNITS)", "NEXT_OFFER_KEEP_SECONDS"] },
      { file: "lib/next-offer-rules.ts", names: ["NEXT_OFFER_PRODUCTS", "NEXT_OFFER_CHOICES", "NEXT_OFFER_OUTPUT_TOKENS", "NEXT_OFFER_COMMANDS", "NEXT_OFFER_REQUEST_UNITS", "withinAssistantReply"] },
      { file: "app/api/store/assistant-next/route.ts", names: ["withinStore(\"assist-next-dismiss\""] },
      { file: "lib/assistant-reminder.ts", names: ["pool(\"reserve\"", "pool(\"settle\"", "pool(\"release\"", "assistantMessageWorstMicroUsd()", "takeBuyerRead(store, ASSIST_REMIND_REQUEST_UNITS)", "emailRoom(store, now)", "ASSIST_REMIND_KEEP_SECONDS"] },
      { file: "lib/assistant-reminder-rules.ts", names: ["ASSIST_REMIND_OUTPUT_TOKENS", "ASSIST_REMIND_PRODUCTS", "ASSIST_REMIND_COMMANDS", "ASSIST_REMIND_REQUEST_UNITS", "withinReminderReply"] },
      { file: "lib/checkout-recovery.ts", names: ["remindAssisted", "meter: { by: \"store\""] },
    ],
    basis: "One payment: every reply of the month's pool at its worst (Haiku 5.5 at 24 KiB in and 320 tokens out, the 10% provider allowance, the 45-second wait at 2 GB, and the message's own commands, bytes and day of keeping), the dearer provider's fee on the whole amount charged, the price and the buyer's tax on top at 27% (6.6% + 30 cents, lib/receiving-costs.ts, the one model every plan and add-on is held to since 18 October 2026), a 1.5% remittance allowance, and reserves of one payment in a hundred refunded and one disputed with both $15 fees. The pool is reserved before each model call and settled at what was billed, so no month can spend past it; handed-over questions are inbox messages and store emails of the plan's own figures (lines inbox, store-email), refused past them. The next product after a purchase (lib/next-offer.ts) asks the model at most once an order, reserved from the same pool at the same worst cost (its request is inside a chat message's caps: withinAssistantReply), so the pool's month is unchanged; when the pool is spent it chooses by the creator's rules with no model. Its reads and Stripe calls are NEXT_OFFER_REQUEST_UNITS public requests of the plan's window, each priced as a later page (public-requests; NEXT_OFFER_READ in tests/plan-cost-registry.test.ts); its line in the confirmation email is two reads inside the order's ORDER_COMPUTE, and no email of its own. The checkout reminder (lib/assistant-reminder.ts) asks the model at most once a checkout, only for a buyer who checked its box, reserved from the same pool at the same worst cost (its request is inside a chat message's caps: withinReminderReply), settled at what was billed, so the pool's month is unchanged; a spent pool or a failed call sends the fixed reminder with no AI line. Its email is one of the store's own emails (line store-email), checked for room before the model is asked and taken before it is sent, refused past the figure; its reads and two Stripe calls are ASSIST_REMIND_REQUEST_UNITS public requests (ASSIST_REMIND_READ in tests/plan-cost-registry.test.ts); the yes it keeps is under a kilobyte for three days, at most ASSIST_REMINDERS_PER_STORE_DAY a store a day (tests/store-data-registry.ts).",
  },
];

/** Per-use costs that no monthly figure bounds yet: not in worstCost, so nothing here is certified. */
export type OpenItem = { id: string; what: string; names?: string[] };
export const OPEN: OpenItem[] = [];

/** Exported limit or cost constants that are not a per-store monthly cost, and why. */
export const NOT_A_COST: Record<string, string> = {
  FREE_CALL_HOLDS_PER_DAY: "A pace on how often one email address may hold a free intro call's time in one store in a day (lib/free-call-rules.ts, 551 [FB1]): every hold is first taken from the plan's own monthly orders as FREE_CALL_ORDER_UNITS, before any email, so it adds no cost and only refuses.",
  BUYER_CAP_MONTHS: "Queue item 307 EC1: the cap on one closing's buyers (lib/closing-buyers-rules.ts, buyerNoticeCap), a post-cancellation funded exposure of docs/funded-exposure-review.md (closingBuyersCost above), the company's, not a plan's line.",
  BUYER_PAGES_PER_RUN: "Pages of a closing store's checkouts read in one run of the daily closing job (lib/closing-buyers.ts): inside the same exposure, bounded by its cap.",
  HOLD_PAGES_PER_RUN: "Pages of a closing store's memberships held, released or ended in one run (lib/closing-holds.ts): inside the same exposure.",
  REFUNDS_PER_REQUEST: "Refunds of members' unused time in one request (lib/closing-refunds.ts): the creator's money on the creator's account; its calls inside the same exposure.",
  EMAILS_PER_BUYER_PER_ENDING: "Emails one closing takes for a buyer (lib/closing-buyers-rules.ts), inside the same exposure's cap.",
  STRIPE_CALLS_PER_MEMBER: "Calls to the creator's Stripe account one member's closing takes at the most, the closing's call budget per buyer its cap allows (lib/closing-holds.ts, takeCalls): inside the same exposure (CLOSING_BUYER_COST).",
  MEMBERS_AT_ONCE: "How many members one closing works on at once: a pace inside the daily job's minute, not a figure of its own.",
  REFUND_CALLS_PER_MEMBER: "The part of STRIPE_CALLS_PER_MEMBER set aside for a member's refund (lib/closing-holds.ts): inside the same budget, not added to it.",
  PICTURES_PER_MINUTE: "A pace on the pictures a function answers (lib/picture-pace.ts, MM-SA-04), held in memory with no store command: it only refuses, and what it lets through is the CDN's picture of line visits.",
  PICTURE_READS_PER_MINUTE: "A pace on how often one picture is read by a function (lib/picture-pace.ts, MM-SA-04), held in memory with no store command: it only refuses.",
  CENTS_PER_MINUTE: "AI captions are bought at their own price, charged before the work (lib/auto-captions-rules.ts).",
  MAX_PAGES_PER_STORE: "Pages of Stripe sessions the five-minute job reads per store per run: a scheduled job, bounded by its schedule (a company fixed cost).",
  TAX_OBSERVATION_LIMITS: "Inactive diagnostic processing bounds: CURRENT_TAX_OBSERVATION_POLICY is null, so no production journal IO is enabled. Activation requires explicit scope, absolute retention, atomic data-room reservation and full-lifetime paid storage/work cost evidence; these limits are not a zero cost or a funded allowance.",
  QUIET_PER_HOUR: "Sale notifications to the creator's phone: one per counted order at most, inside the order's compute.",
  VERCEL_CPU_MICRO_USD_PER_HOUR: "A rate, not a cap.",
  ASKS_PER_TEN_MINUTES: "A burst limit under ANSWERS_MONTHLY (line ai).",
  STORE_ASKS_PER_MINUTE: "A burst limit under ANSWERS_MONTHLY (line ai).",
  TRIAL_MONTHLY_EMAILS: "The free trial's emails: in nonPayingWorst (line free-share).",
  DAILY_CAPS: "The choices of a host's own daily booking cap: how many calls a host takes, not a cost.",
  KIT_PER_DAY: "A daily burst limit under the writing jobs an affiliate kit takes (line ai).",
  PITCHES_PER_DAY: "Outreach pitches are drafts the creator sends from their own mailbox: nothing is sent from here, and reading a business's site is a call out (line integrations).",
  OPENS_PER_DAY: "A daily burst limit on one numbers link: each opening is one of the store's public requests (line public-requests).",
  MAX_RANGES_PER_DAY: "How many time ranges a host may set on one day of the week: a setting, not a use.",
  REQUEST_LIMITS: "How many payment requests a store keeps open and in all: each costs only the store emails it sends (line store-email), the order its payment becomes (line orders) and its record in the data room (line database-storage).",
  NON_PAYING_REQUEST_LIMITS: "The same for a store that pays nothing: its emails and orders are in its own figures (nonPayingWorst), its records in its data room.",
  NON_PAYING_ALLOWANCES: "The figures of a store that pays nothing: in nonPayingWorst (line free-share).",
  PIPELINES_BY_TIER: "How many deal pipelines a store keeps: a setting in one record counted in the store's data room (tests/store-data-registry.ts, nl:crm:pipes:); changing or moving deals are studio requests (line studio), and a deal entering a stage takes one more before its workflow is checked (lib/deal-stage-trigger.ts, STAGE_TRIGGER_UNITS).",
};

/** What a scope of a counter in the code is: counted in a line, an abuse guard, or open. */
export type ScopeClass = { line: string } | { open: string } | { guard: string };
const guard = (why: string): ScopeClass => ({ guard: why });
const line = (id: string): ScopeClass => ({ line: id });
const ACCOUNT = guard("Sign-in and account security, per address or connection: a company cost per creator account, not per store use.");
const PUBLIC = line("public-requests");
const SERVICE = line("integrations");
const BURST = (under: string): ScopeClass => guard(`A burst limit per connection, person or day, under the store's figure (line ${under}).`);
const METERED_EMAIL = guard("Per connection or person; the email it sends is taken from the store's figure before it goes (lib/email.ts, EmailMeter).");

export const SCOPES: Record<string, ScopeClass> = {
  // Counted in a line.
  "import-preview": line("clickfunnels"), "import-preview-month": line("clickfunnels"), "import-preview-buyers-month": line("clickfunnels"),
  "import-cf-page": line("clickfunnels"), "import-cf-page-month": line("clickfunnels"), "import-cf-plan": line("clickfunnels"),
  "import-cf-plan-month": line("clickfunnels"), "import-cf-save": line("clickfunnels"), "import-cf-save-month": line("clickfunnels"),
  "import-start": line("imports"), "import-start-month": line("imports"), "import-step": line("imports"), "import-step-month": line("imports"),
  "import-rows": line("imports"), "import-report": line("imports"), "import-report-month": line("imports"),
  "countUse:shareMonthKey(opened.id": line("funnel-share"), "countUse:storeMonthKey(statsId": line("funnel-share"),
  "countUse:storeMonthKey(store.statsId": line("funnel-share"), "countUse:storeUseKey(statsId": line("funnel-share"), "countUse:key: string": line("funnel-share"),
  // A copy into another store of the same account (18 October 2026): the destination's own previews and imports, the same line.
  "countUse:storeMonthKey(to.statsId": line("funnel-share"), "countUse:storeUseKey(to.statsId": line("funnel-share"),
  ai: line("ai"), ask: line("ai"), "ask-day": line("ai"), "ask-store": line("ai"), "chat-summary": line("ai"),
  "embed-open": line("embed"), checkout: line("orders"), upsell: line("orders"), "group-place": line("orders"),
  book: line("orders"), "paypal-return": line("orders"),
  "podcast-feed": line("visits"), "<dynamic:allowance[0]>": line("visits"),
  "<dynamic:scope>": guard("withinStore and withinService pass their scope on to withinLimit (lib/metered-limits.ts)."),
  "<dynamic:scope: string>": guard("The definitions of withinLimit, withinMonth, withinStore and withinService themselves (lib/request-guard.ts, lib/metered-limits.ts)."),
  api: line("rest-api"), "studio-essential": line("studio"), "studio-paused": line("studio"), "bundle-picker": line("studio"),
  // Sign-in and account security.
  join: ACCOUNT, passkey: ACCOUNT, "google-signin": ACCOUNT, "google-signin-back": ACCOUNT, "passkey-change": ACCOUNT, "two-step": ACCOUNT, "two-step-backup": ACCOUNT, "two-step-change": ACCOUNT,
  "two-step-rescue": ACCOUNT, "recovery-address": ACCOUNT, "recovery-address-change": ACCOUNT, "lost-email": ACCOUNT, "lost-email-ip": ACCOUNT,
  "discord-return": ACCOUNT, "metaads-return": ACCOUNT, "meet-return": ACCOUNT, report: guard("Takedown reports, per connection: a company cost."),
  "mail-ses": guard("The email provider's own notices: a company cost."), "mail-inbound": guard("The email provider's inbound notices, per connection: a company cost; what is sent on to a creator is one of their store's emails (lib/inbound-mail.ts)."),
  "mail-clicked": guard("A click beacon from a store page opened from an email link, which the page itself counts: a few commands and no work, per connection."),
  "stream-hook": guard("The video service's own notices: a company cost."), "zoom-notice": guard("Zoom's own notices: a company cost."),
  "plan-refund": guard("The plan refund route (app/api/billing/refund, 305 [SY1]): at most PER_DAY (10) a store a day, each a bounded Stripe reading (MAX_CALLS) and one write; the money is the reviewed refund exposure (docs/funded-exposure-review.md), a company cost."),
  "plan-refund-review": guard("The plan refund's review page (app/studio/refund, 305 [SY1]): drawn at most SHOWN_PER_DAY (20) a store a day, each a bounded Stripe reading (MAX_CALLS) and one short key: a company cost."),
  "metaads-deauth": guard("Meta's own notices: a company cost."), "outreach-stop": guard("A recipient's stop link: a company cost."),
  // Public requests: counted in the store's window as well (lib/metered-limits.ts, withinStore).
  "ads-event": PUBLIC, "aff-join": PUBLIC, "aff-open": PUBLIC, "book-move": PUBLIC, "cart-read": PUBLIC, "come-back": PUBLIC, "course-start": PUBLIC,
  "discord-join": PUBLIC, download: PUBLIC, "form-ip": PUBLIC, heard: PUBLIC, "join-ip": PUBLIC, "manage-card": PUBLIC, "manage-card-back": PUBLIC,
  "manage-leave": PUBLIC, "manage-open": PUBLIC, "move-open": PUBLIC, "podcast-link-ip": PUBLIC, review: PUBLIC, "review-view": PUBLIC,
  "store-search": PUBLIC, "thanks-view": PUBLIC, "tier-switch": PUBLIC, tip: PUBLIC, "pay-request": PUBLIC, "pay-request-view": PUBLIC, "agreement-sign": PUBLIC, "agreement-view": PUBLIC, "waitlist-ip": PUBLIC, "welcome-open": PUBLIC,
  "course-start-order": BURST("public-requests"), "review-order": BURST("public-requests"), "join-address": BURST("public-requests"),
  "waitlist-address": BURST("public-requests"), "numbers-link": BURST("public-requests"), preview: BURST("public-requests"),
  "affhub-address": METERED_EMAIL, "affhub-ip": METERED_EMAIL, "library-address": METERED_EMAIL, "library-ip": METERED_EMAIL,
  "erase-address": METERED_EMAIL, "erase-ip": METERED_EMAIL,
  "podcast-link-address": METERED_EMAIL, "contact-ip": METERED_EMAIL, "contact-store": METERED_EMAIL, "remind-ask": METERED_EMAIL,
  "remind-store": METERED_EMAIL, "assist-remind-store": METERED_EMAIL, "resend-sale": METERED_EMAIL, "resend-store": METERED_EMAIL, "creator-inbound": METERED_EMAIL,
  "inbox-reply": METERED_EMAIL, "inbox-tell": METERED_EMAIL,
  // The Store assistant (an add-on, ADD_ON_LINES): its asks are burst limits under its month's pool, the rest public requests.
  assist: guard("A burst limit per connection under the Store assistant's monthly pool (add-on line store-assistant)."),
  "assist-day": guard("A daily limit per connection under the Store assistant's monthly pool (add-on line store-assistant)."),
  "assist-store": guard("A per-minute limit per store under the Store assistant's monthly pool (add-on line store-assistant)."),
  "assist-read": PUBLIC, "assist-handoff": PUBLIC, "assist-next-dismiss": PUBLIC,
  "lesson-comment": BURST("buyer-actions"), "lesson-comment-day": BURST("buyer-actions"), "task-hand-in": BURST("buyer-actions"), "task-upload": BURST("buyer-actions"),
  // Per store, under a figure of the window.
  "api-add": BURST("rest-api"), "api-give": BURST("rest-api"),
  "inbox-new": BURST("inbox"), "chat-send": BURST("inbox"), "chat-start": BURST("inbox"),
  // Calls to other services: counted in the store's window as well (lib/metered-limits.ts, withinService).
  "meet-host": SERVICE, "meet-manage": SERVICE, "meet-start": SERVICE, "metaads-start": SERVICE, "discord-connect": SERVICE, esync: SERVICE,
  "paypal-connect": SERVICE, "paypal-pay": SERVICE, "paypal-sell-connect": SERVICE, "aff-kit": SERVICE, "aff-payto": SERVICE, "outreach-find": SERVICE,
  "person-find": SERVICE, "vault-open": SERVICE, "vault-sign": SERVICE, "stream-door": SERVICE, "stream-captions": SERVICE, "mail-picture": SERVICE,
  "host-calendar": SERVICE, "outreach-find-day": BURST("integrations"),
};

/** The store figures, each priced by a line (lib/store-allowance-rules.ts, takeAllowance). */
export const KIND_LINES: Record<AllowanceKind, string> = {
  studio: "studio", api: "rest-api", inbox: "inbox", email: "store-email", transactional: "transactional-email", integration: "integrations",
  buyer: "buyer-actions", webhook: "webhooks",
};

/**
 * Every file that sends email, and the meters it may count them against
 * (lib/email.ts, EmailMeter): "company" for what we send a creator about
 * their own account, "order" for an order's two emails, "monthly" for what
 * was taken from the monthly emails before, "store" for what is taken from
 * the store's own figures as it goes.
 */
const COMPANY = ["company"], ORDER = ["order"], MONTHLY = ["monthly"], STORE = ["store"];
export const EMAIL_SITES: Record<string, string[]> = {
  "lib/email.ts": ["company", "order", "monthly", "store"],
  "app/api/cron/mail-check/route.ts": COMPANY, "app/api/cron/monthly/route.ts": COMPANY, "app/api/cron/stripe-check/route.ts": COMPANY,
  "app/api/cron/usage/route.ts": COMPANY, "app/api/cron/weekly/route.ts": COMPANY, "lib/account-notice.ts": COMPANY, "lib/auth.ts": COMPANY,
  "lib/billing-reminders.ts": COMPANY, "lib/passkeys.ts": COMPANY, "lib/plan-closing.ts": COMPANY, "lib/closing-buyers.ts": COMPANY, "lib/closing-plan-guard.ts": COMPANY, "lib/plan-refund-flow.ts": COMPANY, "lib/plan-pause.ts": COMPANY,
  "lib/recovery-address.ts": COMPANY, "lib/stats-report.ts": COMPANY, "lib/store-alerts.ts": COMPANY, "lib/takedown.ts": COMPANY,
  "lib/trial-nudges.ts": COMPANY, "lib/two-step.ts": COMPANY, "lib/verify-mail.ts": COMPANY, "lib/yearly-offer.ts": COMPANY,
  "lib/inbound-mail.ts": ["store", "company"],
  "app/api/store/mail/route.ts": MONTHLY, "lib/api-write.ts": MONTHLY, "lib/community-mail.ts": MONTHLY, "lib/flows.ts": MONTHLY,
  "lib/imports.ts": MONTHLY, "lib/product-updates.ts": MONTHLY, "lib/review-requests.ts": MONTHLY,
  "lib/mail.ts": ["monthly", "company"],
  "lib/call-packages.ts": ORDER, "lib/call-reminders.ts": ORDER, "lib/free.ts": ORDER, "lib/gifts.ts": ORDER, "lib/group-buy.ts": ["order", "store"],
  "lib/paypal-sales.ts": ORDER, "lib/preorders.ts": ORDER, "lib/shipments.ts": ORDER,
  "lib/purchase-email.ts": ["order", "store"], "lib/calls.ts": ["order", "store"], "lib/licence-keys.ts": ["order", "store"],
  "lib/affiliate-hub.ts": STORE, "lib/affiliate-payday.ts": STORE, "lib/affiliates.ts": STORE, "lib/assignment-notify.ts": STORE,
  "lib/buyer-library.ts": STORE, "lib/erasure-request.ts": STORE, "lib/buyer-orders.ts": STORE, "lib/checkout-recovery.ts": STORE, "lib/checkout-trouble.ts": STORE,
  "lib/community-access.ts": STORE, "lib/community-event-mail.ts": STORE, "lib/inbox.ts": STORE, "lib/learn.ts": STORE,
  "lib/lesson-comment-notify.ts": STORE, "lib/member-nudge.ts": STORE, "lib/membership-manage.ts": STORE, "lib/membership-pause.ts": STORE,
  "lib/payment-recovery.ts": STORE, "lib/podcast-access.ts": STORE, "lib/quiet-sales.ts": STORE, "lib/store-contact.ts": STORE,
  "lib/store-join.ts": STORE, "lib/team.ts": STORE, "lib/tier-switch.ts": STORE, "lib/waitlist.ts": STORE,
  "lib/welcome-offer-send.ts": STORE, "lib/winback-send.ts": STORE, "lib/yearly-ask.ts": STORE, "lib/yearly-switch.ts": STORE,
  // A payment request and its reminders are the store's own emails; its receipt is its order's (18 October 2026).
  "lib/payment-requests.ts": STORE, "lib/payment-request-store.ts": ORDER,
  // A proposal or agreement to sign, its new versions and its signed copies are the store's own emails (18 October 2026).
  "lib/agreements.ts": STORE,
};

/** Additional Path growth reading: at most eight 256 KB products, three 80 KB campaigns, three bounded reviews and their indexes. Fifty commands and 3 MB include admission overhead; reserved separately before reading. No provider call. */
export const PATH_GROWTH_READ = request("write", 50, 3_000_000);
