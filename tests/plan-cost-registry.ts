import { HELD_RECHECKS_PER_DAY, HELD_RETRY_COUNTER_SECONDS, HELD_MONTH_COUNT_SECONDS, heldRecheckMemoryUsd } from "@/lib/held-store-rules";
import { CURRENT_MAIL_REPORT_ADMISSION } from "@/lib/mail-report";
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
import { ESSENTIAL_PER_DAY, STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { EXTRA_REQUESTS, REQUESTS_PER_VISIT, SHARE_COMMANDS_PER_REQUEST, TRIAL_EXTRA_REQUESTS, TRIAL_VISITS } from "@/lib/traffic-rules";
import { TRIAL_ORDERS } from "@/lib/order-rules";
import { TRIAL_MONTHLY_EMAILS } from "@/lib/plan";
import { TRIAL_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { TRIAL_DAILY_RUNS } from "@/lib/flow-limits";
import { PAID_STORES_PER_FREE_STORE } from "@/lib/free-pool-rules";
import { CERTIFICATE_PDF_MAX_BYTES } from "@/lib/certificate-pdf";
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
import { BATCH_BYTES, HELD_UPLOAD_SWEEP_COMMANDS, IMPORT_END_EXTRA_COMMANDS, JOB_WRITE_IF_EXTRA_COMMANDS, MAX_REPORT_ROWS } from "@/lib/imports";
import { GIVE_BACK_FLOOR_EXTRA_COMMANDS } from "@/lib/mail";
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
import { MAX_NAME_LENGTH as STORE_NAME_MOST, MAX_STORE_BYTES } from "@/lib/store";
import { BODIES_PER_READ } from "@/lib/course";
import { COURSE_BYTES } from "@/lib/api-read-rules";
import { MAX_LEADS } from "@/lib/contact-rules";
import { DATA_ROOM_BYTES, ENTRY_BYTES, NON_PAYING_DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { ORDER_KEY_BYTES } from "@/lib/order-data";
import { PERSON_RECORD_MONTHS } from "@/lib/joined-stores";
import { FOLLOWED_FAMILIES } from "@/lib/data-families";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { SALE_TEXT_LIMITS, SALES_ID_LENGTH, SALES_PAGE, SALES_SAFE_ID_LENGTH, SALES_TITLE_IDS } from "@/lib/api-sales";
import { BUMP_KEYS, MAX_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import { MAX_TITLE_LENGTH as SALES_LISTING_TITLE } from "@/lib/catalog-rules";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { MAX_LESSONS } from "@/lib/course";
import { MAX_POSTS, POSTS_PER_PAGE } from "@/lib/store-blog";
import { MAX_BUMPS } from "@/lib/product-extras";
import { AFFILIATE_ROW_CAP, type AffiliateLoadSize, type AffiliatePageSize, type SitemapSize } from "@/lib/public-read-rules";
import { BOOK_SNAPSHOT_MAX_BYTES } from "@/lib/affiliate-book-snapshot";
import { SEARCH_PAGE } from "@/lib/community-search";
import { MAX_CHAT_KEPT } from "@/lib/community-chat-rules";
import { SEARCH_MESSAGES } from "@/lib/community-dm";
import { MAX_FORMS } from "@/lib/forms";
import { EXPORT_COMMANDS, EXPORT_PAGE_SECONDS, EXPORT_STRIPE_PAGES } from "@/lib/store-export";
import { PATH_REFUND_PAGES, PATH_SALE_PAGES } from "@/lib/path-facts";
import { ALL_TIME_PAGES } from "@/lib/stats";
import { MAX_PAID_BYTES, PAYPAL_REFUNDS_READ } from "@/lib/paypal-sales";
import { AGENDA_MAX_ROWS, AGENDA_ROW_SENT_BYTES, AGENDA_TASKS_BYTES } from "@/lib/person-agenda";
import { LIFE_WRITE_MAX } from "@/lib/stats";
import { MARK, cappedByteMonths, closingBytes, followedBytes, reserveBytes, reservePeakBytes } from "./store-data-registry";
import {
  PROVIDER_CHARGES_BPS, UPSTASH_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";
import { PAGES_PER_VISIT, laterPageCost, visitCost } from "./traffic-cost";
import { ASSISTANT_IN_PROGRESS_WAIT_MS, ASSISTANT_START_CUTOFF_MS, ASSISTANT_START_LIST_PAGES, ASSISTANT_START_STRIPE_CALLS, assistantMonthWorst } from "@/lib/store-assistant-rules";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { NEXT_OFFER_CHOICES, NEXT_OFFER_COMMANDS, NEXT_OFFER_PRODUCTS } from "@/lib/next-offer-rules";
import { MAX_SHELF } from "@/lib/course-shelf-rules";
import { ASSIST_REMIND_COMMANDS, ASSIST_REMIND_PRODUCTS } from "@/lib/assistant-reminder-rules";
import type { ReadWork } from "@/lib/api-read-rules";
import { DOWNLOAD_LOOKUP_COMMANDS, DOWNLOAD_LOOKUP_MS, ORDERS_BUNDLE_BYTES, ORDERS_OLDER_BYTES, ORDERS_OLDER_COMMANDS, ORDERS_OPEN_COMMANDS, ORDERS_OPEN_SECONDS, ORDERS_PAGE_BYTES } from "@/lib/buyer-orders-rules";
import { MOVES_PER_MGET, MOVE_BYTES, MOVE_KEY_BYTES } from "@/lib/call-moves-read";
import { MAX_PER_PERSON as AGREEMENTS_PER_PERSON, MAX_BODY as AGREEMENT_BODY, MAX_LINES as AGREEMENT_LINES, MAX_LINE_TEXT as AGREEMENT_LINE_TEXT, MAX_NAME as AGREEMENT_NAME, MAX_TITLE as AGREEMENT_TITLE } from "@/lib/agreement-rules";
import { MAX_EMAIL_LENGTH } from "@/lib/auth";
import { MAX_PER_PERSON as REQUESTS_PER_PERSON } from "@/lib/payment-request-rules";
import { WAITING_SHOWN } from "@/lib/buyer-waiting";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";
import { type ReadShape, CALENDAR_BUILD_SHAPE, CALENDAR_FILE_BYTES, CALENDAR_POLL_SHAPE, CALENDAR_REFUSED_PRICED_PER_HOUR, CALENDAR_REFUSED_SHAPE, KEPT_READINGS_SHAPE, LIFE_FILL_SHAPE, LIST_MADE_SHAPE, MEMBERS_READ_SHAPE, SALES_READ_SHAPE, STATS_READ_SHAPE } from "@/lib/read-ceilings";
import { CALENDAR_BUILDS_PER_DAY, CALENDAR_COPY_SECONDS, CALENDAR_CREDITS_PER_DAY, CALENDAR_POLLS_PER_HOUR } from "@/lib/calendar-sync";
import { HEAVY_READINGS_PER_DAY, READING_COPY_MAX_BYTES, READING_KEEP_SECONDS, READING_KINDS, STORE_READINGS_PER_DAY } from "@/lib/store-readings";

export const GB = 1024 * 1024 * 1024;
/** Keeping a file, at the dearest of the three stores one may be in. */
export const STORAGE_PER_GB = 0.023;
/** Sending a file that is sold: nothing, from the store they are kept in. */
export const FILE_DELIVERY_PER_GB = 0;
export const STREAM_STORAGE_PER_GB = 0.02;
export const STREAM_DELIVERY_PER_GB = 0.005;
export const FETCHED_AHEAD = 1.25;
export const PER_EMAIL = 0.0009;
/** DR1 unit 1 components. A priced successful delivery is not evidence of
 * the live retry policy, total provider publications or admission funding.
 * Lua includes EVAL and every internal command. These are disconnected
 * sizing components, not an active plan coefficient: CX-112 keeps report
 * reads/writes without admission and without Redis IO. Future activation
 * must fund the entire callback lifecycle and add its retained bytes. */
export const MAIL_REPORT_COST_COMPONENTS = {
  firstOutcomeCommands: 8,
  duplicateOutcomeCommands: 4,
  reportReadCommands: 1,
  reportReadFields: 4,
  outcomeKindsPerSentEmail: 4,
  bytesPerSentEmail: 2048,
  retentionDays: 10,
  callbackAttemptsPerEmailCeiling: null,
  snsAndHostingMonthlyUsd: null,
  completeMonthlyUsd: null,
  reviewedAdmission: CURRENT_MAIL_REPORT_ADMISSION,
} as const;
/** One published delivery notice, without supplier free-tier credit:
 * SNS $0.50/million publishes + $0.60/million HTTPS deliveries, each 64 KiB
 * chunk charged. Read 2026-11-04: aws.amazon.com/sns/faqs/ and /sns/pricing/.
 * The caller MUST supply its regional data-out ceiling; null is unknown.
 * This is an explicit sizing calculation, never a current account review.
 * A retry is charged the full route envelope even when deduplication wins.
 * Thirty CPU seconds and 2 GB held for all 30 seconds use maxDuration, not
 * an observed fast callback. Eleven Redis commands = SET/INCR rate guard,
 * SET SNS receipt, EVAL plus its seven internal report commands. Storage
 * includes two report fields kept ten days and two 256-byte transport/guard
 * records per attempt kept a full day (above the actual minute-long guard).
 * Report fields are also in the data-family model: deliberately overlapping
 * reserves, never a discount to another feature's existing storage budget.
 */
export function mailReportCallbackCost(deliveries: number, attempts: number, snsTransferPerGb: number | null) {
  if (!Number.isSafeInteger(deliveries) || deliveries < 0 ||
      !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 101 ||
      typeof snsTransferPerGb !== "number" || !Number.isFinite(snsTransferPerGb) || snsTransferPerGb <= 0 ||
      !Number.isSafeInteger(deliveries * attempts)) return null;
  const invocations = deliveries * attempts;
  const redisCommands = invocations * 11;
  if (!Number.isSafeInteger(redisCommands)) return null;
  // Five chunks for an accepted 300,000-byte envelope, plus transport
  // headers. An oversized/rejected publication is outside this delivery
  // scenario; it does not become a free event or funded company expense.
  // Count a cold certificate fetch's 20,000 bytes on every attempt as well.
  const snsPerNotice = 5 * 0.5 / 1_000_000;
  const snsPerAttempt = 5 * 0.6 / 1_000_000 + 320_000 * snsTransferPerGb / 1e9;
  // Include CDN request and BOTH incoming and outgoing Fast Origin/Data
  // Transfer; model 32 KiB of headers plus 300,000 request/128 response bytes.
  // Regional account coverage still needs an independent review.
  const networkBytes = 300_000 + 128 + 32_768;
  const hostingPerAttempt = CALL + 30 * CPU_SECOND + 30 * MEMORY_SECOND + 2 / 1_000_000
    + networkBytes * (ORIGIN_PER_BYTE + 0.15 / 1e9);
  const redisPerAttempt = 11 * COMMAND + 4096 * DB_BYTE + 512 / 30 * DB_BYTE_MONTH;
  const retainedPerNotice = 512 * 10 / 30 * DB_BYTE_MONTH;
  const snsUsd = deliveries * (snsPerNotice + attempts * snsPerAttempt);
  const hostingUsd = invocations * hostingPerAttempt;
  const redisUsd = deliveries * (attempts * redisPerAttempt + retainedPerNotice);
  const totalUsd = deliveries * ((snsPerNotice + attempts * (snsPerAttempt + hostingPerAttempt + redisPerAttempt) + retainedPerNotice) * (1 + PROVIDER_CHARGES_BPS / 10_000));
  if (!Number.isFinite(totalUsd)) return null;
  return { notices: deliveries, invocations, redisCommands, snsUsd, hostingUsd, redisUsd, providerAllowanceUsd: totalUsd - snsUsd - hostingUsd - redisUsd, totalUsd };
}
/** An order's pages and jobs, set well over a visit's whole page (tests/traffic-cost.ts). */
export const ORDER_COMPUTE = 0.0003;
/**
 * A cart's stock work at its worst (lib/stock.ts, withCartStockHolds; 513 [PF1], the independent review of 5 November 2026):
 * every limited product of a cart of MAX_CART, its lock taken at its most tries, its count, its provisional hold, the admission
 * and the hand-over scripts with the commands they run inside, the hand-over's failure path, and the previous checkout's units
 * handed back first (releaseCartStockHolds). Measured in tests/cart-stock.test.ts and held to a declared share of ORDER_COMPUTE,
 * so the rest of it is left for the order's pages and jobs. Stripe is never asked while a lock is held; the holds that ran out
 * are asked about after the locks are let go, every product at once, at most MAX_CHECKS times each at CHECK_MS (lib/stock.ts),
 * so the waiting is at most CART_STOCK_STRIPE_WAIT_MS besides the locks' own short waits.
 */
export const CART_STOCK_COMMANDS_MOST = 70;
export const CART_STOCK_SHARE_OF_ORDER_COMPUTE = 0.5;
export const CART_STOCK_STRIPE_WAIT_MS = 5 * 2_000;
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

/** The existing two-email order envelope: confirmation, shipment email,
 * compute and its share of closure. It does NOT price the new durable
 * shipment outbox's indefinite pending/source/fence storage, copies,
 * reservation pools, provider retries or repeated reconciliation. Those
 * remain unpriced, not zero: CURRENT_SHIPMENT_MAIL_POLICY is null. The
 * CURRENT_SHIPMENT_MAIL_LIFECYCLE is never_activated: status returns
 * not_recorded and cleanup returns0 without Redis, and the UI does no GET.
 * New storage/dispatch require active AND a valid independent policy. A finite
 * active-month/closing-days room is not funding for an unknown pending tail.
 * In active/retired, status and erasure remain available even with policy
 * null; retirement permits no new enqueue or dispatch. Cleanup may write
 * fences for an empty index, with an indefinite failure tail. Funding for
 * cleanup/failures/retention must precede first activation; lifecycle is not
 * financial evidence. Never restore never_activated after any use while
 * payloads or uncertain reserves remain. Future tails are unknown/rejected.
 * The new account-wide Resend budget is also NOT funded by this order
 * coefficient or by a paid provider quota alone. Its permanent schema1
 * ledger, schema2 claims, pending/unknown holds without TTL, exact35-day
 * terminal receipts and partial-error reconciliation need their full own
 * retention/copies/command/cleanup envelope. Measured EVAL+internal paths:
 * 4 initialize,11 reserve,11 dispatch,14 accepted,10 receipt read,13 cancel.
 * These are command observations, not an invoice or financial approval;
 * CURRENT_RESEND_FALLBACK_REVIEW remains null, never an automatic bootstrap.
 * The restricted physical-item createCheckout caller now reserves a complete
 * confirmation origin BEFORE its payment POST/URL, but remains never_activated
 * with policy null. This is a constructed pre-URL slice, not completed durable
 * confirmation: no payment/accounting/email worker or origin erasure exists.
 * Its five own families and five shared pool/index/fence references are in
 * store-data-registry, not a second allocation of the shipment pool. A full
 * future row reservation is not evidence of lifetime storage/copy/cleanup
 * funding. No TTL bounds pending/unknown origins;23h limits creation replay
 * only. Original-account read-only recovery persists its pagination cursor.
 * Observed EVAL+internal commands:27 shared enqueue,17 create,18 bind,
 * 15 already-bound replay,17 cursor; TS read adds3 and reserve adds1 TIME.
 * Open/recovery repeats Redis/provider reads, so these are NOT a full call or
 * lifetime envelope. Activation remains blocked on missing lifecycle work
 * and unknown/rejected full retention/failure/cleanup costs.
 * Its accounting hooks remain unconnected to a payment worker. Their68-byte
 * OCI/OC1 receipt horizon is ORIGINAL window end+400
 * days (at most767 from capture), first apply23 commands; the200-byte MEMORY
 * fixture is not universal storage coverage. The legacy45-day '1' marker's
 * priced part excludes this new path. Other effects can lose TTL after a
 * partial Lua failure; the whole tail is unknown, not bounded by the receipt.
 * No PER_EMAIL/ORDER_COST coefficient, real review, quota protection, paid
 * financial envelope or retention approval is changed/certified here.
 */
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
 * One certificate of completion drawn as a PDF file (app/[handle]/certificate/[id]/pdf/route.ts): the store and the
 * certificate (or the sample's course and listing) read, its two counts (REQUEST_COMMANDS each), the fonts embedded and the page drawn at a
 * second of CPU (measured at 81 ms, 0.56 s cold) held four seconds at 2 GB, and the heaviest file sent
 * (CERTIFICATE_PDF_MAX_BYTES; 146 KB measured with the longest words in every look). Taken as CERTIFICATE_PDF_UNITS
 * public requests before it is drawn, held above it in tests/plan-cost-registry.test.ts.
 */
export const CERTIFICATE_PDF_READ = CALL + 1 * CPU_SECOND + 4 * MEMORY_SECOND + (16 + 2 * (1 + SHARE_COMMANDS_PER_REQUEST)) * COMMAND + 64_000 * DB_BYTE + CERTIFICATE_PDF_MAX_BYTES * ORIGIN_PER_BYTE;
/**
 * What one next product after a purchase costs besides the model (lib/next-offer.ts),
 * at the most: its commands and its counting, the listings it reads (a product's
 * heavy record among them), and up to five calls to the creator's Stripe account
 * waited on at 2 GB.
 */
export const NEXT_OFFER_READ = request("wait", NEXT_OFFER_COMMANDS + TAKE_COMMANDS, (NEXT_OFFER_PRODUCTS + NEXT_OFFER_CHOICES) * 16_384 + MAX_PRODUCT_BYTES + 4_096);
/**
 * One reading of a course's "More from" shelf for a student (lib/course-shelf.ts, 628 [HN4](b)), at the most: what the
 * buyer owns read as the next product after a purchase reads it (ownedHere: the same commands and up to five Stripe
 * calls waited on at 2 GB), at most MAX_SHELF listings (fewer than that one's NEXT_OFFER_PRODUCTS + NEXT_OFFER_CHOICES)
 * and one pipeline of MAX_SHELF PayPal counts on top. Taken as SHELF_REQUEST_UNITS public requests before it reads.
 */
export const SHELF_READ = request("wait", NEXT_OFFER_COMMANDS + TAKE_COMMANDS + MAX_SHELF, (NEXT_OFFER_PRODUCTS + NEXT_OFFER_CHOICES) * 16_384 + MAX_PRODUCT_BYTES + 4_096);
/**
 * What one Store assistant checkout reminder costs besides the model and its
 * email (lib/assistant-reminder.ts), at the most: its commands and its
 * counting, the store record read by the job (1 MB at the most), a cart's
 * listings and the consent, and two calls to the creator's Stripe account
 * waited on at 2 GB.
 */
export const ASSIST_REMIND_READ = request("wait", ASSIST_REMIND_COMMANDS + TAKE_COMMANDS, 1_000_000 + ASSIST_REMIND_PRODUCTS * 16_384 + 4_096);
/**
 * Review ceilings for the two public reads paid for since 4 November 2026
 * (lib/public-read-rules.ts): a field of an affiliate program's records (an
 * affiliate, with their note, address and shares, is the largest), a record
 * read on its own (a PayPal payment, a moved booking), a product's listing,
 * a page of the creator's Stripe account as it arrives (a hundred invoices
 * with their payments, refunds or disputes, or the codes), a post's summary,
 * and a line of the map or of an affiliate's page as it leaves.
 */
export const AFFILIATE_FIELD_BYTES = 4_096;
export const AFFILIATE_ROW_BYTES = 2_048;
export const PUBLIC_LISTING_BYTES = 16_384;
export const STRIPE_PAGE_BYTES = 1_000_000;
export const POST_META_BYTES = 2_048;
export const SITEMAP_LINE_BYTES = 300;
/**
 * Working out an affiliate program's book, besides what scales: the book
 * counted (eight), the seven hashes, the PayPal refunds' set, two reads of
 * listings, the lock taken, read and let go, the kept book's state read
 * again under it and its previous marks, and the parts written to a draft
 * that is renamed into place.
 */
export const AFFILIATE_PAGE_COMMANDS = 50;
/** And what it reads whatever the size: the store record's share. */
export const AFFILIATE_PAGE_BYTES = 64_000;
/** What one line of the kept book takes, written as it is kept (lib/affiliate-book-snapshot.ts): two per field (a sale and a second tier's line of it), one per record read and per invoice, at the most. */
export const BOOK_LINE_BYTES = 1_024;
/** And each affiliate's whole part around their lines: its row with their record (address, PayPal address and note left out) and its wrapping. */
export const BOOK_PART_BYTES = 2_048;
/** One load of an affiliate's page, besides a later page's own commands: the kept book's time and length, the codes counted, its part read. */
export const AFFILIATE_LOAD_COMMANDS = 4;
/** Working through a body past what a request's shape holds: a heavy request's CPU and wait for each megabyte. */
const perMegabyte = (bytes: number) => (bytes / 1e6) * (SHAPES.heavy.cpu * CPU_SECOND + SHAPES.heavy.seconds * MEMORY_SECOND);
/** One call to the creator's Stripe account, waited on at 2 GB, its body worked through. */
const stripePage = (bytes = STRIPE_PAGE_BYTES) => EXPORT_PAGE_SECONDS * MEMORY_SECOND + perMegabyte(bytes);
/**
 * What working out a program's book costs at the most, for a book of that
 * size (lib/affiliate-page-admission.ts, refreshBook): its reads, every
 * page of Stripe it may read, and the book kept written (at most
 * BOOK_SNAPSHOT_MAX_BYTES, past which it is not kept). Holding it is store
 * data, priced all month at that cap in the store's data line
 * (tests/store-data-registry.ts, nl:aff:@lib/affiliate-book-snapshot.ts),
 * so not again here.
 */
export function affiliatePageRead(size: AffiliatePageSize): number {
  const rows = Math.min(size.rows, AFFILIATE_ROW_CAP);
  const bytes = AFFILIATE_PAGE_BYTES + size.fields * AFFILIATE_FIELD_BYTES + rows * AFFILIATE_ROW_BYTES + size.listings * PUBLIC_LISTING_BYTES;
  // Every field could be an affiliate with a part of their own; every part its lines.
  const kept = Math.min(BOOK_SNAPSHOT_MAX_BYTES, (2 * size.fields + rows + size.stripePages * 100) * BOOK_LINE_BYTES + size.fields * BOOK_PART_BYTES);
  const writes = Math.ceil(kept / 512_000) + 1;
  return request("heavy", AFFILIATE_PAGE_COMMANDS + TAKE_COMMANDS + rows + 2 * writes, bytes + kept) + perMegabyte(bytes + kept)
    + size.stripePages * stripePage();
}
/** What one load of an approved affiliate's page costs at the most: the page, its own part of the kept book, its listings, and its codes when it reads them. */
export function affiliateLoadRead(size: AffiliateLoadSize): number {
  const bytes = size.sliceBytes + size.listings * PUBLIC_LISTING_BYTES + (size.codes ?? 0) * 256;
  // Only its own part leaves with the page (the listings give titles, the codes a few lines).
  return laterPageCost() + AFFILIATE_LOAD_COMMANDS * COMMAND + bytes * DB_BYTE + size.sliceBytes * ORIGIN_PER_BYTE + perMegabyte(bytes)
    + (size.codes === null ? 0 : stripePage(64_000));
}
/** What the listings a visitor's affiliate page reads add to the page itself (a later page, counted by isResting). */
export function publicListingsRead(listings: number): number {
  return listings * PUBLIC_LISTING_BYTES * DB_BYTE + perMegabyte(listings * PUBLIC_LISTING_BYTES);
}
/**
 * What one drawing of a store's map costs at the most (lib/store-sitemap.ts):
 * the request, the store's counts and the listings it reads, every page of
 * posts paid for (three commands each), working through all of it, and the
 * answer as it leaves, a line for each product, post, collection and page.
 */
export function sitemapRead(size: SitemapSize): number {
  const posts = size.postPages * POSTS_PER_PAGE;
  const bytes = size.listings * PUBLIC_LISTING_BYTES + posts * POST_META_BYTES;
  const lines = size.listings + size.carried + posts + 2 + 12 + 10;
  return request("heavy", 4 + TAKE_COMMANDS + 3 * size.postPages, bytes) + perMegabyte(bytes) + lines * SITEMAP_LINE_BYTES * ORIGIN_PER_BYTE;
}
/**
 * The most one agreement's version may be as it is kept (lib/agreement-store.ts,
 * readVersion reads it whole): its title, text and lines twice, once as typed
 * and once inside the text a signature covers (agreementText), with the store's
 * name, the person's name and address, and 2,000 characters for the text's own
 * words, its amounts and the record's keys and numbers; every character at six
 * bytes, what JSON makes of a lone surrogate or a control character (\uXXXX).
 */
export const AGREEMENT_VERSION_MOST =
  6 * (2 * (AGREEMENT_TITLE + AGREEMENT_BODY + AGREEMENT_LINES * AGREEMENT_LINE_TEXT) + STORE_NAME_MOST + AGREEMENT_NAME + MAX_EMAIL_LENGTH + 2_000);
/**
 * What a store's card in the buyer's library reads of what waits on them
 * there, at the most (app/library, lib/buyer-waiting.ts waitingFor; Codex J
 * on #1969), paid with LIBRARY_WAITING_UNITS of that store's buyer requests
 * before it is read: the requests taken, the person's two sets and their
 * records (MAX_PER_PERSON of each kind, twice as many ids read at the most, at
 * 16 KB a record), and each agreement listed checked or read whole
 * (AGREEMENT_VERSION_MOST). The card's own wait on Redis (its take and about
 * four round trips) is not a separate line: the room LIBRARY_WAITING_UNITS
 * leaves above these commands and bytes (about US$0.000019 a card) pays some
 * 3 s at 2 GB, well over it (Claude 5 on #1969); the units must keep that room.
 */
/** How long a library card waits on Redis at the most (its take and about four round trips), paid by LIBRARY_WAITING_UNITS' room. */
export const LIBRARY_CARD_WAIT_SECONDS = 3;
/** What that wait costs: the page's memory for those seconds (Claude 5 on #1969). */
export const libraryCardWait = (): number => LIBRARY_CARD_WAIT_SECONDS * MEMORY_SECOND;
export const libraryWaitingRead = (): number => {
  const bytes = 2 * (AGREEMENTS_PER_PERSON + REQUESTS_PER_PERSON) * 16_384 + WAITING_SHOWN * AGREEMENT_VERSION_MOST;
  return (TAKE_COMMANDS + 4 + WAITING_SHOWN) * COMMAND + bytes * DB_BYTE + perMegabyte(bytes);
};
/** Commands the orders page reads the store with (lib/store.ts, storeForPage): its handle and its record, MAX_STORE_BYTES at the most. */
export const ORDERS_STORE_COMMANDS = 2;
/**
 * What one opening of a buyer's orders page costs besides its metered reads
 * (app/[handle]/orders/page.tsx, lib/buyer-orders.ts openOrders), at the most:
 * the call; the page held at 2 GB for ORDERS_OPEN_SECONDS, its maxDuration,
 * which bounds every call to the creator's Stripe account it waits on however
 * many (the buyer's checkouts under both spellings of the address, the
 * payments after them, a payment plan's invoice, the store's bookings), and a
 * quarter of it in CPU, the heavy shape's share (SHAPES); the store read
 * (ORDERS_STORE_COMMANDS, its record at MAX_STORE_BYTES), the units' own
 * taking (TAKE_COMMANDS) and its ORDERS_OPEN_COMMANDS; what waits on the buyer
 * through the database (every agreement and payment request kept for the
 * address at 16 KB, and each agreement shown read whole, as one kept before
 * its mark held its title is, at AGREEMENT_VERSION_MOST); and the page sent on
 * at ORDERS_PAGE_BYTES, the most a page drawn at every limit of the store
 * sends now that a bundle's products are read only when asked for, its HTML,
 * its RSC payload and its shell (tests/orders-page-bounds.test.ts; 2 MB until
 * C3-80, when forty purchases of four full bundles drew 14.19 MB; 2.65 MB, the
 * HTML alone, until C3-83).
 * Counted as ORDERS_OPEN_UNITS public requests taken before anything is read;
 * every read past it is a command of the meter, priced at
 * ORDERS_METERED_COMMAND (tests/plan-cost-registry.test.ts holds both).
 */
export const ORDERS_OPEN_READ =
  CALL
  + ORDERS_OPEN_SECONDS * MEMORY_SECOND
  + (ORDERS_OPEN_SECONDS / 4) * CPU_SECOND
  + (ORDERS_STORE_COMMANDS + TAKE_COMMANDS + ORDERS_OPEN_COMMANDS) * COMMAND
  + (MAX_STORE_BYTES + (AGREEMENTS_PER_PERSON + REQUESTS_PER_PERSON) * 16_384 + WAITING_SHOWN * AGREEMENT_VERSION_MOST) * DB_BYTE
  + ORDERS_PAGE_BYTES * ORIGIN_PER_BYTE;
/**
 * What one download's lookup of its purchase costs besides its metered reads
 * and the download's own request, which pays its call (lib/buyer-orders.ts,
 * findPurchase), at the most: the download held at 2 GB for
 * DOWNLOAD_LOOKUP_MS, which bounds every call to the creator's Stripe account
 * it waits on (a checkout, or a payment taken in one click and its checkout),
 * with the wait shape's share of CPU (SHAPES); its DOWNLOAD_LOOKUP_COMMANDS;
 * and the one entry brought over, under 2 KB. Counted as
 * DOWNLOAD_LOOKUP_UNITS public requests taken after the grant (one read, paid by the request's own call) and before anything else is read
 * (tests/plan-cost-registry.test.ts holds them above it).
 */
export const DOWNLOAD_LOOKUP_READ =
  (DOWNLOAD_LOOKUP_MS / 1000) * MEMORY_SECOND
  + (DOWNLOAD_LOOKUP_MS / 1000) * (SHAPES.wait.cpu / SHAPES.wait.seconds) * CPU_SECOND
  + DOWNLOAD_LOOKUP_COMMANDS * COMMAND
  + 2_048 * DB_BYTE;
/**
 * What showing a bundle's products on the list of purchases costs besides its
 * metered reads and the request's own call (lib/buyer-orders.ts, bundleFor;
 * app/api/store/orders/bundle/route.ts; C3-80), at the most: a download's
 * lookup of one purchase, and its answer sent on, ORDERS_BUNDLE_BYTES (the
 * page drawn without JavaScript, the larger of the two).
 * Counted as ORDERS_BUNDLE_UNITS public requests taken after the grant (one read, paid by the request's own call) and before anything else is read
 * (tests/plan-cost-registry.test.ts holds them above it).
 */
export const ORDERS_BUNDLE_READ = DOWNLOAD_LOOKUP_READ + ORDERS_BUNDLE_BYTES * ORIGIN_PER_BYTE;
/**
 * What checking a batch of older purchases costs besides its metered reads and
 * the request's own call (lib/buyer-orders.ts, olderFor;
 * app/api/store/orders/older/route.ts; C3-80), at the most: the request held
 * at 2 GB as long as an opening (ORDERS_OPEN_SECONDS, which bounds every call
 * to the creator's Stripe account it waits on, inside ORDERS_STRIPE_CALLS),
 * a quarter of it in CPU, its ORDERS_OLDER_COMMANDS and its answer sent on,
 * ORDERS_OLDER_BYTES. Counted as ORDERS_OLDER_UNITS public requests taken
 * after the grant (one read, paid by the request's own call) and before anything else is read (tests/plan-cost-registry.test.ts holds them above it).
 */
export const ORDERS_OLDER_READ =
  ORDERS_OPEN_SECONDS * MEMORY_SECOND + (ORDERS_OPEN_SECONDS / 4) * CPU_SECOND + ORDERS_OLDER_COMMANDS * COMMAND + ORDERS_OLDER_BYTES * ORIGIN_PER_BYTE;
/** One command the orders page's meter takes (lib/buyer-orders.ts, OrdersMeter), at the most: the command and a kilobyte through the database. */
export const ORDERS_METERED_COMMAND = COMMAND + 1_024 * DB_BYTE;
/** One listing it reads, at the most: the command and a product's whole record (lib/catalog.ts, MAX_PRODUCT_BYTES). */
export const ORDERS_METERED_LISTING = COMMAND + MAX_PRODUCT_BYTES * DB_BYTE;
/**
 * One course's progress on the list, at the most (lib/purchase-cards.ts, progressOf; 560 [AS1]): its outline read whole
 * at COURSE_BYTES, as a command of its own, and one SMISMEMBER with its key and MAX_LESSONS lesson ids of 12 letters
 * sent, a 0 or 1 back for each (lib/learn.ts, lessonsDoneIn), taken as 4 KB.
 */
export const ORDERS_METERED_PROGRESS = 2 * COMMAND + (COURSE_BYTES + Math.max(4_096, 128 + MAX_LESSONS * 16)) * DB_BYTE;
/**
 * One read of a hundred bookings' moves, at the most (lib/call-records.ts, readMoves): one MGET, its keys sent and its
 * moves read back through the database (lib/call-moves-read.ts).
 */
export const ORDERS_METERED_MOVES = COMMAND + MOVES_PER_MGET * (MOVE_BYTES + MOVE_KEY_BYTES) * DB_BYTE;
/**
 * lib/two-step.ts lockedUntil, which every studio load and the locked-aware auth and store routes call: one command
 * (MGET) a call. Only in the "*" state (more than KEPT_ANY_MAX accounts whose locked sessions could not be read, until
 * SESSION_TTL_SECONDS and a day after the last such read; said in the server's log and counted for the owner's report,
 * keptStarMonth) does a session with no lock of its own send three commands more: this, a call, held in
 * tests/sg2-unknown-replies.test.ts. Counted in the studio unit below (UNIT_COST.studio) as if every load paid it.
 */
export const LOCKED_UNTIL_STAR_COMMANDS = 3;
/** What those commands add to a studio request, as UNIT_COST.studio takes them (the same sum, so no rounding is lost). */
export const LOCKED_UNTIL_STAR_EXTRA = request("studio", 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, 50_000) - request("studio", 20 + TAKE_COMMANDS, 50_000);
/** One unit of each store figure, at the most it costs (lib/store-allowance-rules.ts). */
export const UNIT_COST: Record<AllowanceKind, number> = {
  // A studio request at its shape, its twenty commands and fifty kilobytes through the database, and lockedUntil's
  // three commands more in the "*" state, taken as if every load paid them (review of #2556 at 0e308316).
  studio: request("studio", 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, 50_000),
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

/** Checkout-refusal panel, inside the existing studio unit (not added again):
 * one HMGET for seven UTC days plus last, with the writer's 60/300-character
 * code/message ceilings and safe integer counts. JSON control-character
 * escapes are escaped again by the REST response (2,770 bytes measured at
 * the writer's maximum); 4,096 includes framing and the fixed read command.
 * Historical fields never cross
 * this read boundary. This is not a storage-retention or whole-page proof.
 */
export const CHECKOUT_TROUBLE_READ = { commands: 1, fields: 8, bytes: 4_096 } as const;
/**
 * An API reading that reads more than its request pays for (lib/api-read-rules.ts:
 * a course's students, the affiliates, the bookings) takes further API requests
 * for its work before it reads. What that work costs: each command; each byte
 * read from the database and each byte sent on; each page of a Stripe list
 * waited on EXPORT_PAGE_SECONDS at 2 GB with its hundred rows parsed; and each
 * trip to the database waited on one after another, at ROUND_TRIP_SECONDS (a
 * review ceiling far above a trip inside one region). Held under the units it
 * takes, at every size, in tests/plan-cost-registry.test.ts.
 */
export const ROUND_TRIP_SECONDS = 0.25;
export const STRIPE_LIST_PAGE = EXPORT_PAGE_SECONDS * MEMORY_SECOND + 0.1 * CPU_SECOND;
export function apiReadCost(w: ReadWork): number {
  return w.commands * COMMAND + w.bytes * DB_BYTE + w.sent * ORIGIN_PER_BYTE + w.stripePages * STRIPE_LIST_PAGE + w.roundTrips * ROUND_TRIP_SECONDS * MEMORY_SECOND;
}
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
 * One of lib/read-ceilings.ts's worst reads, in dollars (C4-4, 4 November 2026):
 * its call, CPU, memory for its wall time and for each Stripe page waited on
 * (EXPORT_PAGE_SECONDS, as the export prices them), its commands, the bytes it
 * moves through the database and those it sends on.
 */
export function readShapeCost(shape: ReadShape): number {
  return CALL + shape.cpu * CPU_SECOND + (shape.seconds + shape.stripePages * EXPORT_PAGE_SECONDS) * MEMORY_SECOND
    + shape.commands * COMMAND + shape.dbBytes * DB_BYTE + shape.outBytes * ORIGIN_PER_BYTE;
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
/**
 * One reading of a store's buyers from the creator's Stripe account at the
 * most (lib/segments.ts, buyerLedger), when its ten-minute copy ran out: its
 * pages of sales, renewals, refunds, disputes and invoice payments read side
 * by side, the longest ALL_TIME_PAGES pages one after another, each waited
 * on at 2 GB (EXPORT_PAGE_SECONDS); and the copy of up to two rows a sale
 * and a renewal read (320 bytes each) written and read back. Counted as
 * BUYER_LEDGER_UNITS studio requests by a page that reads it, just before.
 */
export const BUYER_LEDGER_BYTES = 2 * ALL_TIME_PAGES * 100 * 320;
/**
 * A store's PayPal sales and refunds read for its buyers at the most
 * (lib/paypal-sales.ts, readPayPalSales and readPayPalRefundsWithCoverage;
 * round 5, H1): ALL_TIME_PAGES pages of a hundred sales and PAYPAL_REFUNDS_READ
 * refunds, each record at MAX_PAID_BYTES, in two MGETs and their ranges,
 * besides BUYER_LEDGER. Counted by lib/segments.ts from how many are kept
 * (ledgerReadBytes), a studio request a megabyte.
 */
export const PAYPAL_LEDGER_BYTES = (ALL_TIME_PAGES * 100 + PAYPAL_REFUNDS_READ) * MAX_PAID_BYTES;
export const PAYPAL_LEDGER = request("heavy", 6, PAYPAL_LEDGER_BYTES);
/**
 * The PayPal hand-over list (lib/paypal-sales.ts, handOverKey; lib/paypal-delivery.ts, handOverPayPal and
 * handOverAgain; #2909, Claude 5's LEVE 2), in Redis commands, each held to what the real return route and the real
 * sweep send by tests/paypal-handover-cost.test.ts:
 * - listCommandsPerSale: each PayPal sale adds the list's ZADD in settle's pipeline and its ZREM once handed over,
 *   inside that order's own work (line orders, ORDER_COMPUTE);
 * - listReadsPerStoreRun: each sweep of a store with PayPal reads the list once (ZRANGEBYSCORE), due orders or not;
 * - ordersPerStoreRun: that read asks for at most HAND_OVER_BATCH orders (lib/paypal-delivery.ts), so one sweep tries
 *   no more;
 * - ownCommandsPerOrderTried: the retry's own commands for an order it tries, at the most: the paid record's GET, the
 *   refund mark's ZSCORE (refundSeen) and at most two writes to the list (ZREM when handed over, its product gone,
 *   its paid record gone or refunded; ZADD when kept, twice when its product does not read). What a hand-over itself
 *   reads and writes is the order's (line orders); one that fails is tried again at the next sweep, at most once a run.
 * - receiptTriesPerOrder: a receipt the sender did not accept is tried again (#3387) at receiptDue, the first try
 *   included at most RECEIPT_TRIES_AT_MOST times (lib/paypal-delivery.ts), never past RECEIPT_RETRY_SECONDS after its
 *   first try, each time through the one sender kept for its key (sendEmailPinned): at most one request a sender
 *   attempt, and none again once an answer was not known;
 * - commandsPerReceiptTry: every Redis command one such try sends, from the paid record's GET to the list's ZADD, the
 *   hand-over's rerun (its writes already there), the first-try mark, the link's grant, the receipt kept as first
 *   made (two GETs each try; on the try that keeps it, one EVAL, KEEP_RECEIPT, whose six calls are the person's
 *   deletion mark read, its three erasure notes, SET NX and GET) and the kept sender included, at the most measured
 *   with either sender refusing (tests/paypal-handover-cost.test.ts for Resend, tests/paypal-receipt-once.test.ts for
 *   Amazon): 33 sent, with the receipt kept, Amazon refusing for the account (the owner told), the key moved to Resend
 *   and Resend asking to slow down (429) on each of viaResend's three attempts, all in one try (a refusal Amazon gave
 *   goes on to Resend in the same try; part E2). 52 counts each of KEEP_RECEIPT's six calls besides its EVAL (39),
 *   and a store from before lists given its list in that try, once in its life (ensureListId: 7 sent, measured in
 *   part K, the three lock and write scripts' two calls each counted too, 13). The kept receipt is at most
 *   RECEIPT_MAIL_BYTES (lib/paypal-delivery.ts), written once and read back by each try; its key is priced as the
 *   order's in tests/store-data-registry.ts (nl:ppsell:mail:). The guarded Resend ledger's own EVALs are lib/resend-fallback-budget's.
 *   PAYPAL_RECEIPT_RETRY_COMMANDS is their product: the most one order's receipt retries send.
 * Why the retry is the five-minute job's, not a plan's: NOT_A_COST.HAND_OVER_BATCH.
 */
export const PAYPAL_HAND_OVER_RETRY = { listCommandsPerSale: 2, listReadsPerStoreRun: 1, ordersPerStoreRun: 25, ownCommandsPerOrderTried: 4, receiptTriesPerOrder: 12, commandsPerReceiptTry: 52 } as const;
export const PAYPAL_RECEIPT_RETRY_COMMANDS = PAYPAL_HAND_OVER_RETRY.receiptTriesPerOrder * PAYPAL_HAND_OVER_RETRY.commandsPerReceiptTry;
export const BUYER_LEDGER = request("heavy", 8 + TAKE_COMMANDS, 2 * BUYER_LEDGER_BYTES) + ALL_TIME_PAGES * EXPORT_PAGE_SECONDS * MEMORY_SECOND;
/**
 * A narrowed email's reading of the store's buyers made by the scheduled job
 * (lib/broadcasts.ts, readNarrowing; the "scheduled-reads" line): one
 * BUYER_LEDGER at the most, at most READS_HELD of them an email, each paid in
 * studio requests before it is read, exactly as buyerLedger counts them: from
 * what the email held in the month it goes out when it was accepted
 * (createBroadcast, lib/store-allowance.ts holdAllowanceAt; all held for one
 * month never passes that month's studio figure), and beyond that from the
 * month it is read in; with none left there it waits, never read unpaid. A
 * plan not paid and running when it is due, or a store that reads no buyers
 * any more, reads nothing. A hold made under a larger plan draws no more than
 * the month's own figure leaves. A reading that fails at Stripe or PayPal keeps
 * spent what it drew, READ_MISSES_ALLOWED times in a row at most. A subject
 * test decided by sales (countTest) pays a reading of every sale before it
 * reads its TEST_SALES_PAGES pages.
 */
export const SCHEDULED_READS = { id: "scheduled-reads", each: BUYER_LEDGER, units: "studio" } as const;
/**
 * The tasks agenda on the buyers page at the most (app/studio/people/page.tsx,
 * TasksAgenda; 639 [GL7](6)): every task of the store read and its rows sent
 * on. Counted as AGENDA_UNITS studio requests besides the page's own, taken
 * before it reads; its reading of the buyers is BUYER_LEDGER, counted apart.
 */
export const AGENDA_READ = request("heavy", 6 + TAKE_COMMANDS, AGENDA_TASKS_BYTES) + AGENDA_MAX_ROWS * AGENDA_ROW_SENT_BYTES * ORIGIN_PER_BYTE;
export const PATH_BOARD_PRIVACY = request("heavy",30,120_000);

export const PATH_READ = request("heavy", 26, LIFE_WRITE_MAX * 96 + 20_480) + (PATH_SALE_PAGES + PATH_REFUND_PAGES) * EXPORT_PAGE_SECONDS * MEMORY_SECOND;

/**
 * Review ceilings for a collection page's reads, paid for since 4 November 2026
 * (lib/page-read-rules.ts). What working through a body costs past what a
 * request's shape holds, a heavy request's CPU and wait for each megabyte.
 */
const bodyWork = (bytes: number) => bytes * DB_BYTE + (bytes / 1e6) * (SHAPES.heavy.cpu * CPU_SECOND + SHAPES.heavy.seconds * MEMORY_SECOND);
/** A product's listing. */
export const READ_LISTING_BYTES = 16_384;
/** One product on a collection page past its drawing: its stock, its keys and the bundles holding it (four commands), and its listing, those its checkout boxes offer and a bundle's. */
export function collectionRead(products: number): number {
  return products * (4 * COMMAND + bodyWork((2 + MAX_BUMPS) * READ_LISTING_BYTES));
}

/** The items the bundles on a collection page hold, read to show them (lib/bundles.ts, offeredItems): each one's listing, one command each. */
export function bundleItemRead(items: number): number {
  return items * (COMMAND + bodyWork(READ_LISTING_BYTES));
}

/**
 * Review ceilings for a community search and the walk of its archive, paid
 * for since 4 November 2026 (lib/community-read-rules.ts). What working
 * through a body costs past what a request's shape holds, a heavy request's
 * CPU and wait for each megabyte.
 */
const searchBodyWork = (bytes: number) => bytes * DB_BYTE + (bytes / 1e6) * (SHAPES.heavy.cpu * CPU_SECOND + SHAPES.heavy.seconds * MEMORY_SECOND);
/** The most a product's listing, and one of a community's messages, posts, events or members, takes in any script. */
export const SEARCH_LISTING_BYTES = 16_384;
export const READ_ROOM_MESSAGE_BYTES = 3_200;
export const READ_DM_MESSAGE_BYTES = 6_500;
export const READ_POST_BYTES = 16_000;
/**
 * One search of a community past its page: the four indexes and their next
 * page, a page of results and what is drawn beside it (a hundred commands at
 * the most, with the posts, the products and the people of a page), the
 * room's last MAX_CHAT_KEPT messages where it is on, and SEARCH_MESSAGES of
 * each conversation read.
 */
export function searchRead(size: { room: boolean; conversations: number }): number {
  const page = SEARCH_PAGE * (READ_POST_BYTES + SEARCH_LISTING_BYTES + 2_048);
  return request("heavy", 100, page) + searchBodyWork(page)
    + (size.room ? COMMAND + searchBodyWork(MAX_CHAT_KEPT * READ_ROOM_MESSAGE_BYTES) : 0)
    + size.conversations * (COMMAND + searchBodyWork(SEARCH_MESSAGES * READ_DM_MESSAGE_BYTES));
}
/** One check of who holds a product or an event: its cached answer read and written, and up to three calls to Stripe waited on at 2 GB. */
export const ACCESS_CHECK_READ = 4 * COMMAND + 3 * (EXPORT_PAGE_SECONDS * MEMORY_SECOND + searchBodyWork(64_000));
/** One step of the walk of a community's archive: its commands, the bytes it reads, and its round trip waited on. */
export function walkRead(commands: number, bytes: number): number {
  return commands * COMMAND + searchBodyWork(bytes) + 0.05 * MEMORY_SECOND;
}

/** One host's calendar read: its commands, and the wait for the calendar, held at 2 GB inside the page that asked. */
export const TEAM_READING = 7 * COMMAND + 1 * MEMORY_SECOND + 0.05 * CPU_SECOND;
/** Commands a view of a team call's page costs: each host's claims, and one MGET of every host's calendar state and connection plus the round-robin counts (lib/team-booking.ts). */
export const TEAM_COMMANDS_PER_HOST_VIEW = 1;
export const TEAM_COMMANDS_PER_VIEW = 2;

/** Windows of a counter that a 31-day month can touch. */
export const DAY_WINDOWS = 32;

/** CX-61: two bounded provider reads, independent of released-name history.
 * Vercel's official regional table read 2026-11-04 has a highest memory rate
 * of $0.0183/GB-hour. Use it for this row while deployment region is unknown.
 * The Stripe endpoint tariff stays explicitly unknown, never certified zero.
 */
export const PLATFORM_SUBSCRIPTION_SEARCH = {
  maxGets: 2,
  waitSeconds: STRIPE_TIMEOUT_MS / 1000,
  memoryGb: 2,
  memoryUsdPerGbHour: 0.0183,
  memoryUsdPerGet: STRIPE_TIMEOUT_MS / 1000 * 2 * 0.0183 / 3600,
  essentialEventsPerWindow: ESSENTIAL_PER_DAY * DAY_WINDOWS,
  closingEventsPerWindow: DAY_WINDOWS,
  stripeGetFeeUsd: null,
  deploymentRegionVerified: false,
} as const;
export const PLATFORM_SUBSCRIPTION_SEARCH_EVENT_USD = PLATFORM_SUBSCRIPTION_SEARCH.maxGets * PLATFORM_SUBSCRIPTION_SEARCH.memoryUsdPerGet;
/**
 * #3334: the seconds one start of the Store assistant add-on can hold the function past the two GETs the line above
 * already prices for the same essential event: the smaller of its most calls each waited on for STRIPE_TIMEOUT_MS (plus
 * the in-progress wait) and its hard end ASSISTANT_START_CUTOFF_MS (lib/store-assistant-rules.ts). With the cutoff at
 * those two GETs' 40 s it is 0: priced, and inside what is already paid for.
 */
export const ASSISTANT_START_EXTRA_SECONDS = Math.max(0,
  Math.min(ASSISTANT_START_STRIPE_CALLS * PLATFORM_SUBSCRIPTION_SEARCH.waitSeconds + ASSISTANT_IN_PROGRESS_WAIT_MS / 1000, ASSISTANT_START_CUTOFF_MS / 1000) -
    PLATFORM_SUBSCRIPTION_SEARCH.maxGets * PLATFORM_SUBSCRIPTION_SEARCH.waitSeconds);
export const UTC_DAYS = 31;

/** CX-67 company exposure, deliberately outside paid-unit COST_LINES. These
 * modeled components are not a complete tariff/tax/retention certification. */
export const HELD_EXPOSURE = {
  dailyAttempts: HELD_RECHECKS_PER_DAY,
  monthlyAttempts: HELD_RECHECKS_PER_DAY * 31,
  retryCounterSeconds: HELD_RETRY_COUNTER_SECONDS,
  monthlyAggregateSeconds: HELD_MONTH_COUNT_SECONDS,
  retryCommands: 128,
  retryReplyBytes: MAX_STORE_BYTES + 128 * 1024,
  indexBytesPerStore: 4096,
  globalCounterBytes: 3 * (HELD_RECHECKS_PER_DAY * 256 + 1024) + 15 * 1024 + 1024,
  stripeEndpointTariffUsd: null,
  completeMonthlyCostUsd: null,
  reviewedGlobalCaseCeiling: null,
} as const;
/** A full held store, not its smaller ended-store allowance, for31days. All
 * still-retained outside-room keys are charged at peak for the whole month. */
export function heldStoreMonthlyExposure(tier: Tier) {
  const fileBytes = paidStorageBytes(tier) + TASK_ROOM_BYTES[tier] + COMMUNITY_PICTURES[tier] * PICTURE_BYTES;
  const databaseBytes = DATA_ROOM_BYTES[tier] + reservePeakBytes(tier) + HELD_EXPOSURE.indexBytesPerStore;
  const retentionUsd = fileBytes / GB * STORAGE_PER_GB * 31 / 30 + databaseBytes * DB_BYTE_MONTH * 31 / 30;
  const retryUsd = heldRecheckMemoryUsd() + HELD_EXPOSURE.retryCommands * COMMAND + HELD_EXPOSURE.retryReplyBytes * DB_BYTE;
  return { fileBytes, databaseBytes, retentionUsd, retryUsd, modeledMonthlyUsd: retentionUsd + 31 * retryUsd, completeMonthlyUsd: null };
}
/** Explicit reviewed finite case cap, never inferred from missing data. Existing
 * over-cap obligations stay counted and invalidate a financed company total. */
export function heldCompanyMonthlyExposure(caseCap: number | null, observed: number | null): { modeledUsd: number | null; completeUsd: null } {
  if (caseCap === null || observed === null || !Number.isSafeInteger(caseCap) || !Number.isSafeInteger(observed) || caseCap < 0 || observed < 0 || observed > caseCap) return { modeledUsd: null, completeUsd: null };
  const retention = Math.max(...(["creator", "pro", "scale"] as const).map(tier => heldStoreMonthlyExposure(tier).retentionUsd));
  const retry = heldStoreMonthlyExposure("scale").retryUsd;
  return { modeledUsd: caseCap * retention + HELD_EXPOSURE.monthlyAttempts * retry + HELD_EXPOSURE.globalCounterBytes * DB_BYTE_MONTH, completeUsd: null };
}


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
    id: "platform-subscription-search",
    feature: "Platform subscription recovery during checkout, store deletion and scheduled closing (CX-61)",
    monthlyUsd: () => PLATFORM_SUBSCRIPTION_SEARCH_EVENT_USD * (PLATFORM_SUBSCRIPTION_SEARCH.essentialEventsPerWindow + PLATFORM_SUBSCRIPTION_SEARCH.closingEventsPerWindow),
    sources: [
      { file: "lib/store-field-rules.ts", names: ["MAX_ADDRESSES"] },
      { file: "lib/fetch-timeout.ts", names: ["STRIPE_TIMEOUT_MS"] },
      { file: "lib/billing.ts", names: ["findStoreSubscriptions", "completeSubscriptionPage"] },
      { file: "lib/studio-allowance-rules.ts", names: ["ESSENTIAL_NEEDS", "ESSENTIAL_PER_DAY"] },
      { file: "app/api/billing/checkout/route.ts", names: ["creatorFrom(request, \"billing\")", "findStoreSubscriptions(store)"] },
      { file: "app/api/store/stores/route.ts", names: ["creatorFrom(request, \"delete\")", "findStoreSubscriptions(store)"] },
      // 601 [KB22] U5: the plan's invoices are one invoice List inside one billing request of the day (PLAN_INVOICES_READ).
      { file: "lib/plan-invoices.ts", names: ["takeInvoicesRead", "onPlatformAt(STRIPE_LIST_VERSION, \"GET\", `/invoices?${query}`)"] },
      { file: "lib/plan-closing.ts", names: ["observeStoreSubscriptions(store)", "refuseLatePlans"] },
      { file: "vercel.json", names: ["/api/cron/closing", "30 9 * * *"] },
    ],
    basis: "CX-61, sources read 2026-11-04: at most two GETs (one Search over at most MAX_ADDRESSES current names, one captured-customer List), each waited on for STRIPE_TIMEOUT_MS at 2 GB and the highest regional memory rate $0.0183/GB-hour (https://vercel.com/docs/functions/usage-and-pricing). Billing and deletion share ESSENTIAL_PER_DAY, not that many each; scheduled closing is counted at DAY_WINDOWS. Never multiplied by visits. This is a function-memory ceiling; existing CPU, invocation and other costs remain. Stripe GET tariff stays null (https://stripe.com/pricing does not establish an endpoint-specific zero); deployment region and financed post-cancellation exposure remain unverified. No sale, price, quota or gate is activated.",
  },
  {
    id: "assistant-start-reads",
    feature: "Starting the Store assistant add-on: its Stripe reads and writes before a checkout opens (#3334)",
    monthlyUsd: () => ASSISTANT_START_EXTRA_SECONDS * PLATFORM_SUBSCRIPTION_SEARCH.memoryGb * PLATFORM_SUBSCRIPTION_SEARCH.memoryUsdPerGbHour / 3600 *
      PLATFORM_SUBSCRIPTION_SEARCH.essentialEventsPerWindow,
    sources: [
      { file: "lib/store-assistant-rules.ts", names: ["ASSISTANT_START_LIST_PAGES", "ASSISTANT_START_STRIPE_CALLS", "ASSISTANT_IN_PROGRESS_WAIT_MS", "ASSISTANT_START_CUTOFF_MS"] },
      { file: "lib/assistant-billing.ts", names: ["startAssistant", "withCutoff(Date.now() + ASSISTANT_START_CUTOFF_MS", "timeLeft() <= ASSISTANT_IN_PROGRESS_WAIT_MS", "START_LIST_PAGES", "readCustomerList", "ensureAssistantPrice", "createAssistantCheckout", "error.status !== 409"] },
      { file: "app/api/billing/assistant/route.ts", names: ["creatorFrom(request, \"billing\")", "startAssistant(store, origin)"] },
      { file: "lib/studio-allowance-rules.ts", names: ["ESSENTIAL_PER_DAY"] },
      { file: "lib/fetch-timeout.ts", names: ["STRIPE_TIMEOUT_MS"] },
    ],
    basis: `A start of the add-on is a billing request (creatorFrom "billing"), inside ESSENTIAL_PER_DAY with the plan's checkout and deletion, so every essential event of the month (${PLATFORM_SUBSCRIPTION_SEARCH.essentialEventsPerWindow}) is taken as a start held for its longest: the smaller of its most calls, ${ASSISTANT_START_STRIPE_CALLS} (${ASSISTANT_START_LIST_PAGES} pages of subscriptions, ${ASSISTANT_START_LIST_PAGES} of open pages and ${ASSISTANT_START_LIST_PAGES} more after a 409, the price read, the product read and write, the price write, the checkout POST) each waited on for STRIPE_TIMEOUT_MS plus the ASSISTANT_IN_PROGRESS_WAIT_MS wait, and its hard end ASSISTANT_START_CUTOFF_MS (${ASSISTANT_START_CUTOFF_MS / 1000} s, withCutoff), at the platform-subscription-search memory rate, less the ${PLATFORM_SUBSCRIPTION_SEARCH.maxGets} GETs of ${PLATFORM_SUBSCRIPTION_SEARCH.waitSeconds} s that line already prices for the same event: ${ASSISTANT_START_EXTRA_SECONDS} s more. The cutoff is set to those ${PLATFORM_SUBSCRIPTION_SEARCH.maxGets * PLATFORM_SUBSCRIPTION_SEARCH.waitSeconds} s, so this line is $0 because the start's longest hold fits inside what the event is already priced at, not because a cost is unknown. Adopting a live add-on makes fewer calls, inside the same cutoff. A function-memory ceiling, not CPU or invocations; the Stripe tariff per call stays unknown (null), never zero, as in platform-subscription-search. Not on sale while ASSISTANT_ON_SALE is false; the line is counted now so the start is priced before it can be.`,
  },
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
      // A cart's checkout holds a unit of each limited product in it (513 [PF1], unit 3, 2 November 2026): a lock, a count, a provisional hold and its own for each, at most MAX_CART.
      // Since Codex G2's review (5 November 2026) the admission and the hand-over are one script each (STOCK_ADMIT, which also lets the locks go,
      // and STOCK_BIND: 1 + 3 commands a product each); Stripe is never asked under a lock and a lock waits LOCK_WAIT_MS at most. The whole of it,
      // at its worst for MAX_CART limited products, is measured in tests/cart-stock.test.ts (68 commands on 5 November 2026) and held under
      // CART_STOCK_COMMANDS_MOST, half of ORDER_COMPUTE at most. An opening whose answer is unknown asks nothing more: its holds lapse.
      { file: "lib/stock.ts", names: ["withCartStockHolds", "PENDING_MS", "releaseCartStockHolds", "STOCK_ADMIT", "STOCK_BIND", "stripeRefusedOpening", "LOCK_WAIT_MS = 500", "countStock(store, product, now, false)"] },
      { file: "app/api/store/free/download/route.ts", names: ["recordAffiliateLead"] },
    ],
    basis: "The plan's figure, each order at the most one costs. An affiliate's lead for a free product claimed or a booked call (lib/affiliate-leads.ts, 18 October 2026) is three or four commands inside that order's own work, which ORDER_COMPUTE prices at well over a whole page, and no email; what it keeps is in the data room, taken before it is written. Nothing is sold past it: new orders are admitted only while the month's orders and the checkouts held from the last day are under the figure. A place in a purchase for several people is an order of the month it is taken in: inside its checkout's hold for a day, admitted when taken after (since 18 October 2026), its emails access emails. A payment request's record is changed under its own lock (since 18 October 2026, docs/security-audit-2026-10-18.md, MM-SA-02): four commands more a change, at most a dozen changes a request (made, sent, reminded twice, opened, paid, refunded), inside the same ORDER_COMPUTE. Since 8 November 2026 the record is written only while that lock is still the writer's (lib/payment-request-store.ts, SAVE): a change's three writes become one script that runs five inside it, three commands more a change with Lua's own counted, and the request is made under its lock too, seven more (the lock, the script's three over the plain write, the release's three); at most 43 commands more a request, $0.000086 at Upstash's $2 a million, no other command and nothing more kept.",
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
      // An upload's batch and count are written only over the import as it was read (JOB_WRITE_IF).
      const uploads = (a.rows / IMPORT_MIN_ROWS_PER_UPLOAD) * request("heavy", 4 + JOB_WRITE_IF_EXTRA_COMMANDS, 0);
      // Every start priced as a members upload that holds the month's emails and is left until the five-minute job gives it up,
      // with its finish written only over the one read and, at the start, an old upload given up at an end's worst.
      const starts = a.starts * request("light", 20 + JOB_WRITE_IF_EXTRA_COMMANDS + IMPORT_END_EXTRA_COMMANDS + HELD_UPLOAD_SWEEP_COMMANDS);
      // A step's one give-back (its end, or a send tried again) never below zero.
      const steps = a.steps * request("step", 10 + GIVE_BACK_FLOOR_EXTRA_COMMANDS);
      const reports = a.reports * request("light", 4, MAX_REPORT_ROWS * 400);
      return rows + uploads + starts + steps + reports + a.movedEmails * PER_EMAIL;
    },
    sources: [
      { file: "lib/import-limits.ts", names: ["IMPORT_ALLOWANCES", "IMPORT_WORST_COMMANDS_PER_ROW", "IMPORT_WORST_BYTES_PER_ROW", "IMPORT_MIN_ROWS_PER_UPLOAD"] },
      { file: "lib/imports.ts", names: ["takeImportRows", "reserveMoved", "IMPORT_LIMITS", "HELD_UPLOAD_SWEEP_COMMANDS", "JOB_WRITE_IF_EXTRA_COMMANDS", "IMPORT_END_EXTRA_COMMANDS"] },
      { file: "lib/mail.ts", names: ["GIVE_BACK_FLOOR_EXTRA_COMMANDS"] },
      { file: "app/api/store/import/route.ts", names: ["import-start-month", "import-step-month", "import-report-month"] },
      // The store's deleted people, checked where a chunk of past buyers or members is written (review of #3383).
      { file: "lib/imported-purchases.ts", names: ["GRANT_UNLESS_ERASED", "grantUnlessErased"] },
      { file: "lib/move-members.ts", names: ["INVITE_UNLESS_ERASED"] },
    ],
    basis: "Every row of the month at its command and transfer ceiling, every upload at the fewest rows one counts, every start, step and report download; Store's own emails to people brought over (Studio and Scale send theirs from the monthly emails). Who was deleted from the store is read once a chunk of past buyers or members (CHUNK, 250 rows) before the repeat check and once more inside the script that writes the chunk (GRANT_UNLESS_ERASED, INVITE_UNLESS_ERASED: its EVAL and one HMGET), three commands a chunk; each row's own writes are the same HSETNX as before, moved inside that script, and a row found deleted there writes nothing and lets go of its repeat-check field (one HDEL in place of those writes). A store made before every store had a list is given one once (lib/store.ts ensureListId).",
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
    sources: [
      { file: "lib/embed-open.ts", names: ["isResting", "OPENS_PER_TEN_MINUTES"] },
      { file: "app/embed/[handle]/[product]/page.tsx", names: ["StoreBeacon"] },
      { file: "app/embed/[handle]/join/page.tsx", names: ["StoreBeacon"] },
    ],
    basis: "Page views load nothing from us; an open of a card counts as a visit, sent by the card's own beacon like any page of the store (app/api/store/hit, through the host's browser check), and rests with the public pages, so it is inside the visits line, and a checkout from it is an order.",
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
      // A collection's products paid before they are read, and a license check before it reads the product (4 November 2026).
      { file: "lib/page-read-rules.ts", names: ["COLLECTION_PRODUCTS_PER_UNIT", "collectionUnits", "BUNDLE_ITEMS_PER_UNIT", "bundleItemUnits"] },
      { file: "app/[handle]/shop/[collection]/page.tsx", names: ["collectionUnits(ids.length)", "bundleItemUnits(items.length)"] },
      { file: "app/api/store/licence/route.ts", names: ["takePublicRequest(store, \"buyer\")"] },
      // A community search and its access checks, and the one walk of its archive, paid before they read (4 November 2026).
      { file: "lib/community-read-rules.ts", names: ["SEARCH_UNITS", "SEARCH_ROOM_UNITS", "SEARCH_UNITS_PER_CONVERSATION", "SEARCH_UNITS_PER_CHECK", "WALK_COMMANDS_PER_UNIT", "WALK_BYTES_PER_UNIT"] },
      { file: "app/[handle]/community/search/page.tsx", names: ["searchUnits({ room: config.chat.on, conversations })", "checkUnits(checks)", "{ shared: true }"] },
      { file: "lib/community-walk.ts", names: ["walkUnits(", "indexedWords(", "INDEXED_WORDS_BYTES"] },
      { file: "lib/traffic.ts", names: ["countRequest", "takePublicRequest", "requestsKey"] },
      { file: "lib/metered-limits.ts", names: ["withinStore"] },
      // A sign-up credited to an affiliate takes one of these before its lead is written (18 October 2026).
      { file: "lib/affiliate-leads.ts", names: ["takePublicRequest(store)", "count?: boolean"] },
      // The offers after a cart read what the buyer already has from the creator's Stripe account, counted before (556 [CT1], 1 November 2026).
      { file: "lib/cart-offers.ts", names: ["takeBuyerRead(store, CART_OFFER_REQUEST_UNITS)", "CART_OFFER_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS"] },
      // A course's "More from" shelf reads what a student owns the same way, counted before (628 [HN4](b), 10 November 2026).
      { file: "lib/course-shelf.ts", names: ["takeBuyerRead(store, SHELF_REQUEST_UNITS)", "SHELF_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS", "ownedHere(store, email)"] },
      { file: "app/[handle]/course/[product]/page.tsx", names: ["shelfShown(store, course.shelf, product.id, access.learner.email)"] },
      // A signed proposal or agreement takes one more before the workflows that start on signing are checked (635 [GL3], 2 November 2026).
      { file: "lib/agreement-flow-trigger.ts", names: ["SIGNED_TRIGGER_UNITS", "takePublicRequest(store, \"buyer\", Date.now(), SIGNED_TRIGGER_UNITS)"] },
      // An opening of a buyer's orders page takes ORDERS_OPEN_UNITS before anything is read, and its meter more before each read
      // that grows with what the buyer has (C3-77, MR, 4 November 2026; ORDERS_OPEN_READ in tests/plan-cost-registry.test.ts).
      { file: "lib/buyer-orders.ts", names: ["takePublicRequest(store, \"buyer\", Date.now(), ORDERS_OPEN_UNITS)", "takePublicRequest(this.store, \"buyer\", Date.now(), units)", "callsFor(store: Store, email: string, meter?: OrdersMeter)", "meter.takeFor(ORDERS_CALL_MOVES, () => paidCalls(store), (calls) => ordersMovesCommands(calls.length))", "else this.left += most - n", "withinOpening", "purchasesFor(store: Store, email: string, meter?: OrdersMeter)"] },
      { file: "lib/buyer-orders-rules.ts", names: ["ORDERS_OPEN_UNITS", "ORDERS_OPEN_SECONDS", "ORDERS_OPEN_COMMANDS", "ORDERS_UNIT_COMMANDS", "ORDERS_READ_MS", "ORDERS_IMPORTED_ENTRY_COMMANDS", "ORDERS_CALL_MOVES", "ORDERS_MOVES_READ_COMMANDS", "ordersMovesCommands", "ORDERS_LISTING_COMMANDS", "ORDERS_KEY_COMMANDS", "ORDERS_FEED_COMMANDS", "ORDERS_ROOM_COMMANDS", "ORDERS_PROGRESS_COMMANDS"] },
      // The bookings' moves are read a hundred at an MGET, all in one trip (C3-82, MR, 4 November 2026).
      { file: "lib/call-moves-read.ts", names: ["MOVES_PER_MGET", "MOVE_BYTES", "MOVE_KEY_BYTES", "moveReads"] },
      { file: "lib/call-records.ts", names: ["const perRead = 100;", '["MGET", ...lot.map(movedKey)]'] },
      // A request for the link to that list, and a download from it, read the same purchases the same way: each takes ORDERS_OPEN_UNITS
      // before it reads, its meter the rest before each read, and the store's "too many" answer without room (C3-78, MR, 4 November 2026).
      // A download from it reads only the purchase asked for, by its reference: DOWNLOAD_LOOKUP_UNITS after the grant (one read) and before the rest, and only the
      // listings it hands over through the meter, never read again (DOWNLOAD_LOOKUP_READ in tests/plan-cost-registry.test.ts).
      { file: "lib/buyer-orders.ts", names: ["export async function requestOrdersLink", "withinOpening(Promise.all([purchasesFor(store, raw, meter), callsFor(store, raw, meter)]), meter, ORDERS_LINK_READ_MS)", "afterAnswer(() => sendLink(store, raw, email, origin))", "export async function findPurchase", "takePublicRequest(store, \"buyer\", Date.now(), DOWNLOAD_LOOKUP_UNITS)", "withinOpening(lookUp(store, email, kind, reference, meter, want), meter, DOWNLOAD_LOOKUP_MS)", "DOWNLOAD_LOOKUP_MS)) as Row", "await meter.take(Number(count) || 0)", "const find = finderFor(store, meter)", "function onlyFinder(store: Store, meter: OrdersMeter)"] },
      { file: "lib/buyer-orders-rules.ts", names: ["DOWNLOAD_LOOKUP_UNITS", "DOWNLOAD_LOOKUP_MS", "DOWNLOAD_LOOKUP_COMMANDS", "ORDERS_LINK_READ_MS"] },
      { file: "app/api/store/orders/route.ts", names: ["export const maxDuration = 30", "requestOrdersLink", "if (result === \"busy\") return tooMany();"] },
      { file: "app/api/store/download/route.ts", names: ["findPurchase(store, token", "if (error instanceof OrdersBusy) return tooOften();", "const item = await listing(line.productId);", "const owner = await listing(bumped ? bumped.id : purchase.productId);"] },
      { file: "app/[handle]/orders/page.tsx", names: ["export const maxDuration = 30", "openOrders(store, token)", "withinOpening(reading, meter)", "purchasesFor(store, email, meter)", "callsFor(store, email, meter)", "extrasFor(store, email, listed, meter)", "<PurchaseCard", "<OlderPurchases"] },
      { file: "lib/purchase-cards.ts", names: ["meter.take(keyed.length * ORDERS_KEY_COMMANDS)", "meter.take(podcasts.length * ORDERS_FEED_COMMANDS)", "meter.take(ids.length * ORDERS_LISTING_COMMANDS)", "meter.take(new Set(courses.map(({ courseId }) => courseId)).size * ORDERS_PROGRESS_COMMANDS)", "readCoursesExact(courses.map(({ courseId }) => courseId))"] },
      // A course's progress asks only about its own lessons, one 0 or 1 each (560 [AS1]).
      { file: "lib/learn.ts", names: ["export async function lessonsDoneIn", "[\"SMISMEMBER\", doneKey(course.id, email), ...ids]"] },
      { file: "components/purchase-card.tsx", names: ["<OrdersBundle"] },
      // An opening asks the creator's Stripe account ORDERS_STRIPE_CALLS times at the most, a payment plan's refund check taken
      // before it is made; a bundle's products are read only when the buyer asks, by their own request: ORDERS_BUNDLE_UNITS
      // after the grant (one read) and before the rest, the listings and keys through the meter (C3-80, 4 November 2026; ORDERS_BUNDLE_READ in
      // tests/plan-cost-registry.test.ts, the page's bytes and the calls in tests/orders-page-bounds.test.ts).
      { file: "lib/buyer-orders.ts", names: ["if (meter && calls > 0 && !meter.stripe(calls))", "if (shown >= MAX_LISTED) {", "if (meter?.older.length && refundCalls(session) > 0) {", "if (purchases.length >= ORDERS_OLDER_MOST) {", "if (meter && !checked && !meter.stripe(1)) return null;", "if (!meter.stripe(taken.filter(disputed).length)) return wait;", "return this.stripe(1);", "export async function bundleFor", "takePublicRequest(store, \"buyer\", Date.now(), ORDERS_BUNDLE_UNITS)", "export async function olderFor", "takePublicRequest(store, \"buyer\", Date.now(), ORDERS_OLDER_UNITS)", "if (purchases.length === 0 && calls.length === 0 && unchecked === 0) return;", "await meter.take(keyed.length * ORDERS_KEY_COMMANDS)", "await linesOf(find, bundleFromMeta(meta, \"bundle\"), lines)"] },
      { file: "lib/buyer-orders-rules.ts", names: ["ORDERS_STRIPE_CALLS", "ORDERS_STRIPE_LISTS", "PLAN_REFUND_CALLS", "ORDERS_PAGE_BYTES", "LINK_SHOWN", "ORDERS_BUNDLE_UNITS", "ORDERS_BUNDLE_BYTES", "ORDERS_BUNDLE_PER_HOUR", "ORDERS_OLDER_UNITS", "ORDERS_OLDER_COMMANDS", "ORDERS_OLDER_BYTES", "ORDERS_OLDER_PER_HOUR", "ORDERS_OLDER_MOST", "ORDERS_ONE_CLICK_LISTS"] },
      // Both buttons' requests, and the same requests made by the page's own forms without JavaScript, go through one way each
      // (lib/purchase-cards.ts, askBundle and askOlder): the link's limit and the request's call, then their units (C3-80).
      { file: "app/api/store/orders/older/route.ts", names: ["export const maxDuration = 30", "askOlder(store,"] },
      { file: "app/api/store/orders/bundle/route.ts", names: ["export const maxDuration = 30", "askBundle(store,"] },
      { file: "lib/purchase-cards.ts", names: ["withinStore(\"orders-older\"", "olderFor(store, token, older", "withinStore(\"orders-bundle\"", "bundleFor(store, token, reference, which)", "if (error instanceof OrdersBusy) return { ok: false, status: 429"] },
      { file: "app/[handle]/orders/page.tsx", names: ["await askBundle(store, token,", "await askOlder(store, token, asked)", "if (token && (bundleAsked || olderAsked))"] },
      // A certificate's PDF takes one before its record is read and the rest of CERTIFICATE_PDF_UNITS before it is drawn, on the public side; a sample
      // is kept by the CDN five minutes (C3, 4 November 2026; CERTIFICATE_PDF_READ in tests/plan-cost-registry.test.ts).
      { file: "app/[handle]/certificate/[id]/pdf/route.ts", names: ["takePublicRequest(store, \"public\", now, 1)", "takePublicRequest(store, \"public\", now, CERTIFICATE_PDF_UNITS - 1)", "public, max-age=0, s-maxage=300"] },
      { file: "lib/certificate-pdf.ts", names: ["CERTIFICATE_PDF_UNITS = 2", "CERTIFICATE_PDF_MAX_BYTES = 256_000"] },
      // The picture its shared link unfolds into is paid for the same way, CERTIFICATE_CARD_UNITS as many as the PDF and lighter than it
      // (153 KB, 0.59 s of CPU cold, measured; audit R41, item 3), so CERTIFICATE_PDF_READ prices it too (tests/certificate-card-standing.test.ts).
      { file: "app/[handle]/certificate/[id]/opengraph-image.tsx", names: ["takePublicRequest(store, \"public\", now, 1)", "takePublicRequest(store, \"public\", now, CERTIFICATE_CARD_UNITS - 1)"] },
      { file: "lib/certificate.ts", names: ["CERTIFICATE_CARD_UNITS = 2"] },
      // A payment request first written down as paid takes one more before the workflow that starts on it is checked (635 [GL3], 2 November 2026).
      { file: "lib/payment-flow-trigger.ts", names: ["PAID_TRIGGER_UNITS", "takePublicRequest(store, \"buyer\", Date.now(), PAID_TRIGGER_UNITS)"] },
      // An affiliate's own page and the store's map read in proportion to the store: counted first, paid before they read (4 November 2026).
      { file: "lib/public-read-rules.ts", names: ["AFFILIATE_PAGE_UNITS", "AFFILIATE_STRIPE_PAGES_PER_UNIT", "AFFILIATE_FIELDS_PER_UNIT", "AFFILIATE_ROWS_PER_UNIT", "PUBLIC_LISTINGS_PER_UNIT", "AFFILIATE_LOAD_BYTES_PER_UNIT", "AFFILIATE_CODE_FIELDS_PER_UNIT", "SITEMAP_POST_PAGES_PER_UNIT", "SITEMAP_LINES_PER_UNIT", "affiliatePageUnits", "affiliateLoadUnits", "sitemapUnits", "LIBRARY_WAITING_UNITS"] },
      { file: "app/library/page.tsx", names: ["takePublicRequest(store, \"buyer\", undefined, LIBRARY_WAITING_UNITS)"] },
      { file: "lib/affiliate-page-admission.ts", names: ["bookSize(store)", "codeOwnerCount(store)", "takePublicRequest(store, \"buyer\", now, affiliateLoadUnits(", "takePublicRequest(store, \"buyer\", now, units, { shared: true })", "isResting(store, now)", "claimRefresh(store)"] },
      { file: "lib/affiliate-book-snapshot.ts", names: ["BOOK_FRESH_SECONDS", "BOOK_KEEP_SECONDS", "BOOK_SNAPSHOT_MAX_BYTES", "BOOK_LOCK_SECONDS", "BOOK_READ_SECONDS", "AFFILIATE_PAGE_MAX_SECONDS"] },
      { file: "app/[handle]/affiliates/page.tsx", names: ["admitAffiliatePage(store, affiliate)"] },
      { file: "lib/store-sitemap.ts", names: ["sitemapSize(store)", "takePublicRequest(store, \"public\", now, sitemapUnits(size))"] },
      { file: "app/[handle]/store-sitemap/route.ts", names: ["paidStoreSitemap(store)"] },
      // The open cart counts what is left of each limited product in it, as a product's page does (513 [PF1], unit 3, 2 November 2026): one read each, at most MAX_CART.
      { file: "app/api/store/cart/route.ts", names: ["withinStore(\"cart-read\"", "stockLeft(store, p)"] },
      { file: "lib/stock.ts", names: ["MAX_CHECKS"] },
    ],
    basis: "An affiliate's lead for a confirmed sign-up (lib/affiliate-leads.ts, 18 October 2026) takes one of the window's requests before it is written, and is not credited past them; its few commands stay inside a later page's, held in tests/affiliate-leads.test.ts. An affiliate's own page (lib/affiliate-page-admission.ts) and the store's map (lib/store-sitemap.ts) count what they would read first, with a few commands, and take that many of the window's requests before reading it (lib/public-read-rules.ts; affiliatePageRead, affiliateLoadRead and sitemapRead held in tests/plan-cost-registry.test.ts), so neither reads past the window; the affiliate program's book is worked out for all its affiliates at most every BOOK_FRESH_SECONDS and kept that long (lib/affiliate-book-snapshot.ts), the load that works it out paying for it in full outside its connection's share of the day, every other load paying for its own part. Every request of the window is counted, pages and public routes together, and the store rests at REQUESTS_PER_VISIT for each visit of its figure and EXTRA_REQUESTS more: the visits line already prices three pages a visit (tests/traffic-cost.ts), so the extra ones are priced here at a later page each (a review ceiling no public route passes), and every one at its count. The open cart's count of its limited products (513 [PF1], unit 3, 2 November 2026) adds at most MAX_CART reads, and asks the creator's Stripe account, which costs us nothing but the wait, only about a hold that ran out, at most MAX_CHECKS times a product; each hold is settled once, by being marked sold or let go, so it is not asked about again.",
  },
  {
    id: "studio",
    feature: "The studio's own reads and writes: every page of it drawn (STUDIO_PAGE_UNITS each), every save and read, its refreshing; and the never-paused plan, cancel, delete and data-download requests (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "studio") + ESSENTIAL_PER_DAY * DAY_WINDOWS * request("heavy", 40, 200_000) + PAUSED_PER_DAY * DAY_WINDOWS * request("light", 8),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "studio"] },
      { file: "lib/studio-allowance-rules.ts", names: ["STUDIO_PAGE_UNITS", "ESSENTIAL_PER_DAY", "ESSENTIAL_NEEDS"] },
      { file: "lib/studio-route.ts", names: ["countStudio", "studio-essential"] },
      // An active store may clear its assistant notes repeatedly: settings admission takes one studio request first.
      { file: "app/api/store/assistant-memory/route.ts", names: ["guardStoreWrite", "forgetMemory"] },
      { file: "lib/assistant-memory-store.ts", names: ["MEMORY_FORGET_COMMANDS"] },
      // A deal entering a stage takes one more studio request before the workflow its stage starts is checked (17 October 2026).
      { file: "lib/deal-stage-trigger.ts", names: ["STAGE_TRIGGER_UNITS", "countStudio(store, null, STAGE_TRIGGER_UNITS)"] },
      // A store that kept tasks about people before their count has every task read once to make it, after tasksRecountUnits studio requests are taken (review of #1959, 4 November 2026).
      { file: "lib/crm.ts", names: ["TASKS_RECOUNT_UNITS", "tasksRecountUnits", "TASK_COUNT_FIELD"] },
      // The agenda of everyone's tasks reads every task: tasksRecountUnits(people) studio requests first, refused without reading (review of f6bd3d1f4, M1).
      { file: "app/api/store/person-tasks/route.ts", names: ["countStudio(store, null, units)", "TasksRecountRefused", "countStudio(store, null, tasksRecountUnits(people))", "taskPeople(store.statsId)"] },
      // Marktmorgen Path reading its store's money and counts again takes PATH_READ_UNITS studio requests first, at most once every PATH_MONEY_SECONDS (18 October 2026).
      { file: "lib/path.ts", names: ["PATH_READ_UNITS", "countStudio(store, null, units)"] },
      // The invoices of a store's own plan take one billing request of the day (the essential counter) before Stripe is asked, none without a plan subscription (601 [KB22] U5).
      { file: "lib/plan-invoices.ts", names: ["PLAN_INVOICES_PER_DAY", "PLAN_INVOICES_SHOWN", "takeEssentialBelow(store, PLAN_INVOICES_PER_DAY)", "await take()"] },
      { file: "lib/studio-route.ts", names: ["takeEssential", "takeEssentialBelow", 'essentialTakeBelow("studio-essential", store.sid || store.handle, Math.min(below, ESSENTIAL_PER_DAY), 86_400)'] },
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
      // A discount code scheduled ahead (511 [CK3]) takes SCHEDULE_UNITS more studio requests before Stripe is asked, one for each try the
      // five-minute job may make to switch it on (each one call to the creator's Stripe account, which bills none, and a few commands).
      { file: "app/api/store/discount/route.ts", names: ["countStudio(store, null, SCHEDULE_UNITS)"] },
      { file: "lib/discount-schedule-rules.ts", names: ["SCHEDULE_UNITS = ACTIVATION_TRIES", "MAX_SCHEDULED_CODES"] },
      { file: "app/api/cron/imports/route.ts", names: ["activateScheduledCodes("] },
      // The totals of every store take a page of each other store's studio, as the Terms say (C4-4, owner's decision of 4 November 2026, C4-18).
      { file: "app/studio/totals/page.tsx", names: ["countStudio(store, null, STUDIO_PAGE_UNITS)"] },
    ],
    basis: "Every studio request of the window at the studio shape; a page drawn takes STUDIO_PAGE_UNITS of them, more than a heavy read costs (held below). Past the figure the studio shows one page, drawn at most PAUSED_PER_DAY times a day; changing or canceling the plan, deleting the store and downloading its sales take a small daily figure instead. What a page reads of the store's numbers past that is the store's own readings (line store-readings), never more of these.",
  },
  {
    id: "store-readings",
    feature: "A store's readings of its own numbers (visits, sales, memberships), from its counts and its Stripe account, kept for the pages that show them (C4-4; owner's decision of 4 November 2026, inbox C4-18)",
    monthlyUsd: (tier) =>
      // The heavy readings (sales) at their shape, the rest at the dearest light one. A product update's search for its
      // buyers is counted in the studio's requests (lib/product-updates.ts, updateReadUnits), not here.
      DAY_WINDOWS * (HEAVY_READINGS_PER_DAY * readShapeCost(SALES_READ_SHAPE)
        + (STORE_READINGS_PER_DAY - HEAVY_READINGS_PER_DAY) * Math.max(readShapeCost(STATS_READ_SHAPE), readShapeCost(MEMBERS_READ_SHAPE)))
      + (STORE_ALLOWANCES[tier].studio / STUDIO_PAGE_UNITS) * readShapeCost(KEPT_READINGS_SHAPE)
      + READING_KINDS.length * READING_COPY_MAX_BYTES * DB_BYTE_MONTH * (READING_KEEP_SECONDS / (30 * 86_400))
      // A store from before lists: its one try a UTC day to be given one (lib/store-readings.ts, listForNaming), shared
      // by its sales readings and its calendar feed (one mark), at its worst every day (review of 2c1af02e0).
      + DAY_WINDOWS * readShapeCost(LIST_MADE_SHAPE),
    sources: [
      { file: "lib/store-reading-rules.ts", names: ["STORE_READINGS_PER_DAY", "HEAVY_READINGS_PER_DAY", "READING_FRESH_SECONDS"] },
      { file: "lib/store-readings.ts", names: ["READING_KEEP_SECONDS", "READING_COPY_MAX_BYTES", "takeStoreReading", "readingsLeft", "keptReading", "READING_KINDS", "listForNaming", "listTryKey"] },
      { file: "app/api/store/calendar/[token]/route.ts", names: ["listForNaming(store)"] },
      { file: "lib/read-ceilings.ts", names: ["LIST_MADE_SHAPE", "STORE_LOCK_TRIES"] },
      { file: "app/studio/page.tsx", names: ["keptStats(current, undefined, freshNumbers)", "keptSales(current, undefined, freshNumbers)", "readingsLeft(current)"] },
      { file: "app/studio/totals/page.tsx", names: ["keptNumbers(store)", "keptMembers(store)"] },
      { file: "lib/read-ceilings.ts", names: ["STATS_READ_SHAPE", "SALES_READ_SHAPE", "MEMBERS_READ_SHAPE", "STORE_READING_SHAPES", "KEPT_READINGS_SHAPE"] },
    ],
    basis: "Every reading of every UTC day of the window, each counted before it is read: HEAVY_READINGS_PER_DAY of the store's sales from Stripe and PayPal, the rest of STORE_READINGS_PER_DAY at the dearer of its visits and its memberships (STORE_READING_SHAPES); what a studio page reads of the kept readings (up to three, READING_COPY_MAX_BYTES each) and of the day's counts (two) for every page the studio figure allows; and the readings kept a day. The page itself is the studio's STUDIO_PAGE_UNITS, as the Terms say.",
  },
  {
    id: "calendar-feed",
    feature: "The private booking calendar a creator subscribes to (/api/store/calendar/<token>.ics): every answer from the last good copy, and the copy made again (C4-4, 4 November 2026)",
    monthlyUsd: () =>
      DAY_WINDOWS * (CALENDAR_BUILDS_PER_DAY + CALENDAR_CREDITS_PER_DAY) * readShapeCost(CALENDAR_BUILD_SHAPE)
      + (UTC_DAYS * 24 + 1) * CALENDAR_POLLS_PER_HOUR * readShapeCost(CALENDAR_POLL_SHAPE)
      + (UTC_DAYS * 24 + 1) * CALENDAR_REFUSED_PRICED_PER_HOUR * readShapeCost(CALENDAR_REFUSED_SHAPE)
      + CALENDAR_FILE_BYTES * DB_BYTE_MONTH * (CALENDAR_COPY_SECONDS / (30 * 86_400)),
    sources: [
      { file: "lib/calendar-sync.ts", names: ["bookedCalendarFeed", "CALENDAR_BUILDS_PER_DAY", "CALENDAR_CREDITS_PER_DAY", "CALENDAR_POLLS_PER_HOUR", "CALENDAR_REFRESH_SECONDS", "CALENDAR_COPY_SECONDS", "CALENDAR_MAX_EVENTS", "keptSlots", "takeCounted(", "withinPace("] },
      { file: "lib/call-records.ts", names: ["bookingsChangedKey", "bookingCreditsKey", "changedCommands(callsId"] },
      { file: "app/api/store/calendar/[token]/route.ts", names: ["bookedCalendarFeed(owner"] },
      { file: "lib/read-ceilings.ts", names: ["CALENDAR_POLL_SHAPE", "CALENDAR_BUILD_SHAPE", "CALENDAR_FILE_BYTES", "CALENDAR_REFUSED_SHAPE", "CALENDAR_REFUSED_PRICED_PER_HOUR"] },
      { file: "lib/calendar-limits.ts", names: ["CALENDAR_REFUSED_PER_HOUR", "CALENDAR_RETRIES_PER_DAY"] },
      { file: "lib/calendar-sync.ts", names: ["calendarAttemptsKey"] },
      { file: "lib/calendar-sync.ts", names: ["stopFeedToken"] },
      { file: "lib/store.ts", names: ["handleLeadsToStore", "storeHandleKey"] },
      { file: "app/api/store/stores/route.ts", names: ["forgetStoreCalendar(result.store.statsId)"] },
    ],
    basis: "A store's feed answers its calendar app from the last good copy of the file, at most CALENDAR_POLLS_PER_HOUR times in any sixty minutes (a sliding hour), counted before the copy is read (each a CALENDAR_POLL_SHAPE: the token, its settings, the pace and the copy, the copy sent); the file is made again only after a booking was made, moved or let go, or once the copy is CALENDAR_REFRESH_SECONDS old, at most CALENDAR_BUILDS_PER_DAY times a UTC day and once more for each booking made, moved or let go that day up to CALENDAR_CREDITS_PER_DAY (its credits, given where the change is marked), counted before it is made (each a CALENDAR_BUILD_SHAPE: the store, five Stripe pages, every call listing, each booking's moves and room, the copy kept); the copy itself kept CALENDAR_COPY_SECONDS at its largest. One feed a store (a new address replaces the old). Refused answers past the pace read only the token, its settings and the pace, and are counted (CALENDAR_REFUSED_SHAPE); every one the address may get in an hour before it stops, and the stop, are priced (CALENDAR_REFUSED_PRICED_PER_HOUR, lib/calendar-sync.ts CALENDAR_REFUSED_PER_HOUR). Past that the address is let go (its token deleted, the studio showing a new one and why), so what still asks it is an unknown address, answered from the token's one read like any address that leads nowhere. A store deleted or closed is refused with the copy's own read (its handle let go, or leading to another store: a tombstone in the copy's place), and a deleted store's feed is forgotten at its deletion (forgetStoreCalendar). None of it is the studio's requests: an app asking on its own must never spend a figure the creator sees. A making that failed (Stripe did not answer) is given back CALENDAR_RETRIES_PER_DAY a day (inbox C4-53), inside the same priced figure: every try of the day, made or failed, is one of CALENDAR_BUILDS_PER_DAY + CALENDAR_CREDITS_PER_DAY (calendarAttemptsKey), so no failure is unpriced.",
  },
  {
    id: "rest-api",
    feature: "The REST API: every request with one of the store's keys, a contact added or a product given as API_WRITE_UNITS of them (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "api"),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "API_WRITE_UNITS"] },
      { file: "lib/api-guard.ts", names: ["takeAllowance", "API_RATE"] },
      { file: "lib/api-write.ts", names: ["ADDS_PER_DAY", "GIVES_PER_DAY", "monthly_limit", "notDeleted", "grantUnlessErased"] },
      // A course's students, the affiliates and the bookings take further requests for what they read, before reading it (4 November 2026).
      { file: "lib/api-read-rules.ts", names: ["API_UNIT_COMMANDS", "API_UNIT_BYTES", "API_UNIT_SENT_BYTES", "API_UNIT_STRIPE_PAGES", "API_UNIT_ROUND_TRIPS", "studentsPageWork", "bookWork", "bookingsWork"] },
      { file: "lib/api-read.ts", names: ["studentPage", "chargeBook", "bookingsWork"] },
      { file: "lib/call-moves-read.ts", names: ["MOVES_PER_MGET", "MOVE_BYTES", "MOVE_KEY_BYTES", "moveReads"] },
      { file: "lib/mcp-tools.ts", names: ["chargeBook"] },
      { file: "app/api/v1/sales/route.ts", names: ["takeMoreApi(store, API_SALES_UNITS - 1)"] },
      { file: "lib/api-sales.ts", names: ["charge(apiReadUnits(listingsWork(listingsToRead(store, wanted))), API_SALES_UNITS)"] },
      { file: "lib/store-allowance-rules.ts", names: ["API_SALES_UNITS"] },
      { file: "lib/api-sales.ts", names: ["SALES_PAGE", "SALES_TITLE_IDS", "SALE_TEXT_LIMITS", "cutText"] },
    ],
    basis: "The plan's API requests at a light request each; a write takes API_WRITE_UNITS of them, more than a write costs, and a page of sales API_SALES_UNITS, more than API_SALES_READ, and the listings it reads for titles as further requests (held below). A reading that reads more than a page (a course's students, the affiliates, the bookings) takes further requests for its work before it reads, each priced above what it pays for at every size (apiReadCost, held below); refused, nothing more is read. The per-minute and daily limits only spread them. A product given reads who was deleted from the store before (one HMGET), once more in the script that writes it (its EVAL and one HMGET, the same HSETNX) and, when it emails, once more before sending (one HMGET): inside the units a write takes.",
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
      // The download takes one buyer read, then, before any note is read, the rest of what its most costs to read
      // (Codex J's review of #3031, M3; tests/sq1-lesson-notes-review.test.ts, tests/sq1-lesson-notes-second.test.ts), read
      // in base64 so no escaping can grow it (third review, M3; tests/sq1-lesson-notes-third.test.ts). A save, an emptied note and a course's notes
      // cleared are each one buyer action, under the same hourly limit. The course's page counts a student's notes
      // there, once the course is no longer open to them, with one buyer read (Claude 4's focal return, C4-2).
      { file: "app/api/store/course/note/route.ts", names: ["takeBuyerAction(store)", "takeBuyerRead(store)", "takeBuyerRead(store, units)", "NOTE_SAVES_PER_HOUR", "clearCourseNotes"] },
      { file: "lib/lesson-notes-rules.ts", names: ["MAX_NOTES_BYTES_PER_STUDENT", "NOTE_DOWNLOAD_BYTES_PER_UNIT", "NOTE_DOWNLOAD_READ_BYTES", "NOTE_DOWNLOAD_UNITS"] },
      { file: "lib/lesson-notes.ts", names: ["redisPipelineBase64([[\"HGETALL\", key]])", "NOTE_DOWNLOAD_UNITS - 1", "admit(noteReadUnits())"] },
      { file: "app/[handle]/course/[product]/page.tsx", names: ["notesDownloadAfterAccess(store.statsId ?? \"\", access, course.id, () => takeBuyerRead(store))"] },
      // Removing a like spends at most five commands after its buyer action is taken: EVAL, two ZSCOREs and two writes.
      { file: "lib/community-points.ts", names: ["REMOVE_POINT", "award"] },
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
    id: "stats-life-fill",
    feature: "A store's all-time numbers filled from its kept days, the first time anything reads its numbers (lib/stats.ts, readLife; reported by C4-4, 4 November 2026)",
    monthlyUsd: () => readShapeCost(LIFE_FILL_SHAPE),
    sources: [
      { file: "lib/stats.ts", names: ["KEPT_DAYS", "DAY_FIELDS_MAX", "lifeLockKey(statsId)", "filled"] },
      { file: "lib/read-ceilings.ts", names: ["LIFE_FILL_SHAPE"] },
    ],
    basis: "Once for each store, under a lock and marked filled so it never happens twice: two reads of each of KEPT_DAYS days, an HINCRBY for every field found (DAY_FIELDS_MAX a day at the most), its marks and the record read again (LIFE_FILL_SHAPE). Whichever reader comes first pays it (the studio's home page, the totals, the API, the weekly email), so it is priced here, once, in the first payment's worst case, like the closing.",
  },
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
    // A store in its trial, or whose plan ended until its closing day, keeps its calendar feed and its readings of
    // its numbers (C4-4, review of #2111): their own lines, at Store's figures, which are more than a trial's.
    + ["calendar-feed", "store-readings"].reduce((sum, id) => sum + creator(id), 0)
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

/**
 * The PayPal watch's two list reads (lib/paypal-sales.ts, watchPayPal, swept by lib/checkout-sweep.ts through
 * lib/paypal-delivery.ts, sweepPayPal; Claude 5 on #2909), in Redis commands, held to what the real sweep sends by
 * tests/paypal-watch-cost.test.ts:
 * - rangeReadsPerStoreRun: each sweep of a store with PayPal reads its pending payments and its orders due a refund
 *   look, one ZRANGEBYSCORE each, due orders or not (one only when the run's deadline passes during the first list);
 * - ordersPerRangeRead: each read asks for at most PAYPAL_WATCH_BATCH orders (lib/paypal-sales.ts), so one sweep looks
 *   at no more than that many of each list.
 * Why they are the five-minute job's, not a plan's: NOT_A_COST.PAYPAL_WATCH_BATCH.
 */
export const PAYPAL_WATCH_RANGES = { rangeReadsPerStoreRun: 2, ordersPerRangeRead: 25 } as const;

/** Per-use costs that no monthly figure bounds yet: not in worstCost, so nothing here is certified. */
export type OpenItem = { id: string; what: string; names?: string[] };
export const OPEN: OpenItem[] = [];

/** Exported limit or cost constants that are not a per-store monthly cost, and why. */
export const NOT_A_COST: Record<string, string> = {
  MEMORY_FORGET_COMMANDS: "lib/assistant-memory-store.ts forgetMemory is shared by three direct callers, not exclusively a company obligation. app/api/store/assistant-memory/route.ts POST forget belongs to an active store: guardStoreWrite(settings) reaches studioAccess/countStudio and takes one studio request before the operation; this caller and constant are cited by COST_LINES studio. app/api/store/stores/route.ts first attempts store-deletion cleanup after its essential delete admission. lib/store-forget-retry.ts later retries that deleted store as a company obligation, not as another active-store request. The constant bounds outer dispatches only: the measured lock path is eleven SET attempts plus three EVAL dispatches, deleting at most MAX_STORED_MEMORY_BYTES (55,264 bytes) without reading the note payload. Its 87-byte sample is a JSON-serialized stub reply, not RESP, wire or billed bytes. Lua-internal calls and expired data-room month cleanup are additional; sixteen is not a complete supplier invoice ceiling. The studio source citation records existing admission, not proof that its full command or function-time budget covers the lock wait. Complete active-store and company runtime, Lua and funding remain unknown, never zero; this shared exported constant is not a separate monthly allowance or margin approval.",
  FORGET_TRY_COMMANDS: "lib/store-forget-retry.ts forgetBoth adds assistant-note deletion to webhook and API-key cleanup. This is a company obligation after the original essential deletion request, not a per-plan allowance. The declared formula includes MEMORY_FORGET_COMMANDS but does not certify Lua-internal command costs, bytes, runtime or retention; its complete fixed-cost ceiling remains unknown and cannot approve a finite company base.",
  FORGET_TRIES: "lib/store-forget-retry.ts permits eight total attempts per deleted store, including the original deletion. Up to seven later company attempts can repeat assistant-note cleanup. This bounded work count is not a funded global case/retention or read-byte ceiling; costs remain unknown, never zero.",
  FORGET_PER_RUN: "lib/store-forget-retry.ts limits work to twenty-five stores per daily closing run, but first reads the entire active queue with HGETALL. The synthetic 2,000-row expired-deadline control produces a 166,893-byte JSON-serialized stub reply (not RESP, wire or billed bytes) and does no cleanup work. Twenty-five is not a queue-read byte bound. Complete queue, Lua, runtime, retention and company funding remain unknown; no finite fixed-cost or plan margin certification follows from this classification.",
  STATUS_VIEWS_PER_HOUR: "Requests in an hour, for the whole site, that read the runs on the public status page (247 [SP4] unit 2, lib/status-page.ts): not a plan's cost, since the page belongs to no store; a company cost under MR item 2, every kind of request priced at the rates of lib/spend-cost-table.ts and tests/traffic-cost.ts, held by tests/status-page.test.ts.",
  STATUS_COUNTS_PER_ADDRESS_PER_HOUR: "Times one address may make one server instance count a request on the public status page in an hour (247 [SP4] unit 2, lib/status-page.ts, lib/local-limit.ts): a pace that only refuses, held in memory at no cost, so one client cannot use up the hour's reads; the page's cost is the company's, priced in tests/status-page.test.ts.",
  STORE_FORGET_MONTH_READ_COMMANDS: "The unwired monthly owner-report reader in lib/store-forget-retry.ts sends exactly four Redis commands per invocation. It has no production caller today; before it is wired, its frequency and non-zero command cost must be included in the reviewed company fixed-cost ceiling. Unknown funding stays unknown, never zero, and this is not a store plan allowance.",
  BACKUP_RUNS_PER_MONTH: "The daily backup of the whole database is a company cost, never a plan's (273 [BK1], inbox C4-44): its worst month is priced from a review's caps by lib/backup-cost.ts and counted once among the LLC fixed costs (lib/llc-fixed-costs.ts, line backup, 100% Marktmorgen under FX275), whose reviewed ceiling stays unknown, never zero, while BACKUP_COST_UNKNOWNS are open.",
  BACKUP_DAYS_PER_MONTH: "The UTC days a billing month touches for the daily backup, a company cost (273 [BK1], inbox C4-49): its worst month is priced by lib/backup-cost.ts among the LLC fixed costs (lib/llc-fixed-costs.ts, line backup, 100% Marktmorgen under FX275), never a plan's allowance.",
  BACKUP_RUNS_PER_DAY: "The backup's runs a UTC day at the most, a run and one new try after a failure, counted before any cost (lib/backup-run.ts, 273 [BK1], inbox C4-49); priced in the company's backup line (lib/backup-cost.ts, lib/llc-fixed-costs.ts line backup), never a plan's allowance.",
  BACKUP_REPORT_READS_PER_DAY: "The daily report's two reads of the backup's outcome, counted in the backup's company cost line (lib/backup-cost.ts, lib/llc-fixed-costs.ts line backup), never a plan's allowance (273 [BK1], inbox C4-44).",
  HELD_RECHECKS_PER_DAY: "Company recovery work plus separate post_cancellation retention exposure, never a paid plan allowance: HELD_EXPOSURE in this registry and docs/funded-exposure-review.md count50 global daily rechecks, two actual bounded reads each, retained full stores/keys and aggregate counters. Actual case cap/rates remain unknown until reviewed; no zero subsidy.",
  PAGE_INCLUDED_BYTES: "What one studio request's own price already moves through the database and on to the browser (lib/sent-bytes.ts; UNIT_COST.studio prices fifty kilobytes): spent once a request, whatever its parts (IncludedBytes, made once by the page and handed to each reading and sending; C3-112 (2)): a part that fits in what is left counts nothing beyond the request that asked, and one that does not counts one studio request a megabyte (LEDGER_BYTES_PER_UNIT, STUDIO_UNIT_SENT_BYTES, AGENDA_UNIT_BYTES, held in tests/plan-cost-registry.test.ts). A threshold inside the studio line, not a figure of its own.",
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
  PICTURE_DOORS_PER_HOUR: "A pace on the studio's picture doors a store opens in an hour (lib/picture-door.ts, pictureDoorHour; rule 24 inventory A1), counted before the file store is asked or anything is signed: it only refuses, and each door it lets through has already taken a studio request (line studio). What a door writes is not priced by it: a picture never put on anything stays in the file store, at most PICTURE_DOOR_MAX fresh ones a store at a time, each at most MAX_IMAGE_BYTES (lib/product-image.ts), and is not deleted once its note is a day old. That retained storage and the file store's per-write charge have no line yet, so they are not certified, never zero.",
  CENTS_PER_MINUTE: "AI captions are bought at their own price, charged before the work (lib/auto-captions-rules.ts).",
  MAX_PAGES_PER_STORE: "Pages of Stripe Checkout Sessions (GET /checkout/sessions, up to 100 each) the five-minute job reads per store per run in each of its two walks of the last day (lib/checkout-sweep.ts, walkDay; audit A2, 9 November 2026): the completed checkouts on every store it sweeps, and the expired ones on a store with reminders or a list, never the open ones. So at most 2 x 3 = 6 list calls each time a store is swept; a run sweeps a store once, unless Redis's SCAN hands its key back on another page (#3064 makes that once a run too), so with one sweep a run 2 x 3 x 288 = 1,728 a UTC day, 55,296 a billing month of 32 UTC days; Stripe bills no API call, and each run stops at its deadline. Each walk keeps its place for the next run (nl:sweep:walk:, tests/store-data-registry.ts): one GET a walk and at most one SET or DEL, so at most 4 store commands each time a store is swept, with one sweep a run 1,152 a UTC day, 36,864 a billing month, and only 2 a sweep (the GETs) for a store whose day of checkouts fits in one run; each value at most 220 bytes, kept a day. Held by tests/checkout-sweep-complete.test.ts. Past 3 pages a run, a walk carries on next run instead of reading the same newest pages again, so every session of the day is read in turn; a walk that takes more than an hour to reach the end of the day is said in the log every run it goes on. A scheduled job, bounded by its schedule (a company fixed cost), not a plan's allowance; like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  HAND_OVER_BATCH: "PayPal orders still owed their hand-over that the five-minute job's sweep of a store tries again in one run (lib/paypal-delivery.ts, handOverAgain; #2909): one ZRANGEBYSCORE of the list a store with PayPal a run, then for each order tried at most four commands of its own (GET of the paid record, ZSCORE of the refund mark, at most two ZREM or ZADD of the list) besides the hand-over's own work, which is the order's (line orders): at most 1 + HAND_OVER_BATCH x 4 commands of its own a store a run, and at most HAND_OVER_BATCH hand-overs tried, each order at most once a run (PAYPAL_HAND_OVER_RETRY, held by tests/paypal-handover-cost.test.ts). A receipt the sender did not accept reruns its order's hand-over at most receiptTriesPerOrder times in its window, each try at most commandsPerReceiptTry commands (PAYPAL_RECEIPT_RETRY_COMMANDS an order), and at most one request a sender attempt through the one sender kept for it. A scheduled job, bounded by its schedule and the batch, a company fixed cost like MAX_PAGES_PER_STORE, not a plan's allowance; like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  STRIPE_LOOKUPS_PER_STORE: "Calls to the creator's Stripe account the five-minute job makes per store per run to tell whose a refunded charge is and to read a canceled member's address (lib/webhooks.ts, watchStore): a scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call, and a membership's charge (three calls) is taken from the same ten, so no run asks more than before.",
  DEMO_SESSIONS_PER_DAY: "Sessions the whole site may open in a day, the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_COMMANDS_PER_DAY: "Database commands the demo's accepted openings and actions together may send in a day (refusals are priced apart, DEMO_REFUSALS_PER_DAY), reserved at the worst before a session opens: the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_SESSIONS_PER_ADDRESS_PER_DAY: "Demo sessions one address or network may open in a day: a pace that only refuses, inside the day's caps of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_SESSION_WORST_COMMANDS: "The most commands one demo session can send, reserved whole when it opens: inside the day's commands of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSALS_PER_DAY: "Refused demo requests counted in a day, past which the door answers after its reads (one, or two for a made-up cookie) and writes nothing: priced at their worst in the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSALS_PER_ADDRESS_PER_DAY: "Refused demo requests one address or network may count in a day, each counted for the whole site only inside it, so one address cannot spend the day's DEMO_REFUSALS_PER_DAY: a pace that only refuses, inside the day's counted refusals of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSALS_PER_SESSION: "Refused actions one live demo session may count in its own record, whoever shares its address, past which its next actions are answered after one read and write nothing: priced with each day's openings in the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSAL_WORST_COMMANDS: "The commands one refused demo request sends at the most, priced with the refusals of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  PAYPAL_WATCH_BATCH: "PayPal orders the five-minute job's sweep of a store with PayPal reads from each of its two lists in one run (lib/paypal-sales.ts, watchPayPal; Claude 5 on #2909): one ZRANGEBYSCORE of the pending payments and one of the orders due a refund look, each with LIMIT 0 PAYPAL_WATCH_BATCH, so 2 commands a store a run, due orders or not, and each reply at most PAYPAL_WATCH_BATCH order ids (at most 36 characters each); a store is swept at most once a run (lib/checkout-sweep.ts walks the list of stores once, stops at its end or the run's deadline, and skips a store already swept that run when SCAN hands its key back on another page), so at most 2 x 288 runs a UTC day x 32 UTC days = 18,432 of these reads a store a billing month (PAYPAL_WATCH_RANGES, held by tests/paypal-watch-cost.test.ts). A scheduled job, bounded by its schedule and the batch, a company fixed cost like MAX_PAGES_PER_STORE, not a plan's allowance. Not stated here: the commands and PayPal calls of each order read (at most PAYPAL_WATCH_BATCH of each list a run), which are bounded in number by the batch but not yet counted command by command. Like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  LOST_DISPUTE_PAGES: "Pages of Stripe's closing events (GET /events, up to 100 each) read per store per run by each of the five five-minute jobs that take things back after a lost dispute (lib/refunds.ts, lostDisputesSince; lib/licence-keys.ts, lib/call-meetings.ts, lib/review-proof.ts, and the checkout sweep's gifts and pre-orders, lib/gifts.ts and lib/preorders.ts, asked only of a store that ever sold one), so at most 5 x LOST_DISPUTE_PAGES calls a store every five minutes, inside each run's deadline and with no other call per dispute: a scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call. Each lost dispute read becomes one row, handled once (its event id kept as read), with the store commands a refund row of the same job takes (SISMEMBER, SADD and EXPIRE of the read set, or for gifts and pre-orders the SISMEMBER and SADD of the read set, the GET of the payment's gift or pre-order and the read of that gift or pre-order and of what it gave (GET or HGET), each reply read in its exact shape so a row left unknown is read again next run, at most once a row a run, and the closing write: the key revoked, the meeting ended, the review marked, the gift or pre-order taken back as for a full refund; for a call refunded in full, the calendar feed's changed mark too: SET, INCRBY and EXPIRE, lib/call-records.ts, markBookingsChanged, at most REFUND_LOOKUPS a store a run), at most 100 x LOST_DISPUTE_PAGES rows a job a run, inside the same schedule and deadline as the refund rows. When there are more than a run may read, the job keeps its place in one key (GET at the start, then, once every row read is handled, one SMISMEMBER of the read set and SET or DEL: 3 commands a run, lib/refunds.ts, lostCursorKey and confirmLostRead; a run that could not handle every row writes nothing) and the next run reads on from there.",
  GIVEN_UP_LINES_PER_DAY: "A cap on the lines passed-over Stripe events leave for each endpoint of a store a day, at most MAX_ENDPOINTS endpoints a store a day, past which one summary line an endpoint counts the rest (lib/webhooks.ts, markGivenUp): no endpoint is called and no delivery taken; what the lines keep is bounded in tests/store-data-registry.ts (nl:hooks:d:, nl:hooks:evt:), and the job that writes them is the five-minute schedule's (a company fixed cost).",
  SKIPPED_LINES_PER_DAY: "A cap on the lines a store's log gets in a UTC day for messages not kept (too large to keep, or made with the month's webhook deliveries used), each reason on its own, past which one summary line an endpoint counts the rest (lib/webhooks.ts, skippedLines): no endpoint is called and no delivery taken; what the lines and the day's counts keep is bounded in tests/store-data-registry.ts (nl:hooks:d:, nl:hooks:wait:).",
  DISPUTE_LOOKUPS_PER_STORE: "The same job's separate budget of calls per store per run to tell whose a disputed payment is (lib/webhooks.ts, paymentMeta): inside the same schedule, the same ten as before, each call of a membership's lookup counted.",
  EMAIL_CODE_TRIES: "Wrong six-digit codes one sign-in request may try before its code stops working (lib/auth.ts, takeSignInCode; 652 [WG12]): each try is first the machine's count (SET NX and INCR, codeRateAnswer), then one HMGET, then one pipeline of SET NX and INCR for the address's hour, SET NX and INCR for its day, HINCRBY, TTL and GET, and on the right code the link's GETDEL, a GET of the newest-code mark (read after the spend, Codex CX1 on #2736) and a DEL; no email, no supplier call. A company cost (the account's sign-in), bounded per request by this and per address and per machine by the limits below.",
  EMAIL_CODE_TRIES_PER_ADDRESS_HOUR: "Code tries one address may take in the hour, all its requests together (652 [WG12], Claude 4): the bound on the commands above for one address, past which a try is refused after its count; the requests themselves are bounded by the sign-in limits (RATE_LIMIT, ADDRESS_LIMIT).",
  EMAIL_CODE_TRIES_PER_ADDRESS_DAY: "Code tries one address may take in a day from its first, all its requests together (Claude 3 on #2736): past them only the link opens, so the guesses against one address stay at this many a day, whatever the hourly limit renews.",
  EMAIL_CODE_TRIES_PER_IP_HOUR: "Code tries one machine may take in the hour (Claude 3 on #2736), counted before any record is read: the bound on the reads a machine can buy with made-up request ids, two commands each past it.",
  DISPUTE_READS_PER_READING: "Questions about a dispute (GET /disputes?charge=) one reading of a store's booked calls may ask Stripe, only for a charge Stripe marks as disputed (lib/calls.ts, callOrLost; lib/refunds.ts, keptUnlessLost); one for a booking read alone (paidCall). Past it, or when Stripe cannot be asked, the booking keeps its time. No store command and no other call; Stripe bills no API call: bounded by the readings the store's own pages and jobs already make, whose costs are their own lines.",
  TAX_OBSERVATION_LIMITS: "Inactive diagnostic processing bounds: CURRENT_TAX_OBSERVATION_POLICY is null, so no production journal IO is enabled. Activation requires explicit scope, absolute retention, atomic data-room reservation and full-lifetime paid storage/work cost evidence; these limits are not a zero cost or a funded allowance.",
  QUIET_PER_HOUR: "Sale notifications to the creator's phone: one per counted order at most, inside the order's compute.",
  VERCEL_CPU_MICRO_USD_PER_HOUR: "A rate, not a cap.",
  ASKS_PER_TEN_MINUTES: "A burst limit under ANSWERS_MONTHLY (line ai).",
  STORE_ASKS_PER_MINUTE: "A burst limit under ANSWERS_MONTHLY (line ai).",
  CALENDAR_ADDS_PER_TEN_MINUTES: "A burst limit per store on calendar adds, each one of the store's studio requests (line studio) that reads one remote calendar (R27): it only refuses, before the read.",
  CALENDAR_ADDS_PER_CONNECTION_TEN_MINUTES: "The same per connection, whatever store it is signed in to (R27): it only refuses, before the read.",
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
  GIFT_REFUND_PAGES_PER_STORE: "Pages of the creator's refunds (GET /refunds, up to 100 each, newest first) the checkout sweep reads per store per run for gifts (lib/gifts.ts, revokeRefundedGifts; CX-123 rule 24, r24 money inventory item 1), asked only of a store that ever sold one, each page from the last one's final row (starting_after) until has_more is false: at most GIFT_REFUND_PAGES_PER_STORE calls a store every five minutes for gifts, and at most GIFT_REFUND_PAGES_PER_STORE + PREORDER_REFUND_PAGES_PER_STORE for the two together, inside each run's deadline; a run that stops with pages left keeps the anchor and goes on next run from where it stopped (the pass, nl:gift:<store>:refunds:pass, a JSON of under 300 bytes kept a week, in the store's data family and erased with it): one more GET in the run's first read (with the GETs of the sold mark and of the anchor), one SET with EX of the pass for each page read whole with more after it (at most GIFT_REFUND_PAGES_PER_STORE a run), and at the end of a pass one SET of the anchor with one DEL of the pass instead of the anchor's SET alone; a run that resumes a pass reads the newest page first, inside the same GIFT_REFUND_PAGES_PER_STORE pages. Each refund read is one row handled as before, with the store commands a refund row of the same job takes (the SISMEMBER of the read set and the GET of the payment's gift, then for a full refund of one sold here the reads of that gift and of what it gave, the course removal, the writes that take it back and the mark of the row as read, exactly as before), each reply read in its exact shape, at most 100 x GIFT_REFUND_PAGES_PER_STORE rows a run instead of 100. A scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call.",
  PREORDER_REFUND_PAGES_PER_STORE: "Pages of the creator's refunds (GET /refunds, up to 100 each, newest first) the checkout sweep reads per store per run for pre-orders (lib/preorders.ts, revokeRefundedPreorders; CX-123 rule 24, r24 money inventory item 1), asked only of a store that ever sold one, each page from the last one's final row (starting_after) until has_more is false: at most PREORDER_REFUND_PAGES_PER_STORE calls a store every five minutes for pre-orders, and at most GIFT_REFUND_PAGES_PER_STORE + PREORDER_REFUND_PAGES_PER_STORE for the two together, inside each run's deadline; a run that stops with pages left keeps the anchor and goes on next run from where it stopped (the pass, nl:pre:<store>:refunds:pass, a JSON of under 300 bytes kept a week, in the store's data family and erased with it): one more GET in the run's first read (with the GETs of the sold mark and of the anchor), one SET with EX of the pass for each page read whole with more after it (at most PREORDER_REFUND_PAGES_PER_STORE a run), and at the end of a pass one SET of the anchor with one DEL of the pass instead of the anchor's SET alone; a run that resumes a pass reads the newest page first, inside the same PREORDER_REFUND_PAGES_PER_STORE pages. Each refund read is one row handled as before, with the store commands a refund row of the same job takes (the SISMEMBER of the read set and the GET of the payment's pre-order, then for a full refund of one sold here the reads of that pre-order and of what it gave, the course removal, the writes that take it back and the mark of the row as read, exactly as before), each reply read in its exact shape, at most 100 x PREORDER_REFUND_PAGES_PER_STORE rows a run instead of 100. A scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call.",
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
  join: ACCOUNT, passkey: ACCOUNT, "google-signin": ACCOUNT, "google-signin-back": ACCOUNT, "passkey-change": ACCOUNT, "passkey-remove-locked": ACCOUNT, "move-ask": ACCOUNT, "two-step": ACCOUNT, "two-step-backup": ACCOUNT, "two-step-change": ACCOUNT,
  "two-step-rescue": ACCOUNT, "recovery-address": ACCOUNT, "recovery-address-change": ACCOUNT, "lost-email": ACCOUNT, "lost-email-ip": ACCOUNT,
  "discord-return": ACCOUNT, "metaads-return": ACCOUNT, "meet-return": ACCOUNT, report: guard("Takedown reports, per connection: a company cost."),
  "mail-ses": guard("The email provider's own notices: a company cost."), "mail-inbound": guard("The email provider's inbound notices, per connection: a company cost; what is sent on to a creator is one of their store's emails (lib/inbound-mail.ts)."),
  "mail-clicked": guard("A click beacon from a store page opened from an email link, which the page itself counts: a few commands and no work, per connection."),
  "stream-hook": guard("The video service's own notices: a company cost."), "zoom-notice": guard("Zoom's own notices: a company cost."),
  "plan-refund": guard("The plan refund route (app/api/billing/refund, 305 [SY1]): at most PER_DAY (10) a store a day, each a bounded Stripe reading (MAX_CALLS) and one write; the money is the reviewed refund exposure (docs/funded-exposure-review.md), a company cost."),
  "plan-withdraw": guard("The plan withdrawal route (app/api/billing/withdraw, 588 [KB9] unit 3): at most PER_DAY (10) a store a day, each a bounded Stripe reading (MAX_CALLS) and, once per withdrawal, the plan refund flow; the money is the reviewed refund exposure under the money-back guarantee (docs/funded-exposure-review.md), a company cost."),
  "plan-refund-review": guard("The plan refund's review page (app/studio/refund, 305 [SY1]): drawn at most SHOWN_PER_DAY (20) a store a day, each a bounded Stripe reading (MAX_CALLS) and one short key: a company cost."),
  "metaads-deauth": guard("Meta's own notices: a company cost."), "outreach-stop": guard("A recipient's stop link: a company cost."),
  // Public requests: counted in the store's window as well (lib/metered-limits.ts, withinStore).
  "ads-event": PUBLIC, "aff-join": PUBLIC, "aff-open": PUBLIC, "book-move": PUBLIC, "cart-read": PUBLIC, "come-back": PUBLIC, "course-start": PUBLIC,
  "discord-join": PUBLIC, download: PUBLIC, "orders-bundle": PUBLIC, "orders-older": PUBLIC, "form-ip": PUBLIC, heard: PUBLIC, "join-ip": PUBLIC, "manage-card": PUBLIC, "manage-card-back": PUBLIC,
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
  "lesson-comment": BURST("buyer-actions"), "lesson-comment-day": BURST("buyer-actions"), "task-hand-in": BURST("buyer-actions"), "lesson-note": BURST("buyer-actions"), "task-upload": BURST("buyer-actions"),
  // Per store, under a figure of the window.
  "api-add": BURST("rest-api"), "api-give": BURST("rest-api"),
  "picture-door": BURST("studio"),
  "inbox-new": BURST("inbox"), "chat-send": BURST("inbox"), "chat-start": BURST("inbox"),
  // Calls to other services: counted in the store's window as well (lib/metered-limits.ts, withinService).
  "meet-host": SERVICE, "meet-manage": SERVICE, "meet-start": SERVICE, "metaads-start": SERVICE, "discord-connect": SERVICE, esync: SERVICE,
  "paypal-connect": SERVICE, "paypal-pay": SERVICE, "paypal-sell-connect": SERVICE, "aff-kit": SERVICE, "aff-payto": SERVICE, "outreach-find": SERVICE,
  "person-find": SERVICE, "vault-open": SERVICE, "vault-sign": SERVICE, "stream-door": SERVICE, "stream-captions": SERVICE, "mail-picture": SERVICE,
  "host-calendar": SERVICE, "outreach-find-day": BURST("integrations"),
  // Calendar adds (R27): each reads one remote calendar inside one of the store's studio requests.
  "calendar-add": BURST("studio"), "calendar-add-ip": BURST("studio"),
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
  // The acknowledgement of a buyer's withdrawal (EU art. 11a, 588 [KB9]): the store's transactional email, tried at most WITHDRAWAL_ACK_SENDS (3) times per order.
  "lib/withdrawal.ts": ["store"],
  // The receipt of a creator's withdrawal from their plan (EU art. 11a, 588 [KB9] unit 3), tried at most PLAN_WITHDRAW_ACK_SENDS (3) times, and a note to support tried at most PLAN_WITHDRAW_SUPPORT_TRIES (3) times, each counted before it is made: the company's.
  "lib/plan-withdrawal.ts": COMPANY,
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
  // Active shipment delivery uses sendQueuedShipmentMail in lib/email.ts.
  // The never-activated deployment retains its original one-shot ORDER sender.
  "lib/paypal-sales.ts": ORDER, "lib/preorders.ts": ORDER, "lib/shipments.ts": ORDER,
  "lib/purchase-email.ts": ["order", "store"], "lib/calls.ts": ["order", "store"], "lib/licence-keys.ts": ["order", "store"],
  "lib/affiliate-hub.ts": STORE, "lib/affiliate-payday.ts": STORE, "lib/affiliates.ts": STORE, "lib/assignment-notify.ts": STORE,
  "lib/buyer-library.ts": STORE, "lib/erasure-request.ts": STORE, "lib/buyer-orders.ts": STORE, "lib/checkout-recovery.ts": STORE, "lib/checkout-trouble.ts": STORE,
  "lib/community-access.ts": STORE, "lib/community-event-mail.ts": STORE, "lib/inbox.ts": STORE, "lib/learn.ts": STORE, "lib/letter-access.ts": STORE,
  "lib/lesson-comment-notify.ts": STORE, "lib/member-nudge.ts": STORE, "lib/membership-manage.ts": STORE, "lib/membership-pause.ts": STORE,
  "lib/payment-recovery.ts": STORE, "lib/podcast-access.ts": STORE, "lib/quiet-sales.ts": STORE, "lib/store-contact.ts": STORE,
  "lib/store-join.ts": STORE, "lib/team.ts": STORE, "lib/api-key-pause.ts": STORE, "lib/tier-switch.ts": STORE, "lib/waitlist.ts": STORE,
  "lib/welcome-offer-send.ts": STORE, "lib/winback-send.ts": STORE, "lib/yearly-ask.ts": STORE, "lib/yearly-switch.ts": STORE,
  // A payment request and its reminders are the store's own emails; its receipt is its order's (18 October 2026).
  "lib/payment-requests.ts": STORE, "lib/payment-request-store.ts": ORDER,
  // A proposal or agreement to sign, its new versions and its signed copies are the store's own emails (18 October 2026).
  "lib/agreements.ts": STORE,
};

/**
 * The most one page of sales weighs as JSON (lib/api-sales.ts), derived from the cuts the code makes: every text
 * is cut to its limit with control characters and lone surrogates dropped, so each unit left is at most
 * SALES_TEXT_BYTES bytes (a CJK character is three; a quote or a backslash, escaped, two). A sale holds its
 * checkout id, its product (an id and a title as the checkout writes it), its option, a bundle of
 * MAX_BUNDLE_ITEMS products, BUMP_KEYS.length checked boxes each with a bundle of its own, the first of them twice
 * (order_bump and order_bumps), the buyer's address and name, four utm tags and a site, two times; every listed product has
 * a catalog title (MAX_TITLE_LENGTH). SALES_KEY_BYTES is each object's keys and punctuation, with the kind, the
 * numbers, the time and the flags: tests/api-sales.test.ts holds a page built at these limits under the figure.
 */
const SALES_TEXT_BYTES = 3;
const SALES_KEY_BYTES = { sale: 600, entry: 32, bump: 50, page: 300 };
/** A time as the answer writes it ("2026-09-20T09:41:10.000Z"): opened_at and paid_at. */
const SALES_TIME_BYTES = 24;
const SALES_ENTRY_BYTES = SALES_KEY_BYTES.entry + SALES_SAFE_ID_LENGTH + SALES_LISTING_TITLE * SALES_TEXT_BYTES;
const SALES_BUMP_BYTES = SALES_KEY_BYTES.bump + SALES_ENTRY_BYTES + MAX_BUNDLE_ITEMS * SALES_ENTRY_BYTES;
export const API_SALE_BYTES = SALES_KEY_BYTES.sale + SALES_ID_LENGTH
  + SALES_SAFE_ID_LENGTH + SALE_TEXT_LIMITS.title * SALES_TEXT_BYTES + SALES_SAFE_ID_LENGTH
  + MAX_BUNDLE_ITEMS * SALES_ENTRY_BYTES + (BUMP_KEYS.length + 1) * SALES_BUMP_BYTES
  + (SALE_TEXT_LIMITS.email + SALE_TEXT_LIMITS.name + 4 * SALE_TEXT_LIMITS.utm + SALE_TEXT_LIMITS.site) * SALES_TEXT_BYTES
  + 2 * SALES_TIME_BYTES;
export const API_SALES_ANSWER_BYTES = SALES_KEY_BYTES.page + SALES_ID_LENGTH + SALES_PAGE * (API_SALE_BYTES + 1);
/**
 * One page of sales read through the API (GET /api/v1/sales, lib/api-sales.ts), at the most: Stripe waited on for
 * its whole ceiling (STRIPE_TIMEOUT_MS) on top of the request's own light seconds, at 2 GB; a CPU second through up
 * to SALES_PAGE expanded checkouts and the answer; the key, the store and the figure taken twice, and one read of up
 * to SALES_TITLE_IDS listings at 16 KB each; and an answer of up to API_SALES_ANSWER_BYTES on to the browser. It is
 * taken as API_SALES_UNITS API requests, which cost at least this with room (tests/plan-cost-registry.test.ts), so
 * it stays inside the plan's rest-api figure.
 */
export const API_SALES_READ = CALL + 1 * CPU_SECOND + (STRIPE_TIMEOUT_MS / 1000 + SHAPES.light.seconds) * MEMORY_SECOND
  + (20 + 2 * TAKE_COMMANDS + 1) * COMMAND + (20_000 + SALES_TITLE_IDS * 16_384) * DB_BYTE + API_SALES_ANSWER_BYTES * ORIGIN_PER_BYTE;

/** Additional Path growth reading: at most eight 256 KB products, three 80 KB campaigns, three bounded reviews and their indexes. Fifty commands and 3 MB include admission overhead; reserved separately before reading. No provider call. */
export const PATH_GROWTH_READ = request("write", 50, 3_000_000);

/**
 * One reading of a store's own plan invoices (601 [KB22] U5, lib/plan-invoices.ts), past the page's own
 * STUDIO_PAGE_UNITS: one GET of Stripe's invoice list waited on for its whole ceiling (STRIPE_TIMEOUT_MS) at 2 GB,
 * a CPU second and four megabytes of reading (PLAN_INVOICES_SHOWN invoices with their lines; the body is not capped
 * in bytes, but its download and parse run inside the same STRIPE_TIMEOUT_MS, lib/billing.ts onPlatform), and 64 KB
 * more sent on to the browser. Taken as one of the store's ESSENTIAL_PER_DAY requests of the day, only while fewer
 * than PLAN_INVOICES_PER_DAY were taken, before Stripe is asked (the counter countStudio keeps for "billing"), each priced in the studio line as a
 * heavy request and in platform-subscription-search as two Stripe GETs; tests/plan-cost-registry.test.ts holds this
 * under that, with room, so it adds nothing to either line. The wait is priced at the dearer of the model's
 * memory second and PLATFORM_SUBSCRIPTION_SEARCH's highest regional
 * rate; Stripe's tariff for the GET stays unknown, as there: not certified zero.
 */
export const PLAN_INVOICES_READ = CALL + 1 * CPU_SECOND + Math.max((STRIPE_TIMEOUT_MS / 1000) * MEMORY_SECOND, PLATFORM_SUBSCRIPTION_SEARCH.memoryUsdPerGet) + perMegabyte(4_000_000) + 65_536 * ORIGIN_PER_BYTE;
