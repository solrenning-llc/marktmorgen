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
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { ESSENTIAL_PER_DAY, STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { MAX_BENEFITS_KEPT, MAX_BENEFIT_TEXT } from "@/lib/tier-benefit-rules";
import { EXTRA_REQUESTS, REQUESTS_PER_VISIT, SHARE_COMMANDS_PER_REQUEST, TRIAL_EXTRA_REQUESTS, TRIAL_VISITS } from "@/lib/traffic-rules";
import { TRIAL_ORDERS } from "@/lib/order-rules";
import { TRIAL_MONTHLY_EMAILS } from "@/lib/plan";
import { TRIAL_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { TRIAL_DAILY_RUNS } from "@/lib/flow-limits";
import { PAID_STORES_PER_FREE_STORE } from "@/lib/free-pool-rules";
import { CERTIFICATE_PDF_MAX_BYTES } from "@/lib/certificate-pdf";
import { RECEIPT_BATCH_SHAPE } from "@/lib/receipt-batch";
import { monthlyEmails, type Tier } from "@/lib/plan";
import { FREE_PAUSE_ABOVE_BYTES } from "@/lib/delivery";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { TOP_HEIGHT, viewingBytes } from "@/lib/stream-rules";
import { VISITS_INCLUDED } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { AUTOMATIC_AI_STORE_MICRO_USD } from "@/lib/ai-spend-policy";
import { uploadWorstCostMicroUsd } from "@/lib/upload-budget-policy";
import { DAILY_RUNS_BY_TIER, SES_WAKE_JOB_COMMANDS, SES_WAKE_JOBS_PER_DAY, WORST_COMMANDS_PER_RUN } from "@/lib/flow-limits";
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
import { MAX_ANSWER_TEXT, MAX_FEEDBACK, MAX_TASK_FILE_BYTES, TASK_ROOM_BYTES, TRIAL_TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { COMMUNITY_PICTURES, PICTURE_BYTES, TRIAL_COMMUNITY_PICTURES } from "@/lib/community-picture-rules";
import { CLOSING_DAYS, DEL_BATCH, ENDED_LIST_DOWNLOADS, ENDED_STORE_EXPORTS, FOLLOW_BATCH, RENEWALS_AT_ONCE, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { MAX_CRM_FIELDS } from "@/lib/crm-rules";
import { PERSON_ARG_BYTES } from "@/lib/crm";
import { BUYER_SEND_DAYS, EMAILS_PER_BUYER_PER_ENDING, STRIPE_CALLS_PER_MEMBER, buyerNoticeCap } from "@/lib/closing-buyers-rules";
import { PAYPAL_PAGE, buyerPagesCap } from "@/lib/closing-buyers";
import { MAX_NAME_LENGTH as STORE_NAME_MOST, MAX_STORE_BYTES } from "@/lib/store";
import { NOTE_RUN_BYTES, NOTE_RUN_COMMANDS } from "@/lib/podcast-access";
import { BODIES_PER_READ } from "@/lib/course";
import { COURSE_BYTES, REFUND_MARK_BYTES, REFUND_MARKS_PER_READ, bookWork } from "@/lib/api-read-rules";
import { BOOK_STRIPE_PAGES } from "@/lib/affiliates";
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
import { AFFILIATE_ROW_CAP, PRODUCT_CARD_CPU_SECONDS, PRODUCT_CARD_HELD_SECONDS, PRODUCT_CARD_MAX_BYTES, type AffiliateLoadSize, type AffiliatePageSize, type SitemapSize } from "@/lib/public-read-rules";
import { BOOK_SNAPSHOT_MAX_BYTES } from "@/lib/affiliate-book-snapshot";
import { SEARCH_PAGE } from "@/lib/community-search";
import { DEVICE_SENT_BYTES, MAX_MEMBER_DEVICES } from "@/lib/community-push";
import { MAX_MENTIONS } from "@/lib/community-mentions";
import { MAX_CHAT_KEPT } from "@/lib/community-chat-rules";
import { SEARCH_MESSAGES } from "@/lib/community-dm";
import { MAX_FORMS } from "@/lib/forms";
import { EXPORT_COMMANDS, EXPORT_PAGE_SECONDS, EXPORT_STRIPE_PAGES } from "@/lib/store-export";
import { PATH_REFUND_PAGES, PATH_SALE_PAGES } from "@/lib/path-facts";
import { SNS_RECEIPT_COMMANDS_MOST, SNS_RECEIPT_VALUE_BYTES_MOST } from "@/lib/sns-receipt-rules";
import { ALL_TIME_PAGES } from "@/lib/stats";
import { BOOK_KEPT_SLICE, MAX_PAID_BYTES, PAYPAL_REFUNDS_READ } from "@/lib/paypal-sales";
import { AGENDA_MAX_ROWS, AGENDA_ROW_SENT_BYTES, AGENDA_TASKS_BYTES } from "@/lib/person-agenda";
import { LIFE_WRITE_MAX } from "@/lib/stats";
import { MARK, cappedByteMonths, closingBytes, followedBytes, reserveBytes, reservePeakBytes } from "./store-data-registry";
import {
  PROVIDER_CHARGES_BPS, UPSTASH_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";
import { CDN_PER_REQUEST, PAGES_PER_VISIT, laterPageCost, visitCost } from "./traffic-cost";
import { ASSISTANT_IN_PROGRESS_WAIT_MS, ASSISTANT_START_CUTOFF_MS, ASSISTANT_START_LIST_PAGES, ASSISTANT_START_STRIPE_CALLS, assistantMonthWorst } from "@/lib/store-assistant-rules";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { NEXT_OFFER_CHOICES, NEXT_OFFER_COMMANDS, NEXT_OFFER_PRODUCTS } from "@/lib/next-offer-rules";
import { WINBACK_OPEN_STRIPE_CALLS } from "@/lib/winback";
import { MAX_SHELF } from "@/lib/course-shelf-rules";
import { ASSIST_REMIND_COMMANDS, ASSIST_REMIND_PRODUCTS } from "@/lib/assistant-reminder-rules";
import { BOOK_KEPT_REFUND_BYTES, DONE_SET_BYTES, LISTING_BYTES, TASK_BYTES, type ReadWork } from "@/lib/api-read-rules";
import { DOWNLOAD_LOOKUP_COMMANDS, DOWNLOAD_LOOKUP_MS, ORDERS_BUNDLE_BYTES, ORDERS_OLDER_BYTES, ORDERS_OLDER_COMMANDS, ORDERS_OPEN_COMMANDS, ORDERS_OPEN_SECONDS, ORDERS_PAGE_BYTES } from "@/lib/buyer-orders-rules";
import { MOVES_PER_MGET, MOVE_BYTES, MOVE_KEY_BYTES } from "@/lib/call-moves-read";
import { MAX_PER_PERSON as AGREEMENTS_PER_PERSON, MAX_BODY as AGREEMENT_BODY, MAX_LINES as AGREEMENT_LINES, MAX_LINE_TEXT as AGREEMENT_LINE_TEXT, MAX_NAME as AGREEMENT_NAME, MAX_TITLE as AGREEMENT_TITLE } from "@/lib/agreement-rules";
import { MAX_EMAIL_LENGTH } from "@/lib/auth";
import { MAX_PER_PERSON as REQUESTS_PER_PERSON } from "@/lib/payment-request-rules";
import { WAITING_SHOWN } from "@/lib/buyer-waiting";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";
import { MAX_COMPANIES_BYTES, MAX_COMPANY_RECORD_BYTES, STUDIO_UNIT_SENT_BYTES } from "@/lib/crm-companies-rules";
import { type ReadShape, CALENDAR_BUILD_SHAPE, CALENDAR_FILE_BYTES, CALENDAR_POLL_SHAPE, CALENDAR_REFUSED_PRICED_PER_HOUR, CALENDAR_REFUSED_SHAPE, KEPT_READINGS_SHAPE, LIFE_FILL_SHAPE, LIST_MADE_SHAPE, MEMBERS_READ_SHAPE, SALES_READ_SHAPE, STATS_READ_SHAPE, STORE_LOCK_TRIES } from "@/lib/read-ceilings";
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
/** Redis commands one callback attempt is billed at its most: the rate guard's two, the SNS receipt's and the report's first outcome. */
export const MAIL_CALLBACK_COMMANDS_PER_ATTEMPT = 2 + SNS_RECEIPT_COMMANDS_MOST + MAIL_REPORT_COST_COMPONENTS.firstOutcomeCommands;
/** The SNS receipt's key and value fit in one of the 256-byte transport records counted in mailReportCallbackCost (key prefix, an 80-character id, the value). */
export const SNS_RECEIPT_RECORD_BYTES_MOST = "nl:sns:seen:".length + 80 + SNS_RECEIPT_VALUE_BYTES_MOST;
/** One published delivery notice, without supplier free-tier credit:
 * SNS $0.50/million publishes + $0.60/million HTTPS deliveries, each 64 KiB
 * chunk charged. Read 2026-11-04: aws.amazon.com/sns/faqs/ and /sns/pricing/.
 * The caller MUST supply its regional data-out ceiling; null is unknown.
 * This is an explicit sizing calculation, never a current account review.
 * A retry is charged the full route envelope even when deduplication wins.
 * Thirty CPU seconds and 2 GB held for all 30 seconds use maxDuration, not
 * an observed fast callback. Redis commands = SET/INCR rate guard, the SNS
 * receipt at its most (lib/sns-receipt.ts, SNS_RECEIPT_COMMANDS_MOST: claim,
 * read-back, owner-bound take-over and done or let-go scripts with their inner
 * commands, eight since #2612; one before), and the report's EVAL plus its
 * seven internal commands: MAIL_CALLBACK_COMMANDS_PER_ATTEMPT. Storage
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
  const redisCommands = invocations * MAIL_CALLBACK_COMMANDS_PER_ATTEMPT;
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
  const redisPerAttempt = MAIL_CALLBACK_COMMANDS_PER_ATTEMPT * COMMAND + 4096 * DB_BYTE + 512 / 30 * DB_BYTE_MONTH;
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
 * handed back first (releaseCartStockHolds, with its one hand-back taken by a SET NX in the same round trip as the HDELs since
 * Codex X5's and Codex L's MÉDIO on #4409, one command more). Measured in tests/cart-stock.test.ts and held to a declared share of ORDER_COMPUTE,
 * so the rest of it is left for the order's pages and jobs. Stripe is never asked while a lock is held; the holds that ran out
 * are asked about after the locks are let go, every product at once, at most MAX_CHECKS times each at CHECK_MS (lib/stock.ts),
 * so the waiting is at most CART_STOCK_STRIPE_WAIT_MS besides the locks' own short waits.
 */
export const CART_STOCK_COMMANDS_MOST = 71;
export const CART_STOCK_SHARE_OF_ORDER_COMPUTE = 0.5;
export const CART_STOCK_STRIPE_WAIT_MS = 5 * 2_000;
/**
 * A limited product's units counted as sold (lib/stock.ts, STOCK_SELL; Claude 3's performance audit, 13 November 2026, and
 * Claude 7's MÉDIO on #4472, 14 and 15 November 2026): one script that lets go of the checkouts' own fields (1 to
 * MAX_CHECKS of them, one HDEL; Claude 5's MÉDIO on #4472, 16 November 2026) and raises the product's sold count by the
 * number let go, billed as the EVAL and its two calls (HDEL, HINCRBY) whatever the number of checkouts.
 */
export const STOCK_SELL_COMMANDS = 3;
/**
 * What a page's count of one limited product writes at the most when it settles holds that ran out (lib/stock.ts,
 * countStock; Claude 5's MÉDIO on #4472, 16 November 2026): one HDEL of every hold let go (Stripe says expired, or a
 * cart's provisional hold that lapsed) and one STOCK_SELL of every hold Stripe says is paid, at most MAX_CHECKS asked,
 * whatever their number. Pages that read the record at the same time see the same lapsed holds and each pays its own
 * settling, besides its one read, inside its own public request; the one that comes second lets go of nothing and counts
 * nothing. Measured alone and with pages at the same time in tests/stock-settle-pages.test.ts.
 */
export const STOCK_PAGE_SETTLE_COMMANDS_MOST = 1 + STOCK_SELL_COMMANDS;
/**
 * A paid order's stock confirmation at its worst (the thanks page: confirmStock for its product, confirmCartStock for the
 * rest of a cart of MAX_CART limited products): one HEXISTS a product, and STOCK_SELL only for a product the checkout still
 * holds, so each order's unit is counted once in its life (by the thanks page, or by a page that finds its hold lapsed
 * and Stripe says paid; whichever comes second finds no field and counts nothing, and a page's settling is priced in
 * STOCK_PAGE_SETTLE_COMMANDS_MOST, not here). A thanks page opened again sends the HEXISTS only, as main's confirmation
 * did. Measured in tests/stock-sell-cost.test.ts, held inside its own share of ORDER_COMPUTE, which with the cart's stock
 * share and the contact's quarter stays inside one order's compute.
 */
export const STOCK_CONFIRM_COMMANDS_MOST = 16;
export const STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE = 0.12;
/** The quarter of ORDER_COMPUTE an order's contact write may take at the most (lib/contacts.ts, tests/contacts-write-cost.test.ts). */
export const CONTACT_SHARE_OF_ORDER_COMPUTE = 0.25;
/**
 * Every look the five-minute job takes at one offer after paying still waiting on Stripe (lib/upsell.ts,
 * settlePendingOffers), from its first minute to the day it is let go: a payment the bank asked the buyer to confirm,
 * one whose answer was lost on the way back, or one still processing. At most OFFER_WATCH_LOOKS_MOST looks an offer,
 * each at most OFFER_WATCH_LOOK_COMMANDS_MOST database commands (its record read twice, its next look written, the
 * store's record and the run's share of reading the list), and Stripe reads of the creator's account, which bill no API
 * call. Measured in tests/upsell-settle-late.test.ts and held to a declared share of ORDER_COMPUTE, an offer being its
 * own order (line orders); what is left of ORDER_COMPUTE is more than the offer's own answer takes, measured there too.
 */
export const OFFER_WATCH_LOOKS_MOST = 11;
export const OFFER_WATCH_LOOK_COMMANDS_MOST = 7;
export const OFFER_WATCH_SHARE_OF_ORDER_COMPUTE = 0.6;
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
 * A purchase for several's settlement (lib/group-buy.ts settleGroup; Claude 7's cost MEDIUM on #4494): before any place
 * is handed out, its payment is read on the creator's account with its charge expanded, and givenBack may then read the
 * payment's dispute: GROUP_SETTLE_STRIPE_CALLS waits at the most, each STRIPE_WAIT_SECONDS held at 2 GB, once per group
 * order. Held inside ORDER_COMPUTE beside the cart's stock share (tests/group-refunded-before-settle.test.ts).
 */
export const GROUP_SETTLE_STRIPE_CALLS = 2;
export const GROUP_SETTLE_STRIPE_WAIT = GROUP_SETTLE_STRIPE_CALLS * STRIPE_WAIT_SECONDS * MEMORY_SECOND;
/**
 * Queue item 307 [EC1]: not a line of any plan. What telling a closing
 * store's buyers and settling its members costs at the most, for each buyer
 * its cap allows (queue item 307 [EC1],
 * lib/closing-buyers.ts, lib/closing-holds.ts, lib/closing-refunds.ts): its
 * EMAILS_PER_BUYER_PER_ENDING emails at PER_EMAIL; its address and a
 * member's last payment kept until the store closes or stays, a few
 * kilobytes for the closing days, the day its notice may come early and the
 * week a late last notice adds; its share of a page of a hundred of the
 * store's own payments read to find it (lib/closing-buyers.ts, buyerPagesCap); the
 * closing's PayPal pages (CLOSING_PAYPAL_PAGE, below), priced per page; and, as if every one were a member, the calls to Stripe a
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
/**
 * One page of a closing store's PayPal buyers (lib/closing-buyers.ts, PAYPAL_PAGE; #4258): its range and one MGET of
 * PAYPAL_PAGE records at MAX_PAID_BYTES each through the database, the probe past the cap, the told list's read and
 * write for the page and, at the most, two commands a sale to count one not told (HSETNX and its read-back), and its
 * wait at 2 GB as a page of Stripe payments is waited on. At most buyerPagesCap pages a closing, PayPal's and
 * Stripe's together, so a closing reads no more than buyerPagesCap of them, whatever its buyers' count.
 */
export const CLOSING_PAYPAL_PAGE = PAYPAL_PAGE * MAX_PAID_BYTES * DB_BYTE + (5 + 2 * PAYPAL_PAGE) * COMMAND + STRIPE_WAIT_SECONDS * MEMORY_SECOND;
/** One closing's buyers and members at its cap, in dollars: a store of this plan that paid, or one that never did. */
export function closingBuyersCost(tier: Tier, paid = true): number {
  const cap = buyerNoticeCap(tier, paid);
  return cap * CLOSING_BUYER_COST + buyerPagesCap(cap) * CLOSING_PAYPAL_PAGE;
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
 * CX-121 physical-refusal construction adds two individually expiring
 * HASH fields (state/date/checkout only;400days) in the existing company
 * pools. Before enqueue, HLEN+pending reserves finite summary cardinality
 * (technical10000), separately from pending globalItems/storeItems. No new
 * key family or public limit. Strict Lua snapshots precede value transfer;
 * personal copy/erasure and full-pool fulfillment add bounded operations.
 * Redis7.4.12 isolated EVAL+internal observed maxima: enqueue27, claim16,
 * dispatch16, refusal32, explicit no-POST16; these are component measurements,
 * not full lifetime
 * costs, supplier invoices, reviewed funding or an amendment to ORDER.
 * Refusal-field copies, failure tails and erasure/trigger costs remain
 * UNKNOWN/rejected until a complete independent admission precedes IO.
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
/**
 * Vercel Blob operations, from the official page read on 6 November 2026 (Claude 4, C4-20261106-0830-C5-39;
 * https://vercel.com/docs/vercel-blob/usage-and-pricing, "Managed Infrastructure pricing", on-demand rates): an
 * upload (put) is an Advanced Operation, $5.00 per million; a head or a read is a Simple Operation, $0.40 per million.
 * The operations a plan includes are never counted as zero (rule MR).
 */
export const BLOB_ADVANCED_OP = 5 / 1e6;
export const BLOB_SIMPLE_OP = 0.4 / 1e6;
/**
 * The puts one upload request may send: @vercel/blob tries a failed put again up to VERCEL_BLOB_RETRIES times (10 unless
 * set; dist getRetries), and no official page says a put tried again, or refused, is not billed. Unknown is never zero:
 * 1 + 10 (Revisor 1 on #2803; tests/picture-upload-costs.test.ts reads the installed SDK's default).
 */
export const BLOB_PUT_TRIES = 11;
/**
 * A head goes through the same request as a put (requestApi) and is tried again as often; a read through get() is one
 * plain fetch, sent once (Codex S on #2801; tests/picture-upload-costs.test.ts reads the installed SDK).
 */
export const BLOB_HEAD_TRIES = BLOB_PUT_TRIES;
/**
 * The signing requests one upload request may send: issueSignedToken is requestApi("/signed-token", POST) in the
 * installed SDK, the same request as a put, tried again as often. No official page says a signed-token request is free,
 * so each try is counted at the dearer Advanced Operation: unknown is never zero (Claude 1 on #2803, 6708192310;
 * tests/picture-upload-costs.test.ts reads the installed SDK).
 */
export const BLOB_SIGN_TRIES = BLOB_PUT_TRIES;
/**
 * One "Simple Operation" of Vercel Blob (a head: a file's details read without its bytes), at US$ 0.400 per million on
 * demand, from the official page "Vercel Blob usage and pricing" (vercel.com/docs/vercel-blob/usage-and-pricing, read by
 * Claude on 2 November 2026, docs/codex-queue.md item PP2), which also says every interaction counts: never a free quota.
 */
export const BLOB_SIMPLE_OPERATION = 0.4 / 1e6;
/**
 * One "Advanced Operation" of Vercel Blob (a put, a copy, a list; a delete is taken as one too), as a review
 * ceiling: twice the US$ 5.00 per million on demand of Vercel's published price, the same doubling as
 * BLOB_TRANSFER_PER_BYTE. Not read from an official page in this session (vercel.com could not be reached on
 * 9 November 2026): not certified, never zero; a dated official read replaces it. A review ceiling not read: the
 * official pricing page was refused through this session's proxy (403, 9 November 2026), so the figure is the one
 * remembered, doubled, and stays a ceiling to be read and dated before any margin is certified.
 */
export const BLOB_ADVANCED_OPERATION = 10 / 1e6;
/**
 * The daily sweep's commands for one community picture door never used (lib/community-files.ts,
 * sweepCommunityUploads): its share of the list read, the ZREM, the GET of its note, the DECR that gives its place
 * back and the SET when the count went below zero, and the ZADD when it is listed again.
 */
export const COMMUNITY_SWEEP_COMMANDS = 6;
/**
 * The most one community picture door costs (app/api/store/community/upload, 9 November 2026): held as a call waited
 * on for ten seconds at 2 GB, forty commands (the member, the store, its pace, the buyer action, the place, the note,
 * its listing read back, and a place given back), twenty kilobytes through the database, one head of the file store
 * to refuse a name it already has, the browser's upload through the door and the sweep's delete of it when it is never
 * used (two Advanced Operations), and the sweep's commands for it. One buyer action is taken before the head;
 * tests/community-door-cost.test.ts holds this at or under UNIT_COST.buyer, so the line buyer-actions already pays for it.
 */
export const COMMUNITY_DOOR_COST =
  request("wait", 40 + TAKE_COMMANDS, 20_000) + BLOB_SIMPLE_OPERATION + 2 * BLOB_ADVANCED_OPERATION + COMMUNITY_SWEEP_COMMANDS * COMMAND;
/** How long a door's file may be kept before it is used or swept away, in months: a day, and the day the job may take to reach it. */
export const DOOR_KEPT_MONTHS = 2 / 31;
/** What one community picture costs to send: the request, the reads, a second held at 2 GB, and its megabyte from the file store and on to the browser. */
export const PICTURE_READ = request("light", 16) + PICTURE_BYTES * (ORIGIN_PER_BYTE + BLOB_TRANSFER_PER_BYTE);
/**
 * The daily sweep's commands for one assignment door's file, on both its lists (lib/assignment.ts, sweepTaskUploads):
 * on each, its share of the list read, its ZREM, the doors' ZSCORE for a held name, the student's work read to keep a
 * handed-in file, and the ZADD when it is put back; and the hand-in's hold written, taken back or let go
 * (takeTaskUpload, releaseTaskHold).
 */
export const TASK_SWEEP_COMMANDS = 14;
/**
 * The most one student's work on an assignment reads as (lib/assignment.ts, submissionOf), which the sweep reads to
 * keep a handed-in file: the answer and the creator's reply at their longest, each character escaped in JSON at six
 * bytes, and four kilobytes for the rest of the record.
 */
export const TASK_WORK_BYTES = (MAX_ANSWER_TEXT + MAX_FEEDBACK) * 6 + 4_096;
/** Heads of the file store one assignment door's file takes: the door's own, and the hand-in's (app/api/store/course/task). */
export const TASK_DOOR_SIMPLE_OPERATIONS = 2;
/**
 * Advanced Operations one assignment door's file takes at the most: the browser's PUT, a delete by the hand-in (refused,
 * or the file replaced later) and one by the sweep (a held name no work keeps), counted in tests/task-upload-path.test.ts.
 */
export const TASK_DOOR_ADVANCED_OPERATIONS = 3;
/**
 * The most one assignment upload door costs (app/api/store/course/task/upload, 9 November 2026): held as a call waited
 * on for ten seconds at 2 GB, forty commands (the student, the store, the course, its listing, the gate, the task,
 * the pace, the room, the buyer action, the listing and the one taken back), the store's record, the course's and
 * its listing's, the task and the lessons done read at their largest, the heads of the file store (the door's and
 * the hand-in's), the browser's upload through the door and every delete of its file (TASK_DOOR_ADVANCED_OPERATIONS),
 * and the sweep's commands and its two reads of the student's work for it. One buyer action is taken before the head;
 * tests/task-upload-path.test.ts holds this at or under UNIT_COST.buyer, so the line buyer-actions already pays for it.
 * (The two Blob prices are declared as in #3414, same name and value: whichever lands second keeps one copy.)
 */
export const TASK_DOOR_COST =
  request("wait", 40 + TAKE_COMMANDS, MAX_STORE_BYTES + COURSE_BYTES + LISTING_BYTES + TASK_BYTES + DONE_SET_BYTES)
  + TASK_DOOR_SIMPLE_OPERATIONS * BLOB_SIMPLE_OPERATION + TASK_DOOR_ADVANCED_OPERATIONS * BLOB_ADVANCED_OPERATION
  + TASK_SWEEP_COMMANDS * COMMAND + 2 * TASK_WORK_BYTES * DB_BYTE;
/**
 * One certificate of completion drawn as a PDF file (app/[handle]/certificate/[id]/pdf/route.ts): the store and the
 * certificate (or the sample's course and listing) read, its two counts (REQUEST_COMMANDS each), the fonts embedded and the page drawn at a
 * second of CPU (measured at 81 ms, 0.56 s cold) held four seconds at 2 GB, and the heaviest file sent
 * (CERTIFICATE_PDF_MAX_BYTES; 146 KB measured with the longest words in every look). Taken as CERTIFICATE_PDF_UNITS
 * public requests before it is drawn, held above it in tests/plan-cost-registry.test.ts.
 */
export const CERTIFICATE_PDF_READ = CALL + 1 * CPU_SECOND + 4 * MEMORY_SECOND + (16 + 2 * (1 + SHARE_COMMANDS_PER_REQUEST)) * COMMAND + 64_000 * DB_BYTE + CERTIFICATE_PDF_MAX_BYTES * ORIGIN_PER_BYTE;
/**
 * One product's shared card (app/[handle]/p/[product]/opengraph-image.tsx), at its worst (reviews of #4211): the call,
 * PRODUCT_CARD_CPU_SECONDS of CPU held PRODUCT_CARD_HELD_SECONDS at 2 GB (a stated bound: a picture decoded at the pixels
 * an upload keeps and the card drawn), the store, the listing and the review summary read with the two takes, the
 * picture read from the file store (at most MAX_IMAGE_BYTES, the route's own cap) and the largest PNG sent
 * (PRODUCT_CARD_MAX_BYTES). Taken as PRODUCT_CARD_UNITS public requests before it is drawn, held above it in
 * tests/plan-cost-registry.test.ts.
 */
export const PRODUCT_CARD_READ =
  CALL + PRODUCT_CARD_CPU_SECONDS * CPU_SECOND + PRODUCT_CARD_HELD_SECONDS * MEMORY_SECOND + (16 + 2 * (1 + SHARE_COMMANDS_PER_REQUEST)) * COMMAND + 64_000 * DB_BYTE
  + MAX_IMAGE_BYTES * BLOB_TRANSFER_PER_BYTE + PRODUCT_CARD_MAX_BYTES * ORIGIN_PER_BYTE;
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
  // And the book's two questions about its PayPal payments (lib/affiliates.ts, readBook: an HMGET of the refunds kept
  // for good and a ZMSCORE of the set, in slices of BOOK_KEPT_SLICE), each field a ceiling of the payments: their
  // names sent and their answers, BOOK_KEPT_REFUND_BYTES a field, and two commands a slice (pre-review C).
  const asks = 2 * Math.ceil(size.fields / BOOK_KEPT_SLICE);
  // Up to REFUND_MARKS_PER_READ fields could be a sale, share or lead whose refund is kept on it (lib/affiliates.ts,
  // AFFILIATE_REFUND_MARK): its whole new text sent, one script for each of the three hashes.
  const marks = 3;
  const bytes = AFFILIATE_PAGE_BYTES + size.fields * (AFFILIATE_FIELD_BYTES + BOOK_KEPT_REFUND_BYTES) + Math.min(size.fields, REFUND_MARKS_PER_READ) * REFUND_MARK_BYTES + rows * AFFILIATE_ROW_BYTES + size.listings * PUBLIC_LISTING_BYTES;
  // Every field could be an affiliate with a part of their own; every part its lines.
  const kept = Math.min(BOOK_SNAPSHOT_MAX_BYTES, (2 * size.fields + rows + size.stripePages * 100) * BOOK_LINE_BYTES + size.fields * BOOK_PART_BYTES);
  const writes = Math.ceil(kept / 512_000) + 1;
  return request("heavy", AFFILIATE_PAGE_COMMANDS + TAKE_COMMANDS + rows + asks + 2 * writes + marks, bytes + kept) + perMegabyte(bytes + kept)
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
 * What reading whether a come-back link's person already has a membership that has not ended costs at the most
 * (lib/winback-send.ts, openWinBack), besides the press itself (a public request, "come-back"): the units taken, and
 * WINBACK_OPEN_STRIPE_CALLS calls to the creator's Stripe account, each waited on at 2 GB with a whole page's body.
 * Taken as WINBACK_OPEN_REQUEST_UNITS public requests before it reads (tests/plan-cost-registry.test.ts).
 */
export const WINBACK_OPEN_READ = TAKE_COMMANDS * COMMAND + WINBACK_OPEN_STRIPE_CALLS * stripePage();
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
/**
 * What one comment's push reads of the members' devices, at the most (lib/community-push.ts devicesOf): the twelve
 * people it can tell (the post's author, the comment it answers, MAX_MENTIONS named), each with MAX_MEMBER_DEVICES
 * devices, each sending at most DEVICE_SENT_BYTES (an endpoint over MAX_ENDPOINT_BYTES is refused when it is turned
 * on, and a row over it is left out inside Redis). Its reply bytes fit inside UNIT_COST.buyer's 60,000 bytes with the
 * rest of the action (tests/community-device-bytes.test.ts); request and reply bytes together are still an open question
 * with the coordinator (#3400 review thread), not settled here.
 */
export const COMMUNITY_DEVICES_READ = {
  people: 2 + MAX_MENTIONS,
  devices: MAX_MEMBER_DEVICES,
  deviceBytes: DEVICE_SENT_BYTES,
  bytes: (2 + MAX_MENTIONS) * MAX_MEMBER_DEVICES * DEVICE_SENT_BYTES,
} as const;
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
  // devices pushed at once and waited on (their read at most
  // COMMUNITY_DEVICES_READ.bytes), its notices filed, its words
  // indexed, and its deletion later. A hundred commands, 60 KB through the
  // database and on to the browser, and a door's file of up to 10 MB kept
  // for as long as an unused door may be.
  buyer: request("wait", 100 + TAKE_COMMANDS, 60_000) + 60_000 * ORIGIN_PER_BYTE + (MAX_TASK_FILE_BYTES / GB) * STORAGE_PER_GB * DOOR_KEPT_MONTHS,
  // A webhook settings change (lib/webhooks.ts, changeConfig) is inside a studio or API request above: a GET and the
  // compare-and-set a try, CONFIG_WRITE_TRIES tries at the most, and only on a reply it cannot read one GET more, the
  // settings read back once (CX-123 rule 24); when they are as they were read, that read starts the next try.
  // A webhook's try (lib/webhooks.ts): the delivery and the store read and written, the endpoint waited on for up to eight seconds.
  // Since 14 November 2026 a try also reads the store's deletion marks for the addresses in its message, one HMGET
  // (namesErased), before the endpoint is called: 11 commands a try in tests/webhook-erased-person.test.ts, inside the 20.
  webhook: request("wait", 20 + TAKE_COMMANDS, 40_000),
};

/**
 * The most times takeLock (lib/redis-lock.ts) tries a lock's SET NX while it waits `waitMs` for another holder: it
 * sleeps 20 ms, doubled each try up to 250 ms, and tries again only while the next sleep still ends inside the wait;
 * held to that loop's text in tests/paypal-press-cost.test.ts.
 */
export function lockTriesAtMost(waitMs: number): number {
  let tries = 1;
  let slept = 0;
  for (let wait = 20; slept + wait <= waitMs; wait = Math.min(wait * 2, 250)) {
    slept += wait;
    tries += 1;
  }
  return tries;
}
/** The tries of the PayPal pay lock, waited on 5 s (lib/paypal-payouts.ts, payWithPayPal). */
export const PAYPAL_PRESS_LOCK_TRIES = lockTriesAtMost(5_000);
/**
 * The Redis commands one press of "Pay with PayPal" sends besides its book read (lib/paypal-payouts.ts,
 * payWithPayPal; Claude 7 on #4488): the link read, the lock's tries, who is on their way, the link read again for the
 * token, who is on their way again, the lock held again (EVAL), the batch written down as on its way with its store
 * (HSET, SADD), its settling at the most (held under PayPal's id and the "?" entry taken off, or the month's two
 * counts when the answer is not known), and the lock let go (EVAL). Counted through the Redis stand-in on each path in
 * tests/paypal-press-cost.test.ts.
 */
export const PAYPAL_PRESS_COMMANDS = 1 + PAYPAL_PRESS_LOCK_TRIES + 1 + 1 + 1 + 1 + 2 + 2 + 1;
/**
 * And its book read (lib/affiliates.ts, readBook, no deadline, `titles: false`) at the caps: the seven records, the
 * PayPal refunds (BOOK_PAYPAL_REFUNDS), the moves and the refund marks, as bookWork counts them, with the eight counts it
 * counts first kept as room (the press does not count them). No product is read for its title: a batch names none.
 */
export const PAYPAL_PRESS_BOOK_COMMANDS = bookWork({ kept: true, entries: 1, people: 1, leads: Number.MAX_SAFE_INTEGER, paypalRefunds: Number.MAX_SAFE_INTEGER, stripe: true, products: 0 }, BOOK_STRIPE_PAGES).commands;
/** How long one press runs at the most: the studio route's maxDuration and payday's (app/api/cron/affiliates/route.ts). */
export const PAYPAL_PRESS_SECONDS = 60;
/**
 * One press, in dollars, whose book read sends `bookCommands` (bookWork at its size, titles not read): a call held at
 * 2 GB for all its seconds, every command of its own above, the book's and the store figure's take. What the book read
 * moves through the database by the byte (its records grow with the program) is not in it: the same open question for
 * every reader of the whole book (the studio's affiliates page, the payout file, payday's email), not settled here
 * and never read as zero.
 */
export function paypalPressCost(bookCommands: number): number {
  return CALL + SHAPES.wait.cpu * CPU_SECOND + PAYPAL_PRESS_SECONDS * MEMORY_SECOND
    + (PAYPAL_PRESS_COMMANDS + bookCommands + TAKE_COMMANDS) * COMMAND + 20_000 * DB_BYTE;
}
/** One press at the most: its book read at the caps. */
export const PAYPAL_PRESS = paypalPressCost(PAYPAL_PRESS_BOOK_COMMANDS);
/**
 * Presses a store makes a month that take no integration unit: payday's auto-pay, once (lib/affiliate-payday.ts,
 * claimMonth, then keepMonth confirmed BEFORE payWithPayPal, so a refused payday email, a press whose outcome is not
 * known or a run stopped mid-press never brings a second press that month; Claude 6 on #4488). A press from the studio
 * takes its units first (lib/paypal-payouts.ts, paypalPressUnits), so it is inside the figure; this one is added to
 * the integrations line at PAYPAL_PRESS.
 */
export const PAYPAL_PRESSES_UNTAKEN = 1;

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
 * A month's receipts in one ZIP at its worst (601 [KB22] U3, lib/receipt-batch.ts): the whole run at 2 GB and on the CPU,
 * every receipt numbered, the fullest ZIP sent, every Stripe page waited on. Paid by RECEIPT_BATCH_UNITS studio requests,
 * taken before Stripe is read (tests/kb22-receipt-batch.test.ts holds the units above this), so the "studio" line holds.
 */
export const RECEIPT_BATCH_COST = readShapeCost(RECEIPT_BATCH_SHAPE);

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
 * One companies request at the most (app/api/store/companies, lib/crm-companies.ts;
 * 639 [GL7](4)): every company read (MAX_COMPANIES_BYTES, about a megabyte), the
 * two records a link moves written back, the lock taken and let go, the room
 * taken and given back, its studio requests counted, and every company sent on
 * to the browser. Counted as COMPANIES_REQUEST_UNITS studio requests, taken
 * before it reads (tests/plan-cost-registry.test.ts).
 */
export const COMPANIES_REQUEST = request("heavy", 12 + 2 * TAKE_COMMANDS, MAX_COMPANIES_BYTES + 2 * MAX_COMPANY_RECORD_BYTES + 4_096) + MAX_COMPANIES_BYTES * ORIGIN_PER_BYTE;
/**
 * A page's reading of every company at the most (the companies page, a person's page; 639 [GL7](4)): about a
 * megabyte from the database and its studio requests counted. Counted as COMPANIES_READ_UNITS studio requests
 * before it reads. What the page sends on is counted apart by its size (companiesSentUnits, STUDIO_UNIT_SENT_BYTES),
 * and its reading of the buyers from Stripe as BUYER_LEDGER.
 */
export const COMPANIES_PAGE_READ = request("heavy", 4 + 2 * TAKE_COMMANDS, MAX_COMPANIES_BYTES);
/** What sending STUDIO_UNIT_SENT_BYTES on to the browser costs: within one studio request. */
export const STUDIO_UNIT_SENT = STUDIO_UNIT_SENT_BYTES * ORIGIN_PER_BYTE;
/**
 * One reading of who is owed a membership benefit (lib/tier-benefits.ts, benefitsDue; Claude 7's cost MEDIUM on
 * #3014), on every page load that lists them and every give or undo press, when it reads `pages` pages of running
 * memberships (at most BENEFIT_STRIPE_PAGES): each page, customers expanded, waited on one after another at 2 GB
 * (STRIPE_LIST_PAGE) after its studio take; the benefits (MAX_BENEFITS_KEPT, each at BENEFIT_ROW_BYTES) and the
 * store's list made if it had none (BENEFITS_LIST_COMMANDS), once; for each of the page's hundred members, their
 * deleted-person look-up (a print sent and a reply) and the marks of every row owed (readOwedMarks: one HMGET, of at
 * most MAX_BENEFITS_KEPT fields of BENEFIT_MARK_FIELD_BYTES, each answered with at most BENEFIT_MARK_VALUE_BYTES), one
 * trip to the database a page at the most. Counted as BENEFIT_PAGE_UNITS studio requests before each page;
 * tests/plan-cost-registry.test.ts holds them above it at every number of pages, and no higher than needed.
 */
export const BENEFIT_PAGE_MEMBERS = 100;
/** A benefit's record: its id, and its JSON with MAX_BENEFIT_TEXT characters escaped at six bytes each at the most. */
export const BENEFIT_ROW_BYTES = 13 + 6 * MAX_BENEFIT_TEXT + 200;
/** A mark's field, `<benefit>:<sub>:<period>`: 13 + 1 + 68 + 1 + 11 bytes at the most. */
export const BENEFIT_MARK_FIELD_BYTES = 94;
/** A mark, `{"at":<seconds>,"by":"<address>"}`: the address at 320 characters, each escaped to two bytes at the most. */
export const BENEFIT_MARK_VALUE_BYTES = 32 + 2 * 320;
/** A person's marks key, and a store's deleted-person print, at the most. */
export const BENEFIT_PERSON_BYTES = 96;
export const BENEFITS_LIST_COMMANDS = 4;
export function benefitsRead(pages: number): number {
  const members = pages * BENEFIT_PAGE_MEMBERS;
  return request(
    "heavy",
    1 + BENEFITS_LIST_COMMANDS + 1 + pages * TAKE_COMMANDS + members,
    MAX_BENEFITS_KEPT * BENEFIT_ROW_BYTES
      + 2 * members * BENEFIT_PERSON_BYTES
      + members * (BENEFIT_PERSON_BYTES + MAX_BENEFITS_KEPT * (BENEFIT_MARK_FIELD_BYTES + BENEFIT_MARK_VALUE_BYTES)),
  ) + pages * (STRIPE_LIST_PAGE + ROUND_TRIP_SECONDS * MEMORY_SECOND);
}
/**
 * One reading of a store's buyers from the creator's Stripe account at the
 * most (lib/segments.ts, buyerLedger), when its one-hour copy ran out: its
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
 *   note of the person's own deletion read before the hand-over (one HGET, erasedSincePaid with `own`; a person deleted
 *   at their own request at or after the payment ends the try there, after the take-back's read below, the affiliate's
 *   and partners' credit and the order's count; parts L and M), the hand-over's rerun (its writes already there), the
 *   first-try mark, the link's grant, the receipt kept as first made (two GETs each try; on the try that keeps it, one
 *   EVAL, KEEP_RECEIPT, whose six calls are the person's deletion mark read, its three erasure notes, SET NX and GET),
 *   the affiliate's credit, the same note read once more after every write that names the person (one HGET; it runs on
 *   the return route's first hand-over too, which is the order's own work, line orders, inside ORDER_COMPUTE) and the
 *   kept sender included, at the most measured with either sender refusing (tests/paypal-handover-cost.test.ts for
 *   Resend, tests/paypal-receipt-once.test.ts for Amazon): 35 sent, with the receipt kept, Amazon refusing for the
 *   account (the owner told), the key moved to Resend and Resend asking to slow down (429) on each of viaResend's three
 *   attempts, all in one try (a refusal Amazon gave goes on to Resend in the same try; part E2). 54 counts each of
 *   KEEP_RECEIPT's six calls besides its EVAL (41), and a store from before lists given its list in that try, before
 *   the deletion mark's read, once in its life (ensureListId: 7 sent, measured in part K, the three lock and write
 *   scripts' two calls each counted too, 13). A try whose second read finds the person's own deletion completed during
 *   it takes back what it wrote of them (takeBack; parts M and N), at most takeBackCommands more for a product that is
 *   not a course: the purchase's HGET and HLEN, then one EVAL (TAKE_BACK_OWN, lib/paypal-delivery.ts; Codex C2 on #3449)
 *   whose calls are counted too: the purchase's HGET and HLEN again, the store's SREM from each of the 14 keys of the
 *   stores they bought from (lib/buyer-library.ts forgetBoughtCommands), the affiliate bond's HGET and HDEL and the
 *   purchase's HDEL (22); a course of the order adds four (dropEnrollment with its start: the EVAL and its two calls,
 *   and the DEL), where its hand-over's recordEnrollment adds two (line orders). The purchase already taken by the
 *   deletion sends fewer (the bond's HDEL_IF_EQUAL EVAL and its two calls, no SREM, no HDEL; part N). 76 is the longest
 *   try with a take-back on top. Once a take-back succeeds the order leaves the list; one that finds the purchase
 *   changed since its read takes nothing back and the order stays owed (part O).
 *   The kept receipt is at most RECEIPT_MAIL_BYTES (lib/paypal-delivery.ts), written once and read back by each try; its key is priced as the
 *   order's in tests/store-data-registry.ts (nl:ppsell:mail:). The guarded Resend ledger's own EVALs are lib/resend-fallback-budget's.
 *   PAYPAL_RECEIPT_RETRY_COMMANDS is their product: the most one order's receipt retries send.
 * Why the retry is the five-minute job's, not a plan's: NOT_A_COST.HAND_OVER_BATCH.
 */
export const PAYPAL_HAND_OVER_RETRY = { listCommandsPerSale: 2, listReadsPerStoreRun: 1, ordersPerStoreRun: 25, ownCommandsPerOrderTried: 4, receiptTriesPerOrder: 12, commandsPerReceiptTry: 76, takeBackCommands: 22 } as const;
export const PAYPAL_RECEIPT_RETRY_COMMANDS = PAYPAL_HAND_OVER_RETRY.receiptTriesPerOrder * PAYPAL_HAND_OVER_RETRY.commandsPerReceiptTry;
/**
 * The daily plans job (lib/plans.ts, settlePlans, from app/api/cron/plans/route.ts), per run, at the most:
 * - readCommandsPerRun: one pipeline reads both lines (SRANDMEMBER of the new plans, ZRANGEBYSCORE ... LIMIT of
 *   the plans tried and due), each bounded by plansPerRun;
 * - plansPerRun: PLANS_PER_RUN plans tried, none started after the run's deadline;
 * - ownCommandsPerPlanTried: settled or gone, SREM and ZREM; kept, ZADD and then SREM; moved to another time or
 *   mark (watched for an earlier end, a failure not its account's, its creator told), ZADD, SREM and ZREM;
 * - stripeCallsPerPlanTried: the checkout, the subscription and at most one update (or the end at once, DELETE), and,
 *   for a plan past its own end, its late payments given back (lib/plan-late-refunds.ts, LATE_REFUND_CALLS): the
 *   subscription's paid invoices from its end on (one list, its charges expanded), the account's balance, and for at
 *   most lateRefundsPerTry payments the refunds already made on it and the refund itself; no Redis command of its own
 *   (each refund's mark and idempotency key live at Stripe), and a plan with more to give back is kept for the next
 *   day (ZADD, SREM, ZREM, inside ownCommandsPerPlanTried);
 * - runMs: the share of the run the route gives the plans (PLANS_MS), every request given up by then;
 * - tellCommandsPerPlan: per try of the telling (sent once a plan; while it stays unsent, tried again at each of the
 *   plan's tries, weekly for a stuck plan and daily for an owed one, each try these commands again and, on the Amazon
 *   SES path, one of the store's emails taken before sending and not given back when both providers fail; each
 *   notice goes under an idempotency key of its own plan, lib/plan-stuck-notice.ts, noticeKey), when its account has
 *   refused us for PLAN_GIVE_UP_DAYS, telling its creator
 *   (lib/plan-stuck-notice.ts): the store read by its id (two GETs and the free-account check storeForEmail makes,
 *   five, as measured in tests/payment-plan-stuck.test.ts), the product's listing (at most one read), the email's
 *   meter and send on the Resend path measured there (four; on Amazon SES that path's own commands, priced with
 *   every store email in lib/email.ts), and, when it could not be sent, the mark given back (ZADD, SREM, ZREM).
 *   The email itself is the store's own, taken from its email figure before it is sent (EMAIL_SITES). The same
 *   figure bounds the once-a-plan email to the creator about a payment after the plan's end still owed back for
 *   PLAN_OWED_TELL_DAYS (lib/plan-stuck-notice.ts, tellPlanOwed: the same reads, meter and send, and the mark given
 *   back when it could not be sent);
 * - lateTellsPerTry and lateTellCommandsPerPlan: a plan past its end whose late payments are given back tells each
 *   buyer once (lib/plan-late-notice.ts): one read of every late payment's claim (HEXISTS, at most the 100 the list
 *   holds), the store read by its id (five) and the product's listing (one), and for at most lateTellsPerTry payments
 *   the claim (HSETNX, HINCRBY, EXPIRE), the email's meter and send on the Resend path (four, as measured in
 *   tests/payment-plan-late-notice.test.ts) and, when it could not be sent, the claim given back (HDEL): at most
 *   100 + 6 + 3 x 8 = 130. Each email is the store's own, taken from its transactional figure before it is sent
 *   (EMAIL_SITES), so it is inside the plan's worst month; a payment's email is tried at most LATE_TELL_TRIES (7)
 *   times, and a plan with a buyer still to tell is tried again the next day, inside plansPerRun.
 * A plan its account refuses is tried at growing intervals for PLAN_GIVE_UP_DAYS (about ten tries), then once
 * every PLAN_STUCK_RETRY_DAYS until the account answers; a failure not its account's (Stripe down, our key) is
 * tried at the next run. Every try is inside plansPerRun. Why this is the company's, not a plan's:
 * NOT_A_COST.PLANS_PER_RUN.
 */
export const PLAN_SETTLE_RUN = { readCommandsPerRun: 2, plansPerRun: 200, ownCommandsPerPlanTried: 4, stripeCallsPerPlanTried: 3 + 2 + 2 * 3, lateRefundsPerTry: 3, runMs: 25_000, tellCommandsPerPlan: 15, lateTellsPerTry: 3, lateTellCommandsPerPlan: 130 } as const;
/**
 * The PayPal refund watch (lib/paypal-sales.ts, watchPayPal; C4-13 and its pre-review), run by the five-minute job's
 * sweep of a store with PayPal, which until now had no line here:
 * - listReadsPerStoreRun: one ZRANGEBYSCORE of the store's watch list a run;
 * - ordersPerStoreRun: at most REFUND_WATCH_BATCH due orders read from it a run;
 * - payPalReadsPerOrderLook: one GET of the order's capture at PayPal each time it is looked at (inside the job's run
 *   deadline; no dated source here gives PayPal's price per API call, so it is an open gap, never zero);
 * - ownCommandsPerOrderLook: the paid record's GET and one write of the list (ZADD for the next look, or ZREM);
 * - looksPerOrderPerDayAtMost: nextLook asks hourly the first week (24 a day), every six hours until day 30 (4 a day)
 *   and daily until PayPal's 180 days (looksPerOrderPerDayAfter30Days); a capture in a status not known here is asked
 *   daily until its paid record ends (daysWatchedAtMost, PAID_KEPT_SECONDS).
 * The take-back marks (ZADD and EXPIRE of the refund set, and of the reversed set for a capture reversed, failed or
 * declined) are counted on every refund look, retries included, in PAYPAL_REFUND_KEPT.markCommandsPerRefundLookAtMost
 * (Claude 6 on #3464). The rest of taking a payment back (the buyer's record, a course start) happens once an order
 * and is not priced apart here: an open gap, never zero. A scheduled job bounded by its schedule and the batch, a
 * company fixed cost like HAND_OVER_BATCH (NOT_A_COST.REFUND_WATCH_BATCH), held by tests/paypal-reversed-access.test.ts.
 */
export const PAYPAL_REFUND_WATCH = {
  listReadsPerStoreRun: 1,
  ordersPerStoreRun: 25,
  payPalReadsPerOrderLook: 1,
  ownCommandsPerOrderLook: 2,
  looksPerOrderPerDayAtMost: 24,
  looksPerOrderPerDayAfter30Days: 1,
  daysWatchedAtMost: 400,
} as const;
/**
 * The refund kept for good by the same watch (lib/paypal-sales.ts, watchPayPal, backKey; #3464, Claude 7's MÉDIO):
 * each look at an order PayPal says is refunded in full writes it to nl:ppsell:back:<stats> with one ORDER_WRITE
 * script (lib/order-data.ts, orderWrite) carrying one HSETNX, charged to the store's room:
 * - scriptsPerRefundLook / writesPerScript: one script, one write;
 * - commandsPerScriptAtMost: the EVAL and the script's own calls for one HSETNX field at its dearest (EXISTS, TYPE,
 *   HEXISTS and HSTRLEN before, the HSETNX, HEXISTS and HSTRLEN after, the room's two HGETs and its HSET): 11;
 * - markCommandsPerRefundLookAtMost: each look that reaches the write first runs the take-back marks again, the refund
 *   set's ZADD and EXPIRE and, for a capture reversed, failed or declined, the reversed set's ZADD and EXPIRE: at most 4
 *   a look, on the first look and on every retry (Claude 6 on #3464, MEDIUM);
 * - retryWritesPerFailedLook: a write not known landed puts the order back on the watch an hour on (one ZADD) and
 *   tells nothing, so its worst is the marks, one script and one ZADD an hour (looksPerDayAtMost, the watch's own hourly look),
 *   for as long as the watch keeps the order (daysAtMost, the paid record's 400 days): no count of tries, bounded by
 *   the watch itself and by its REFUND_WATCH_BATCH orders a run.
 * A company fixed cost of the five-minute job like PAYPAL_REFUND_WATCH (NOT_A_COST.REFUND_WATCH_BATCH), held by
 * tests/affiliate-refund-lifetime.test.ts.
 */
export const PAYPAL_REFUND_KEPT = {
  scriptsPerRefundLook: 1,
  writesPerScript: 1,
  commandsPerScriptAtMost: 11,
  markCommandsPerRefundLookAtMost: 4,
  retryWritesPerFailedLook: 1,
  looksPerDayAtMost: 24,
  daysAtMost: 400,
} as const;
/**
 * The other half of the same function, the sweep of the store's pending PayPal orders (lib/paypal-sales.ts, watchPayPal,
 * pendingKey; Claude 6's second money review of #3392, LEVE 6), run by the same five-minute job:
 * - listReadsPerStoreRun: one ZRANGEBYSCORE of the store's pending list a run;
 * - ordersPerStoreRun: at most PENDING_SWEEP_BATCH orders read from it a run;
 * - ownReadsPerOrder: the opened order's GET and the paid record's GET;
 * - payPalReadsPerOrder: one GET of the order at PayPal (no dated source here gives PayPal's price per API call: an open
 *   gap, never zero);
 * - ownWritesPerOrderAtMost: one write of the list, ZREM when the order is settled elsewhere, voided, declined or past
 *   its record, or ZADD XX to the back of the list when it is still waited on (LEVE 1).
 * Writing a paid order down and handing it over is the order's own work (line orders, settle). Each order stays at
 * most 30 days, its opened record's life. A scheduled job bounded by its schedule and the batch, a company fixed cost
 * like REFUND_WATCH_BATCH (NOT_A_COST.PENDING_SWEEP_BATCH), held by tests/paypal-reversed-access.test.ts.
 */
export const PAYPAL_PENDING_SWEEP = {
  listReadsPerStoreRun: 1,
  ordersPerStoreRun: 25,
  ownReadsPerOrder: 2,
  payPalReadsPerOrder: 1,
  ownWritesPerOrderAtMost: 1,
} as const;
/**
 * The store's webhooks told of a PayPal payment refunded in full ("refund.issued", lib/paypal-delivery.ts, from the
 * five-minute job's watch of PayPal refunds, watchPayPal in lib/paypal-sales.ts): before the event, the person's
 * own-deletion note is read once (ownNoteReadsPerRefund: one HGET, erasedSincePaid with `own`), so an address deleted
 * at the person's request is left out (review of #3449, LEVE 2). Held by tests/paypal-receipt-once.test.ts (part M).
 * The watch's other per-order commands are the lines of PAYPAL_REFUND_WATCH and PAYPAL_REFUND_KEPT above.
 */
export const PAYPAL_REFUND_TOLD = { ownNoteReadsPerRefund: 1 } as const;
/**
 * The copy a reading of the buyers leaves, stored for its whole life (lib/segments.ts, LEDGER_SECONDS: an hour since
 * the owner's C3-80 (b); Codex R1 on #3226): BUYER_LEDGER_BYTES at Upstash's GB-month rate for that hour. Only a
 * reading writes it and one copy lives at most that long after it, so a store read back to back pays each hour of its
 * copy with the reading that made it. tests/ledger-copy-retention-cost.test.ts holds the hour to LEDGER_SECONDS.
 */
export const BUYER_LEDGER_COPY_SECONDS = 3_600;
export const BUYER_LEDGER_COPY_KEPT = BUYER_LEDGER_BYTES * DB_BYTE_MONTH * (BUYER_LEDGER_COPY_SECONDS / (30 * 86_400));
export const BUYER_LEDGER = request("heavy", 8 + TAKE_COMMANDS, 2 * BUYER_LEDGER_BYTES) + ALL_TIME_PAGES * EXPORT_PAGE_SECONDS * MEMORY_SECOND + BUYER_LEDGER_COPY_KEPT;
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
    id: "picture-uploads",
    feature: "Studio picture uploads (a product's, a link's and a page's picture): each copy's Blob puts, every try counted, and the checks of its name and bytes (6 November 2026; never counted before)",
    monthlyUsd: (tier) => STORE_ALLOWANCES[tier].studio * ((BLOB_PUT_TRIES + BLOB_SIGN_TRIES) * BLOB_ADVANCED_OP + (3 * BLOB_HEAD_TRIES + 2) * BLOB_SIMPLE_OP + 2 * CDN_PER_REQUEST + 2 * MAX_IMAGE_BYTES * (BLOB_TRANSFER_PER_BYTE + ORIGIN_PER_BYTE)),
    sources: [
      { file: "app/api/store/image/upload/route.ts", names: ["studioAccess", "notePictureDoor", "issueSignedToken"] },
      { file: "lib/studio-route.ts", names: ["countStudio"] },
      { file: "lib/product-image.ts", names: ["MAX_IMAGE_BYTES"] },
      { file: "lib/uploaded-image.ts", names: ["firstBytes", "reader.cancel()"] },
    ],
    basis: "Every copy of a picture (the picture and its smaller copy) is put through its own upload request, and attaching them is one more; each is a studio request (studioAccess, countStudio), at most the plan's studio figure a month, a hard ceiling. Each request is counted at the dearest one may be: its put (an Advanced Operation) with every try again the SDK may send (BLOB_PUT_TRIES), Simple Operations: three heads (the one that checks a name is free; one for the picture and one for its smaller copy), each with its tries again (BLOB_HEAD_TRIES); its signing request (issueSignedToken, requestApi in the SDK), counted as an Advanced Operation with every try (BLOB_SIGN_TRIES), because no official page says it is free; and two reads, one plain fetch each, each a CDN request, with both copies' whole bytes (MAX_IMAGE_BYTES each) at the dearer Blob transfer rate kept here plus Fast Origin Transfer, since a private blob fetched on a miss pays both (as PICTURE_READ prices a private picture read; Claude 1 on #2803). The read is counted whole: firstBytes reads a stream it cancels after sixteen bytes, and no official page says the Blob honors a byte range with 206 or bills only the bytes sent (Claude 4, C4-20261106-1120-TODOS-63). Prices: vercel.com/docs/vercel-blob/usage-and-pricing, read on 6 November 2026. Not in this line: a buyer's review photo (lib/review-photo.ts) and an email's picture (lib/mail-pictures.ts), each a Blob put of its own, reported apart to be bounded and counted.",
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
      // A gift's and a purchase for several's exact reads and "OK"-checked writes, a place's compare-and-set scripts and a
      // checkout's room given back once (#2872; Claude 7's LEVE 1): a few commands an order, inside ORDER_COMPUTE.
      { file: "lib/gifts.ts", names: ["readGiftExactly"] },
      { file: "lib/group-buy.ts", names: ["readGroupExactly", "PLACE_CLAIM", "PLACE_DROP"] },
      { file: "lib/purchase-email.ts", names: ["firstToGiveRoomBack"] },
      // A payment request's checkout is one order, admitted before Stripe's page opens and counted at its receipt (18 October 2026).
      { file: "lib/payment-requests.ts", names: ["admitOrders(store, 1, now, 1)"] },
      { file: "lib/purchase-email.ts", names: ["confirmRequest", "countOrder"] },
      // An affiliate's lead for a free product or a booked call is written inside that order (18 October 2026).
      { file: "lib/calls.ts", names: ["recordLead"] },
      // A booked call's once-only mark and its time kept for good, in one step, and the mark moved on as the rest is
      // done, each email under its own key (Claude 5, 9 November 2026): inside the order's own work, priced below.
      { file: "lib/calls.ts", names: ["orderWriteOnce", "markConfirmed", "confirmEmailKey", "confirmationOwed"] },
      // The mark moved on only from the stage its writer read, and a move leaving a confirmation not yet done owed
      // ("moved") without its two emails (Claude 5, 9 November 2026): inside the order's own work, priced below.
      { file: "lib/calls.ts", names: ["CONFIRM_STEP", "stepMark", '"moved", "NX"'] },
      { file: "lib/order-data.ts", names: ["ORDER_WRITE_ONCE", "orderWriteOnce"] },
      // A cart's checkout reads the offers of each of its products, and what each bundle in it hands over, at most MAX_CART of each, to know whose offers follow it (556 [CT1], 1 and 2 November 2026): reads only, inside that order.
      { file: "lib/cart-offers.ts", names: ["cartOfferOwner", "liveFunnel"] },
      { file: "lib/cart-rules.ts", names: ["MAX_CART = 4"] },
      // A cart's checkout holds a unit of each limited product in it (513 [PF1], unit 3, 2 November 2026): a lock, a count, a provisional hold and its own for each, at most MAX_CART.
      // Since Codex G2's review (5 November 2026) the admission and the hand-over are one script each (STOCK_ADMIT, which also lets the locks go,
      // and STOCK_BIND: 1 + 3 commands a product each); Stripe is never asked under a lock and a lock waits LOCK_WAIT_MS at most. The whole of it,
      // at its worst for MAX_CART limited products, is measured in tests/cart-stock.test.ts (68 commands on 5 November 2026) and held under
      // CART_STOCK_COMMANDS_MOST, half of ORDER_COMPUTE at most. An opening whose answer is unknown asks nothing more: its holds lapse.
      { file: "lib/stock.ts", names: ["withCartStockHolds", "PENDING_MS", "releaseCartStockHolds", "STOCK_ADMIT", "STOCK_BIND", "stripeRefusedOpening", "LOCK_WAIT_MS = 500", "countStock(store, product, now, false)"] },
      // Its units counted as sold when the buyer is back (Claude 7's MÉDIO on #4472, 15 November 2026): one HEXISTS a product, and
      // STOCK_SELL (the EVAL and its HDEL and HINCRBY) only where the checkout still holds its field, once in each order's life; at most
      // STOCK_CONFIRM_COMMANDS_MOST for MAX_CART limited products, inside STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE (tests/stock-sell-cost.test.ts).
      { file: "lib/stock.ts", names: ["STOCK_SELL", "confirmCartStock", "heldBy"] },
      { file: "app/api/store/free/download/route.ts", names: ["recordAffiliateLead"] },
      // A course's checkout sent from a page that said its end date reads the course once, exactly (24 [E7], 9 November 2026).
      { file: "app/api/store/checkout/route.ts", names: ["readCourseForSale(product.course.id)"] },
      { file: "lib/course-access-end.ts", names: ["readCourseExact(id)"] },
      // An offer still waiting on Stripe is looked at by the five-minute job less often the longer it waits (WATCH_AFTER_MS),
      // and a bank payment still processing past its second day once a day until its seventh: OFFER_WATCH_LOOKS_MOST x
      // OFFER_WATCH_LOOK_COMMANDS_MOST commands at most, inside OFFER_WATCH_SHARE_OF_ORDER_COMPUTE.
      { file: "lib/upsell.ts", names: ["settlePendingOffers", "WATCH_AFTER_MS", "nextLook", "PROCESSING_WATCH_MS = 7 * 24", "PROCESSING_RECHECK_MS = 24 * 60"] },
      // A contact an order writes is written only over the row it was decided from (consent audit of 9 November 2026; review of #3448): its worst case, a script counted as 1 plus the calls inside it, held in tests/contacts-write-cost.test.ts.
      { file: "lib/contacts.ts", names: ["CONTACT_COMMANDS_MOST", "CONTACT_FENCED_WRITE_CALLS", "CONTACT_WRITE_CALLS"] },
    ],
    basis: "The plan's figure, each order at the most one costs. An affiliate's lead for a free product claimed or a booked call (lib/affiliate-leads.ts, 18 October 2026) is three or four commands inside that order's own work, which ORDER_COMPUTE prices at well over a whole page, and no email; what it keeps is in the data room, taken before it is written. Nothing is sold past it: new orders are admitted only while the month's orders and the checkouts held from the last day are under the figure. A place in a purchase for several people is an order of the month it is taken in: inside its checkout's hold for a day, admitted when taken after (since 18 October 2026), its emails access emails. A payment request's record is changed under its own lock (since 18 October 2026, docs/security-audit-2026-10-18.md, MM-SA-02): four commands more a change, at most a dozen changes a request (made, sent, reminded twice, opened, paid, refunded), inside the same ORDER_COMPUTE. Since 8 November 2026 the record is written only while that lock is still the writer's (lib/payment-request-store.ts, SAVE): a change's three writes become one script that runs five inside it, three commands more a change with Lua's own counted, and the request is made under its lock too, seven more (the lock, the script's three over the plain write, the release's three); at most 43 commands more a request, $0.000086 at Upstash's $2 a million, no other command and nothing more kept. A booked call's confirmation (lib/calls.ts, confirmBooking; Claude 5, 9 November 2026) writes its once-only mark and the time kept for good in one ORDER_WRITE_ONCE (lib/order-data.ts: ORDER_WRITE behind a GET of the mark, and a DEL of it only when a command was refused), in place of the two ORDER_WRITEs it took before, so one script and one charge of the room fewer; then it moves the mark on, at most three SETs (booked, buyer, done), and with Amazon each of its two emails takes lib/email.ts's own once-only claim (a SET NX each, as an order's confirmation does): a handful of commands more a booked call, which is CALL_ORDER_UNITS orders, inside the same ORDER_COMPUTE. A try that failed after the mark is finished by the next one (the thanks page, the studio's catch-up, the mail job, which read the mark with a GET in place of the EXISTS), which reads the diary's entry (one HGET) and does only what is still owed: the orders by their own seen marks, the lead by its HSETNX, the webhook and the phone alert by their own once-only marks, each email at most once; a page refreshed writes and charges nothing more Each move of the mark is one CONFIRM_STEP script (a GET and at most one SET of the same mark, in place of the SET it was), from the stage its writer read. A move before the confirmation was done writes the mark \"moved\" (five bytes, charged in the move's own ORDER_WRITE, in place of the \"1\" it wrote) and, when a confirmation was already begun, one CONFIRM_STEP more, which only shortens it; the next try then does what a booking does besides its two emails, which the move's emails stand in for (the same commands as a first confirmation, fewer emails), and moves \"moved\" on only to \"done\": no value outgrows what the room was charged for. A contact an order puts on the creator's list is written only over the row it was decided from (consent audit of 9 November 2026): at the most CONTACT_COMMANDS_MOST.upsert commands, a script counted as one plus every call inside it (CONTACT_WRITE_CALLS), inside ORDER_COMPUTE (a quarter of it at the most), with the order's checks two reads more inside ORDER_WRITE_IF_SAME; held in tests/contacts-write-cost.test.ts. A course's checkout sent from a page that said the course's end date (24 [E7], 9 November 2026) reads the course record once more, exactly: one GET of at most the course record, inside the same ORDER_COMPUTE, nothing kept and nothing sent; the end shown rides on the Stripe session as one more metadata field.",
  },
  {
    id: "list-email",
    feature: "The monthly emails: list email, sequences and workflows (#507), their notices to the owner, and emails to people brought over on Studio and Scale",
    monthlyUsd: (tier) => monthlyEmails(tier) * PER_EMAIL,
    sources: [
      { file: "lib/plan.ts", names: ["PRO_MONTHLY_EMAILS", "SCALE_MONTHLY_EMAILS", "TRIAL_MONTHLY_EMAILS"] },
      { file: "lib/mail.ts", names: ["reserve", "takeFromMonth", "stopWriting(store.listId as string, r.to, \"refused\")"] },
      { file: "lib/email.ts", names: ["notYetTaken(batchKey, [...result.taken, ...result.refused.map((r) => r.message)])", "REFUSED_ADDRESS", "notMaybeTaken(batchKey, pending)"] },
      { file: "lib/ses.ts", names: ["markMaybe", "unmarkMaybe", "notMaybeTaken"] },
      // A community announcement batch reads its members' list rows once (one HMGET of at most CHECKED_BATCH_SIZE fields), far
      // inside what the batch's emails cost at PER_EMAIL (14 November 2026).
      { file: "lib/community-mail.ts", names: ["keptOnList"] },
    ],
    basis: "Every monthly email sent, at the most an email costs. A plain batch's email that goes by Amazon (sendBatch: product updates, community announcements, review asks, imports; never a list batch) takes at most three commands more for its possibly-taken mark (lib/ses.ts, 13 November 2026): a SET NX before Amazon is asked, a GET when the batch is tried again, a DEL when Amazon says for certain it did not take it, kept two days at most; about $0.000006 at Upstash's $2 a million, inside what an email is priced at. One the email service refuses for good in a list batch (lib/email.ts ListBatchOutcome, 9 November 2026) is taken from the month before it is tried like any other and stays taken: it pays for asking Amazon (nothing for a refusal), for its own did mark read back with the batch (one GET; each accepted one reads its own inside its own email) and, refused as an address, for taking it off the list (lib/contacts.ts stopWriting: at most three rounds of an HGET and the CAS_HSET script with its read-back, then an INCR, about sixteen commands), about $0.00004 at Upstash's $2 a million, inside what an email is priced at. The address is then off the list for good, so it is never paid for twice; nothing more is kept.",
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
      { file: "lib/ses.ts", names: ["markMaybe", "unmarkMaybe", "notMaybeTaken"] },
      { file: "lib/checkout-ask.ts", names: ["ASKS_PER_STORE_DAY"] },
      { file: "lib/assistant-reminder-rules.ts", names: ["ASSIST_REMINDERS_PER_STORE_DAY"] },
      { file: "lib/winback.ts", names: ["ONCE_PER_DAYS"] },
      // A card notice to a member (lib/payment-recovery.ts, noticeCards) whose link's SET Redis did not answer with exactly "OK" sends
      // nothing and removes the link, in case it landed, with one DEL (lib/card-update.ts, cardLink; Claude 7's MÉDIO on #2985): one
      // command per failed notice, $0.000002 at Upstash's $2 a million, and the notice's mark let go for the next run. No email is
      // sent, so no store email is taken for it; each card is tried at most once a run of the daily job (CARD_PAGES pages of running
      // memberships a store), so it is a scheduled job's command, bounded by its schedule, a company cost not yet a line of
      // lib/llc-fixed-costs.ts: not certified, never zero.
      { file: "lib/card-update.ts", names: ['redisPipeline([["DEL", key]])', "CARD_LINK_SECONDS"] },
      { file: "lib/payment-recovery.ts", names: ["const CARD_PAGES = 5", "releaseMark(key, value)"] },
    ],
    basis: "The plan's store emails, each at the most an email costs and its count; the daily and per-person limits only spread them. One sent in a plain batch by Amazon (community event notices, waitlist launches) takes at most three commands more for its possibly-taken mark (lib/ses.ts: a SET NX, a GET on a retry, a DEL when Amazon did not take it), inside what an email is priced at.",
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
      // An AI explanation of one funnel check (26 [E9]): one writing job (FUNNEL_EXPLAIN_JOBS), taken before its one bounded request (tests/funnel-explain.test.ts).
      { file: "lib/funnel-explain.ts", names: ["askModel", "counted", "FUNNEL_EXPLAIN_JOBS", "FUNNEL_EXPLAIN_CALL"] },
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
    // The five-minute job's look for steps parked for room at Amazon SES (SES_WAKE_JOB_COMMANDS, every run of every day a
    // billing month touches) is a company cost; until it has a line of its own it is priced whole on every plan that can
    // run workflows, and so park a step (#4246). A plan with no runs a day parks nothing.
    monthlyUsd: (tier) => (DAILY_RUNS_BY_TIER[tier] * WORST_COMMANDS_PER_RUN + (DAILY_RUNS_BY_TIER[tier] > 0 ? SES_WAKE_JOBS_PER_DAY * SES_WAKE_JOB_COMMANDS : 0)) * DAY_WINDOWS * COMMAND,
    sources: [{ file: "lib/flow-limits.ts", names: ["DAILY_RUNS_BY_TIER", "WORST_COMMANDS_PER_RUN", "TRIAL_DAILY_RUNS", "ACTIVE_FLOWS_BY_TIER", "WORKFLOW_LIMITS", "SES_WAKE_JOBS_PER_DAY", "SES_WAKE_JOB_COMMANDS"] }],
    basis: "Every new run of every UTC day a billing month touches (32) at the run ceiling of commands, and the scheduled mail job's look for steps parked for room at Amazon SES, every run of every such day, priced whole on each plan that can run workflows (a company cost with no line of its own yet; a plan with no runs a day parks nothing). Steps run in the five-minute job, whose time the schedule bounds (a company fixed cost); emails and the owner's notices come out of the monthly emails.",
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
      { file: "app/embed/[handle]/[product]/page.tsx", names: ["StoreBeacon", "const resting = store && product ? await isResting(store) : false;", "readScriptOpen(store, mode, query, Boolean(product))"] },
      { file: "app/embed/[handle]/join/page.tsx", names: ["StoreBeacon"] },
    ],
    basis: "Each render of a card is one of the store's public requests, taken once, after the store and the listing are read and before anything else (stock, keys, bumps, the summary, the script's open), as the store's own product page does (isResting, #4634); an open by the script does not take a second one, and an open of a product that cannot be read takes its own (readScriptOpen's counted, Claude 7 on #4645); a resting store's card reads nothing more. Its worst product render (limited stock with lapsed holds, keys, a bump, the summary, opened by the script) and a weekly call's times in a frame on a listed site (view=times: slotsForProduct, its held and booked times, the calendar and the call's sessions, Stripe stood in; not a team's) are each measured against COMMANDS.laterPage + COMMANDS.laterCount in tests/embed-card-metered.test.ts; an open of a card counts as a visit, sent by the card's own beacon like any page of the store (app/api/store/hit, through the host's browser check), and rests with the public pages, so it is inside the visits line, and a checkout from it is an order.",
  },
  {
    id: "certificate-page",
    feature: "A certificate's page and its tab's title (R20 finding 3; the anonymous-traffic audit, 9 November 2026)",
    monthlyUsd: ALL_TIERS_SAME(0),
    sources: [{ file: "app/[handle]/certificate/[id]/page.tsx", names: ["const load = cache(", "if (await isResting(store)) return { store, resting: true as const };", "if (found.resting) return <StoreResting store={found.store} />;"] }],
    basis: "A public page of the store: the page and its title share one load, which takes one of the store's public requests before the certificate, or the sample's listing and course, is read, and rests with the public pages. It reads no more than a product's page (the store, a listing, a course), 5 commands measured against COMMANDS.laterPage + COMMANDS.laterCount, so it is inside the visits and public-requests lines (tests/certificate-page-admission.test.ts).",
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
      // The course's start button (a "course-start" public request) keeps the learner's end on their student row (24 [E7]).
      // Measured on 9 November 2026 (synthetic Redis and Stripe, a store with one course): reading a learner's courses
      // right after recordEnrollment emptied their cache is GET, HGETALL, SET and one SISMEMBER for each course they
      // have, and one Stripe list (two when the typed address differs from its normal form); the import read (HGETALL)
      // and the community read (GET, ZSCORE, HGET, HGETALL) are added where the store has them. It is the reading the
      // course page makes on every visit. In the paying browser it only comes before the course page's, which then
      // finds it cached: GET, HGETALL and the SISMEMBERs more (and those two reads), no Stripe call more. On the
      // emailed-link branch the student row is read first (HGET), and a learner with no row adds that HGET alone; for a
      // row that exists the reading, the row's HSET and, for a new end, its room are paid first as one more public
      // request (takePublicRequest), a later page of its own, refused past the store's window (C2's L-1 on #3445).
      { file: "app/api/store/course/start/route.ts", names: ["purchaseStamp(store, email, product.id)", "noteStudentStamp(", "takePublicRequest(store, \"buyer\")"] },
      // A license key's device activation or release (610 [WP9] unit 2): at most ACTIVATION_COMMANDS commands and the record's
      // bytes, counted as ACTIVATION_REQUEST_UNITS requests before anything is read (the price is held in tests/licence-activations.test.ts);
      // its record takes its room in the store's data room before it is written (tests/store-data-registry.ts).
      { file: "lib/licence-activations.ts", names: ["ACTIVATION_COMMANDS", "ACTIVATION_REQUEST_UNITS", "MAX_ACTIVATION_RECORD_BYTES", "needData(store"] },
      // A community search and its access checks, and the one walk of its archive, paid before they read (4 November 2026).
      { file: "lib/community-read-rules.ts", names: ["SEARCH_UNITS", "SEARCH_ROOM_UNITS", "SEARCH_UNITS_PER_CONVERSATION", "SEARCH_UNITS_PER_CHECK", "WALK_COMMANDS_PER_UNIT", "WALK_BYTES_PER_UNIT"] },
      { file: "app/[handle]/community/search/page.tsx", names: ["searchUnits({ room: config.chat.on, conversations })", "checkUnits(checks)", "{ shared: true }"] },
      { file: "lib/community-walk.ts", names: ["walkUnits(", "indexedWords(", "INDEXED_WORDS_BYTES"] },
      // A member's locked spaces read their products as a collection page reads its cards, paid before they are read (542 [CM1], 6 November 2026);
      // read in rounds since 7 November 2026, each round paying what its first reads add; nothing is read twice (the pre-orders once, every
      // listing and bundle item kept and handed on, never read again in a later round), so the rounds pay and read what one read of them would.
      { file: "lib/community-locked.ts", names: ["MAX_UNLOCK_PRODUCTS = MAX_COLLECTION_PRODUCTS", "units <= 0 || (await take(units))", "pay(collectionUnits(read.size + ids.length) - collectionUnits(read.size))", "pay(bundleItemUnits(items.size + fresh.length) - bundleItemUnits(items.size))", "ids.filter((id) => !asked.has(id))", "soon ??= await soonState(store)", "productsBuyableNow(store, listings, Date.now(), { soon, listings: known })"] },
      { file: "lib/mail-product-sellable.ts", names: ["known ? known.soon : await soonState(store)", "deliverableItems(p, [...bundles, ...known.listings.values()])"] },
      { file: "app/[handle]/community/page.tsx", names: ["takePublicRequest(store, \"buyer\", undefined, units)"] },
      // The studio's "View as a member" reads them the same way, paid in studio requests before it reads.
      { file: "app/studio/community/page.tsx", names: ["unlocksOf(store, config, (units) => countStudio(store, null, units)"] },
      { file: "lib/traffic.ts", names: ["countRequest", "takePublicRequest", "requestsKey"] },
      { file: "lib/metered-limits.ts", names: ["withinStore"] },
      // A sign-up credited to an affiliate takes one of these before its lead is written (18 October 2026).
      { file: "lib/affiliate-leads.ts", names: ["takePublicRequest(store)", "count?: boolean"] },
      // The offers after a cart read what the buyer already has from the creator's Stripe account, counted before (556 [CT1], 1 November 2026).
      { file: "lib/cart-offers.ts", names: ["takeBuyerRead(store, CART_OFFER_REQUEST_UNITS)", "CART_OFFER_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS"] },
      // A come-back link's checkout reads whether the person has a membership still running before it opens (R43, follow-up to #3371).
      { file: "lib/winback-send.ts", names: ["takeBuyerRead(store, WINBACK_OPEN_REQUEST_UNITS)", "WINBACK_OPEN_STRIPE_CALLS - 2"] },
      { file: "lib/winback.ts", names: ["WINBACK_OPEN_STRIPE_CALLS", "WINBACK_OPEN_REQUEST_UNITS"] },
      // A member's page and each action on it read one list of memberships for each customer of the address its link holds, side by side,
      // at most MANAGE_CUSTOMERS_MAX, the link's record within MANAGE_GRANT_BYTES (inside LINK_BYTES of tests/store-data-registry.ts):
      // Stripe bills no API call and no store command or byte is added, so the request's own cost is unchanged (R43 F1 on #2985, 9 November 2026).
      { file: "lib/membership-manage.ts", names: ["MANAGE_CUSTOMERS_MAX = 20", "MANAGE_GRANT_BYTES = 700", "Promise.allSettled(customersOf(grant)"] },
      // A code only for people who bought here before reads what the typed email bought from the creator's Stripe account, counted before (554 [DS1], unit 2, 11 November 2026).
      // A call's deposit code reads the creator's Stripe account for the typed code, counted before (rule MR audit G2, 14 November 2026).
      { file: "app/api/store/book/route.ts", names: ["takeBuyerRead(store, DEPOSIT_CODE_REQUEST_UNITS)"] },
      { file: "lib/deposit-code.ts", names: ["DEPOSIT_CODE_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS"] },
      { file: "lib/returning-code.ts", names: ["takeBuyerRead(store, RETURNING_CODE_REQUEST_UNITS)", "RETURNING_CODE_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS", "RETURNING_TRIES = 6", "RETURNING_LINKS_PER_ADDRESS = 3", "RETURNING_LINK_SECONDS = 1800", "kind: \"transactional\""] },
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
      { file: "lib/buyer-orders.ts", names: ["export async function requestOrdersLink", "withinOpening(Promise.all([purchasesFor(store, raw, meter), callsFor(store, raw, meter)]), meter, ORDERS_LINK_READ_MS)", "afterAnswer(() => sendLink(store, raw, email, origin))", "export async function findPurchase", "takePublicRequest(store, \"buyer\", Date.now(), DOWNLOAD_LOOKUP_UNITS)", "withinOpening(lookUp(store, email, kind, reference, meter, want), meter, DOWNLOAD_LOOKUP_MS)", "DOWNLOAD_LOOKUP_MS)) as Row", "await meter.take(count)", "const find = finderFor(store, meter)", "function onlyFinder(store: Store, meter: OrdersMeter)"] },
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
      // A quiz try takes QUIZ_TRY_UNITS after its per-connection limit and before the listing, the access or the course is
      // read, never one of the store's buyer actions (#3466, 16 November 2026): at its heaviest it sends 30 commands, inside
      // two later pages' (tests/quiz-try-admission.test.ts); the try written is in the quizzes line besides.
      { file: "app/api/store/course/quiz/route.ts", names: ["withinLimit(\"quiz-connection\"", "takeBuyerRead(store, QUIZ_TRY_UNITS)", "withinLimit(\"quiz-student\""] },
      { file: "lib/quiz-usage-rules.ts", names: ["QUIZ_TRY_UNITS = 2", "QUIZ_TRIES_PER_CONNECTION_MINUTE", "QUIZ_TRIES_PER_STUDENT_HOUR"] },
      // A product's shared card reads its picture from the file store and draws: one request before its listing, the rest of
      // PRODUCT_CARD_UNITS before the picture is read (tests/c1-cost-product-card.test.ts).
      { file: "app/[handle]/p/[product]/opengraph-image.tsx", names: ["takePublicRequest(store, \"public\", now, 1)", "takePublicRequest(store, \"public\", now, PRODUCT_CARD_UNITS - 1)"] },
      { file: "lib/public-read-rules.ts", names: ["PRODUCT_CARD_UNITS = 9"] },
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
      // A search of the store page: the read of every listing the store record does not carry, once for everybody, kept
      // ten minutes and paid as the store's shared work; then the matches it shows and their checkout boxes, each paid
      // before it is read (lib/store-search-index.ts, c1-cost-store-search).
      { file: "app/[handle]/page.tsx", names: ["searchStorePaid(store, wantedSearch)"] },
      { file: "lib/store-search-index.ts", names: ["takePublicRequest(store, \"public\", undefined, units, { shared: true })", "takePublicRequest(store, \"public\", undefined, 1)", "paidRead(store, shownIds)", "paidRead(store, missing)", "takePublicRequest(store, \"public\", undefined, units)"] },
      // The open cart counts what is left of each limited product in it, as a product's page does (513 [PF1], unit 3, 2 November 2026): one read each, at most MAX_CART.
      { file: "app/api/store/cart/route.ts", names: ["withinStore(\"cart-read\"", "stockLeft(store, p)"] },
      // A count settles its lapsed holds in one HDEL and one STOCK_SELL a product at the most (Claude 5's MÉDIO on #4472), STOCK_PAGE_SETTLE_COMMANDS_MOST.
      { file: "lib/stock.ts", names: ["MAX_CHECKS", '["HDEL", stockKey(store.statsId, product.id), ...letGo]', "sellCommand(store.statsId, product.id, paid)", "#ARGV > ${MAX_CHECKS}"] },
      // A waitlist's confirm press writes its entry back in WAIT_CONFIRM (#4268), one EVAL and WAIT_CONFIRM_CALLS inside it, and takes WAIT_CONFIRM_UNITS more of the store's requests before it writes (#4404).
      { file: "lib/waitlist.ts", names: ["WAIT_CONFIRM", "WAIT_CONFIRM_CALLS", "WAIT_CONFIRM_UNITS", "takePublicRequest(store, \"public\", Date.now(), WAIT_CONFIRM_UNITS)"] },
      // A join's place is written in WAIT_JOIN, fenced by the coming-soon mark (#4462, 16 November 2026): one EVAL and
      // WAIT_JOIN_CALLS inside it where one HSET was, inside the join's own request (withinStore "waitlist-ip").
      { file: "lib/waitlist.ts", names: ["WAIT_JOIN", "WAIT_JOIN_CALLS", "withinStore(\"waitlist-ip\""] },
      // A link of a sent email that goes through its redirect (124 [F2-EDIT-SENT-LINKS], 6 November 2026): one request, counted before the change is read.
      { file: "app/go/[handle]/[id]/[link]/route.ts", names: ["takePublicRequest(store, \"public\", Date.now(), SENT_LINK_REQUEST_UNITS)", "readSentLinks(id)"] },
      { file: "lib/sent-link-rules.ts", names: ["SENT_LINK_REQUEST_UNITS = 1"] },
      // A sign-up (a list, a waitlist, a free download) writes its contact only over the row it was decided from (consent audit of 9 November 2026; review of #3448), and an unsubscribe, a purchase noted, a link's token and a taken-back permission do the same: each worst case, a script counted as 1 plus the calls inside it, in tests/contacts-write-cost.test.ts.
      { file: "lib/contacts.ts", names: ["CONTACT_COMMANDS_MOST", "CONTACT_FENCED_WRITE_CALLS", "CONTACT_WRITE_CALLS"] },
    ],
    basis: "An affiliate's lead for a confirmed sign-up (lib/affiliate-leads.ts, 18 October 2026) takes one of the window's requests before it is written, and is not credited past them; its few commands stay inside a later page's, held in tests/affiliate-leads.test.ts. An affiliate's own page (lib/affiliate-page-admission.ts) and the store's map (lib/store-sitemap.ts) count what they would read first, with a few commands, and take that many of the window's requests before reading it (lib/public-read-rules.ts; affiliatePageRead, affiliateLoadRead and sitemapRead held in tests/plan-cost-registry.test.ts), so neither reads past the window; the affiliate program's book is worked out for all its affiliates at most every BOOK_FRESH_SECONDS and kept that long (lib/affiliate-book-snapshot.ts), the load that works it out paying for it in full outside its connection's share of the day, every other load paying for its own part. Every request of the window is counted, pages and public routes together, and the store rests at REQUESTS_PER_VISIT for each visit of its figure and EXTRA_REQUESTS more: the visits line already prices three pages a visit (tests/traffic-cost.ts), so the extra ones are priced here at a later page each (a review ceiling no public route passes), and every one at its count. The open cart's count of its limited products (513 [PF1], unit 3, 2 November 2026) adds at most MAX_CART reads, and asks the creator's Stripe account, which costs us nothing but the wait, only about a hold that ran out, at most MAX_CHECKS times a product; a hold settled, by being counted sold or let go, is not asked about again; a count that settles holds writes at most one HDEL and one STOCK_SELL a product whatever their number (STOCK_PAGE_SETTLE_COMMANDS_MOST, besides its read), and pages counting at the same time each pay their own inside their own request, the one that comes second counting nothing (Claude 5's MÉDIO on #4472; tests/stock-settle-pages.test.ts); a sale still written the old way (a field each) is read and counted, never written, by a page's count (Claude 7's MÉDIO on #4472; tests/stock-sell-cost.test.ts). A sign-up's contact is written only over the row it was decided from (lib/contacts.ts): without a race one round is at most CONTACT_COMMANDS_MOST.upsertRound commands (a script is one plus its CONTACT_WRITE_CALLS calls; a waitlist confirmation's, fenced by its link since #4268, plus its CONTACT_FENCED_WRITE_CALLS, the fence's PTTL and TIME more, and the round is priced at that dearer one), inside a later page's commands. A sign-up a public request pays for (the list's or the waitlist's confirmation): its first round with the read back of an answer in another shape is at most CONTACT_COMMANDS_MOST.upsertPublic, inside the later page's commands that request pays for; each round more, after a row changed meanwhile, first takes one public request of the store's (payRound, takePublicRequest), at most upsertRound commands inside it, or is not made and the sign-up is refused for the visitor to try again (Codex Z on #3448, 6751568157; held with contended runs in tests/contacts-write-cost.test.ts). A waitlist's confirm press (app/api/store/waitlist/confirm/route.ts) does more than its page's one request pays for when it writes: it reads the link and the store, then the link and the entry again, writes the entry back only while its link and the entry are still there (WAIT_CONFIRM, #4268: one EVAL and at most WAIT_CONFIRM_CALLS calls inside it) and signs the address up (upsertPublic), at most 26 commands measured against the page's 18; so before it writes anything it takes WAIT_CONFIRM_UNITS more of the store's public requests (takePublicRequest), or writes nothing and is refused, and the whole press, that request's own count included, stays inside the two it is paid by (held in tests/waitlist-confirm-cost.test.ts). An order's sign-up goes round up to three times (CONTACT_COMMANDS_MOST.upsert), inside the order's own compute. An unsubscribe (CONTACT_COMMANDS_MOST.unsubscribe), a purchase noted, the links' tokens (tokens(n)) and a taken-back permission are held the same way.",
  },
  {
    id: "studio",
    feature: "The studio's own reads and writes: every page of it drawn (STUDIO_PAGE_UNITS each), every save and read, its refreshing; and the never-paused plan, cancel, delete and data-download requests (17 October 2026)",
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "studio") + ESSENTIAL_PER_DAY * DAY_WINDOWS * request("heavy", 40, 200_000) + PAUSED_PER_DAY * DAY_WINDOWS * request("light", 8),
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "studio"] },
      { file: "lib/studio-allowance-rules.ts", names: ["STUDIO_PAGE_UNITS", "ESSENTIAL_PER_DAY", "ESSENTIAL_NEEDS"] },
      { file: "lib/studio-route.ts", names: ["countStudio", "studio-essential"] },
      // A product's removal pays WAITLIST_DROP_UNITS more studio requests before anything goes, for its waitlist's hold
      // and drop (or its drop finished when asked again): at most WAITLIST_DROP_COMMANDS commands and WAITLIST_DROP_BYTES
      // bytes, inside those units (#4462, 16 November 2026; tests/waitlist-removed-drop-pending.test.ts).
      { file: "lib/waitlist.ts", names: ["WAITLIST_DROP_UNITS", "WAITLIST_DROP_COMMANDS", "WAITLIST_DROP_BYTES", "holdWaitlistDrop", "finishWaitlistDrop"] },
      { file: "app/api/store/product/route.ts", names: ["takeAllowance(guarded.store, \"studio\", WAITLIST_DROP_UNITS)"] },
      // A person's erasure reads the store's waitlist marks (two SCARD and two SMEMBERS, in ERASE_FIXED_COMMANDS) and
      // counts each mark read (ERASE_PER.waitlists), capped at MAX_WAITLIST_MARKS; paid with the rest of the erasure.
      { file: "lib/erasure-rules.ts", names: ["ERASE_FIXED_COMMANDS = 562", "waitlists: [3, 1_000]"] },
      { file: "lib/waitlist.ts", names: ["MAX_WAITLIST_MARKS", "waitlistMarks"] },
      { file: "lib/person-erasure.ts", names: ["waitlists: scope.waitlistMarks ?? 0"] },
      // An active store may clear its assistant notes repeatedly: settings admission takes one studio request first.
      { file: "app/api/store/assistant-memory/route.ts", names: ["guardStoreWrite", "forgetMemory"] },
      { file: "lib/assistant-memory-store.ts", names: ["MEMORY_FORGET_COMMANDS"] },
      // A deal entering a stage takes one more studio request before the workflow its stage starts is checked (17 October 2026).
      { file: "lib/deal-stage-trigger.ts", names: ["STAGE_TRIGGER_UNITS", "countStudio(store, null, STAGE_TRIGGER_UNITS)"] },
      // A store that kept tasks about people before their count has every task read once to make it, after tasksRecountUnits studio requests are taken (review of #1959, 4 November 2026).
      { file: "lib/crm.ts", names: ["TASKS_RECOUNT_UNITS", "tasksRecountUnits", "TASK_COUNT_FIELD"] },
      // A campaign landing's save checks its words against up to AD_REVIEWS of the product's reviews: AD_CONTEXT_UNITS studio requests first, at the reviews' heaviest, refused without reading (Claude 5's review of #1950; tests/ad-context-cost.test.ts holds the bytes).
      { file: "lib/ad-context.ts", names: ["AD_REVIEWS", "AD_REVIEW_BYTES", "STUDIO_REQUEST_BYTES", "AD_CONTEXT_UNITS"] },
      // And the product's page it reads, measured first (keptPageBytes) and read no further (readPageWithin), counted at pageReadUnits in the save and the list (Claude 5's return on #1950; tests/campaign-landing-page-cost.test.ts).
      { file: "lib/ad-context.ts", names: ["pageReadUnits"] },
      { file: "lib/sales-page-store.ts", names: ["keptPageBytes", "readPageWithin", "PageGrown"] },
      { file: "app/api/store/campaign-landing/route.ts", names: ["countStudio(store, null, AD_CONTEXT_UNITS + pageReadUnits(bytes))", "countStudio(store, null, pageReadUnits(bytes))"] },
      // The agenda of everyone's tasks reads every task: tasksRecountUnits(people) studio requests first, refused without reading (review of f6bd3d1f4, M1).
      { file: "app/api/store/person-tasks/route.ts", names: ["countStudio(store, null, units)", "TasksRecountRefused", "countStudio(store, null, tasksRecountUnits(people))", "taskPeople(store.statsId)"] },
      // Explaining a funnel check reads that funnel's checks again: FUNNEL_EXPLAIN_READ_UNITS more studio requests first, a studio page's in all (26 [E9]).
      { file: "lib/funnel-explain.ts", names: ["FUNNEL_EXPLAIN_READ_UNITS", "STUDIO_PAGE_UNITS - 1"] },
      { file: "app/api/store/funnel-explain/route.ts", names: ["countStudio(store, null, FUNNEL_EXPLAIN_READ_UNITS)", "readFunnelChecks"] },
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
      // five-minute job may make to switch it on (each one call to the creator's Stripe account, which bills none, and a few commands),
      // and one for each try of the email that it failed (unit 2: a few commands; the email itself from the store's email figure, EMAIL_SITES).
      { file: "app/api/store/discount/route.ts", names: ["countStudio(store, null, SCHEDULE_UNITS)"] },
      { file: "lib/discount-schedule-rules.ts", names: ["SCHEDULE_UNITS = ACTIVATION_TRIES + NOTICE_TRIES", "MAX_SCHEDULED_CODES", "NOTICE_RETRY_SECONDS"] },
      { file: "app/api/cron/imports/route.ts", names: ["activateScheduledCodes("] },
      // A delivery check (479 [SB2], unit 2) takes DELIVERY_CHECK_UNITS studio requests before the product is read and
      // anything it hands over is asked for; tests/delivery-check.test.ts holds them over the check at its worst.
      { file: "app/api/store/delivery-check/route.ts", names: ["countStudio(store, null, DELIVERY_CHECK_UNITS)"] },
      { file: "lib/delivery-check-rules.ts", names: ["DELIVERY_CHECK_UNITS", "MAX_DELIVERY_ITEMS", "DELIVERY_ITEM_MS", "ADDRESS_READ_BYTES"] },
      // The totals of every store take a page of each other store's studio, as the Terms say (C4-4, owner's decision of 4 November 2026, C4-18).
      { file: "app/studio/totals/page.tsx", names: ["countStudio(store, null, STUDIO_PAGE_UNITS)"] },
      // The studio's one search box (766 [STN13]): STUDIO_SEARCH_UNITS studio requests taken before its one exact read of every product's card (readCardsExact, never filled in from the products' records), with the store's minute and day counters (two commands each) inside them, counted first so a search they refuse takes none; tests/stn13-studio-search.test.ts holds the dearest search, MAX_PRODUCTS cards, under them.
      { file: "app/api/store/studio-search/route.ts", names: ["countStudio(access.store, null, STUDIO_SEARCH_UNITS)", "studio-search", "studio-search-day"] },
      { file: "lib/studio-allowance-rules.ts", names: ["STUDIO_SEARCH_UNITS"] },
      { file: "lib/studio-search-rules.ts", names: ["SEARCHES_PER_MINUTE", "SEARCHES_PER_DAY"] },
      { file: "lib/catalog.ts", names: ["readCardsExact"] },
      // A list file or the buyers audience holds the units of each read before it is made and counts every byte it moved (R31, reviews of #3354).
      { file: "lib/list-download.ts", names: ["listDownloadHeld", "listDownloadUnits", "listPageMost", "jsonBytes", "holdStudio(store, units)", "holdStudio(store, need - holding)"] },
      { file: "lib/contacts.ts", names: ["CONTACT_READ_BYTES", "LIST_PAGE_READ_BYTES", "read: ListRead = plainRead"] },
      { file: "lib/free.ts", names: ["readFieldsWhole(store.statsId)", "valuesOf(statsId, fields", "through: ListRead = plainRead"] },
      { file: "lib/crm.ts", names: ["valueReadBytes", "\"HMGET\""] },
      { file: "app/api/store/leads/route.ts", names: ["holdListDownload(store)", "held.read", "held.send", "held.settle"] },
      { file: "app/api/store/audience/route.ts", names: ["holdListDownload(store)", "held.read", "held.send", "held.settle"] },
      // A workflow's history (639 [GL7](19)): listing its versions, putting one back (and each try again) and the save that keeps one measure what they move
      // in Redis and take that many studio requests at UNIT_COST.studio's 50 KB before any of it is read; an ordinary save keeps a version at most once a
      // pause of edits, so an autosave inside it reads no versions (Claude 5 on #1927, coordinator's decision B; held in tests/flow-history-cost.test.ts).
      { file: "lib/flow-versions-rules.ts", names: ["FLOW_VERSION_PAUSE_SECONDS = 600", "STUDIO_REQUEST_BYTES = 50_000", "FLOW_HISTORY_OVERHEAD_BYTES", "flowHistoryUnits", "listVersionsBytes", "restoreTryBytes", "restoreBytes", "keepVersionBytes"] },
      { file: "lib/flow-versions.ts", names: ["FLOW_HISTORY_SIZE", "payFlowHistory", "countStudio(store, null, flowHistoryUnits(bytes))", "keepFlowVersionOnce", "\"NX\", \"EX\", FLOW_VERSION_PAUSE_SECONDS"] },
      { file: "lib/flows.ts", names: ["keepFlowVersionOnce(store, store.listId, flows[at], flow)", "payFlowHistory(store, restoreBytes(", "payFlowHistory(store, restoreTryBytes(", "opts.again", "redis.sha1hex(now)"] },
      { file: "app/api/store/mail/route.ts", names: ["payFlowHistory(store, listVersionsBytes(", "FlowHistoryNotPaid"] },
    ],
    basis: "A list file or the buyers audience, which walks the whole list, takes from the figure the units of its commands and of every byte it reads and sends (lib/list-download.ts): each read held before it is made at the most it can answer with (a page of the list at the whole list as counted, the store's fields' values for the page's people at their longest), counted at what it moved, and the file held before it is sent; a read the figure has not the units for is never made, and what was held and not used is given back. Its fields' values are read for the people in the file only, never the whole of a field's values. Once a plan has ended it takes ENDED_LIST_DOWNLOADS of its own instead, priced in the line closure. Every studio request of the window at the studio shape; a page drawn takes STUDIO_PAGE_UNITS of them, more than a heavy read costs (held below). Past the figure the studio shows one page, drawn at most PAUSED_PER_DAY times a day; changing or canceling the plan, deleting the store and downloading its sales take a small daily figure instead. What a page reads of the store's numbers past that is the store's own readings (line store-readings), never more of these.",
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
      { file: "lib/api-sales.ts", names: ["charge(apiReadUnits(listingsWork(listingsToRead(store, wanted))), API_SALES_UNITS - 1)"] },
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
    // A press of "Pay with PayPal" takes its units at its size (paypalPressUnits); payday's auto-pay takes none, so it is added at its most (Claude 7 on #4488).
    monthlyUsd: (tier) => figureCost(STORE_ALLOWANCES[tier], "integration") + PAYPAL_PRESSES_UNTAKEN * PAYPAL_PRESS,
    sources: [
      { file: "lib/store-allowance-rules.ts", names: ["STORE_ALLOWANCES", "integration"] },
      { file: "lib/metered-limits.ts", names: ["withinService", "withinServiceWhy"] },
      { file: "app/api/store/affiliates/paypal/route.ts", names: ['withinServiceWhy("paypal-pay", store.handle, 6, 3600, store, paypalPressUnits(sizes))', "bookSizes(store)", "maxDuration = 60"] },
      { file: "lib/paypal-payouts.ts", names: ["payWithPayPal", "holdLock(lock)", "withLock(`nl:pp:${statsId}:lock`, 120, 5_000", "readBook(store, undefined, { titles: false })", "paypalPressUnits", "PAYPAL_PRESS_BASE_UNITS", "PAYPAL_PRESS_UNIT_COMMANDS"] },
      { file: "lib/affiliate-payday.ts", names: ["claimMonth", "if (!(await keepMonth(store.statsId, month))) throw", "payWithPayPal(store)"] },
    ],
    basis: "Every call of the window, held at 2 GB for ten seconds while the other service answers; what the service charges is nothing to us, and AI captions are bought apart. A press of \"Pay with PayPal\" costs more than a call (its own commands with both lock EVALs, its whole book read with no product read for its title, up to sixty seconds), so it takes PAYPAL_PRESS_BASE_UNITS and one more for each PAYPAL_PRESS_UNIT_COMMANDS of its book read at the program's size, counted first, which cover it at every size; payday's auto-pay, one a month, takes no unit and is added once at its most (PAYPAL_PRESS). The bytes the press's book read moves are the open question every reader of the whole book shares, not priced here and never zero.",
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
      // 543 [CM2]: a post or comment held for approval is the same action, a few commands lighter than one published, inside the community's and the member's ceilings;
      // a hold first sweeps at most HOLD_SWEEP expired items. A member's visit to the community reads their own held items with one read (heldOf), MGET only when they have some.
      { file: "lib/community-approval.ts", names: ["holdPost", "holdComment", "MAX_HELD", "MAX_MINE", "needData", "HOLD_SWEEP", "heldOf", "ZREVRANGEBYSCORE"] },
      { file: "app/api/store/community/rsvp/route.ts", names: ["takeBuyerAction(store)"] },
      // A challenge's join or check-in (19 [E2] unit 1): one buyer action a press, before anything is read.
      { file: "app/api/store/community/challenge/route.ts", names: ["takeBuyerAction(store)"] },
      { file: "app/api/store/community/chat/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/community/messages/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/community/push/route.ts", names: ["takeBuyerAction"] },
      { file: "app/api/store/community/upload/route.ts", names: ["takeBuyerAction", "head(pathname)", "takePicturePlace"] },
      { file: "app/api/store/course/comment/route.ts", names: ["takeBuyerAction"] },
      // The hand-in's head of its file and its deletes are priced with the door the file came through (TASK_DOOR_COST).
      { file: "app/api/store/course/task/route.ts", names: ["takeBuyerAction(store)", "headFile(path)", "deleteFile(path)", "releaseTaskHold(file.path)"] },
      // The assignment door also asks the file store once whether the browser's name is already a file (one head, and
      // a listing it may take back), after its buyer action is taken (9 November 2026).
      { file: "app/api/store/course/task/upload/route.ts", names: ["takeBuyerAction(on.store)", "head(pathname)", "dropTaskDoor(pathname)"] },
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
      { file: "lib/community-text.ts", names: ["RATE_LIMITS", "EVENT_WRITES_PER_HOUR", "CHALLENGE_WRITES_PER_HOUR"] },
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
    feature: "Closing the store (18 October 2026): its records deleted, its followers read, its whole exports and list downloads after its plan ended, its last steps",
    monthlyUsd: (tier) => closureCost(tier).total,
    sources: [
      { file: "lib/closed-store-data.ts", names: ["walkPage", "FOLLOWERS", "prepareStore", "stopRenewals", "DEL_BATCH", "FOLLOW_BATCH", "RENEWALS_AT_ONCE"] },
      { file: "lib/closed-store-data.ts", names: ["queueDeleted", "admitDeleted", "BATCH_SWAP", "DELETE_SETTLES_MS", "if (!entry.deleted) await finish(entry, now)", "settleDeletedStore({ ref, sid: entry.sid, email: entry.email, holds: entry.holds ?? [entry.handle] })", "await forgetBoth(entry.statsId ?? null, entry.sid)", "await queueStoreForget(entry.statsId ?? null, entry.sid)"] },
      { file: "lib/store.ts", names: ["await queue(store)", "deleteIfHeldOnly(held, [owner, beforeMoveKeyOf(owner)])", "storeExactly", "settleDeletedStore", "DELETED_HOLD"] },
      { file: "lib/store-forget-retry.ts", names: ["FORGET_TRY_COMMANDS", "forgetBoth"] },
      { file: "lib/store-field-rules.ts", names: ["MAX_ADDRESSES"] },
      { file: "app/api/store/stores/route.ts", names: ["deleteStore(ref, queueDeleted)"] },
      { file: "lib/plan-closing-rules.ts", names: ["ENDED_STORE_EXPORTS"] },
      { file: "app/api/store/export/route.ts", names: ["ENDED_STORE_EXPORTS", "storeExport(store)"] },
      { file: "lib/store-export.ts", names: ["EXPORT_STRIPE_PAGES", "EXPORT_PAGE_SECONDS", "EXPORT_COMMANDS"] },
      { file: "lib/plan-closing-rules.ts", names: ["ENDED_LIST_DOWNLOADS"] },
      { file: "lib/list-download.ts", names: ["holdEndedListDownload", "ENDED_LIST_DOWNLOADS", ":list-ended:", "read: plainRead"] },
      { file: "lib/crm.ts", names: ["PERSON_ARG_BYTES = 35;", "valuesOf"] },
      { file: "lib/free.ts", names: ["Math.ceil(MAX_LEADS / 500) + 10"] },
      { file: "lib/store-export.ts", names: ["listValuesShape(store)"] },
      { file: "lib/free.ts", names: ["contacts * fields * PERSON_ARG_BYTES", "Math.ceil(contacts / LIST_VALUES_PER_READ) * fields", "LIST_VALUES_PER_READ = 1_000;", "readValues(LIST_VALUES_PER_READ)", "if (!valued.has(email)) waiting.add(email);"] },
      { file: "lib/joined-stores.ts", names: ["QUARTERS_KEPT", "PERSON_RECORD_MONTHS"] },
      { file: "lib/plan-closing-rules.ts", names: ["DEL_BATCH", "FOLLOW_BATCH", "RENEWALS_AT_ONCE"] },
      { file: "tests/store-data-registry.ts", names: ["closingBytes", "followedBytes", "TRIAL_UNITS"] },
      { file: "lib/data-families.ts", names: ["FOLLOWED_FAMILIES", "CLOSING"] },
      { file: "lib/order-data.ts", names: ["ORDER_KEY_BYTES"] },
    ],
    basis: "Once for each store, so against each of its payments: a store that paid one month and closed carries all of it in that month's margin. Its keys deleted, the room's at the fewest bytes a key it counts can weigh and the rest at a mark's, DEL_BATCH at a command, each name sent back once: no longer than KEY_NAME_BYTES, and never more than that share of a key beside the ORDER_KEY_BYTES the room charges it, which the registry counts beside every key too (what Redis keeps beside it); its ENDED_STORE_EXPORTS whole exports once its plan has ended, its own and never refused, each at the largest store there can be: its room and its record, every product, course, lesson, post and form there can be, read together, and every page of its sales at Stripe; its ENDED_LIST_DOWNLOADS list downloads once its plan has ended, its own and never taken from its studio figure, each at the largest list its room and its record can hold (endedListDownloadCost); what its followers read, the room and what they read outside it, FOLLOW_BATCH entries at a command; and its last steps' commands, for its owner and every one of its team as a host. The walk's own time is its schedule's. Its id left in a person's records across stores that are the company's (the lists they joined, an affiliate's hub: tests/store-data-registry.ts) is the company's as those records are, and runs out with the quarter it was written in (lib/joined-stores.ts).  Reading the whole database to find its keys is the company's, a scheduled job bounded by its schedule (docs/funded-exposure-review.md). What an order leaves for it, a buyer's library entry and a renewal to stop, is in the order's cost (ORDER_COST); what it writes once its plan has ended is a store that pays nothing's, in the share of those (nonPayingWorst). A store its owner deletes from the studio (lib/store.ts deleteStore) takes the same walk instead, once, and never also closes, since its record goes with it: its marks read and its entry written under its lock (queueDeleted, the same reads as prepareStore's), its record read again and its entry rewritten or dropped when a walk begins (admitDeleted), each in one script and only over the exact entry read (BATCH_SWAP: the same one command as the plain write it replaces, with Lua's own HGET inside it), and its keys deleted and followed as a closed store's, with no export and no closing record; so its cost is this line's, already in its payments' worst case or, for a store that never paid, in nonPayingWorst (closureCost(\"creator\", true)), and its commands are within PREPARE_COMMANDS: its marks' reads within the hundred, and none of the (1 + MAX_TEAM) × (2 × 50 + 5) a closing store's hosts' claims take, in whose place its admission, once its record reads gone, does again what its delete does after the record (Claude 6's two LOWs and reviewer C3 on #3670): one DELETED_HOLD script for each address that still led to it (MAX_ADDRESSES at the most) and four removals (settleDeletedStore), and its webhooks, API keys and assistant notes forgotten once more (forgetBoth, FORGET_TRY_COMMANDS less the line's four) or, when that fails, the line's own commands (queueStoreForget, within those four), so at most 1 + MAX_ADDRESSES + 4 + FORGET_TRY_COMMANDS + 1 commands an admission, run again only on a run after one not confirmed. Its later tries in that line are the company's, as a delete's are (FORGET_TRIES).",
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
 * Then the record's going (lib/store.ts, closeStoreRecord): the store's lock
 * (SET NX, tried again for LOCK_WAIT_MS: at most STORE_LOCK_TRIES), the record
 * read again (GET), the walk's entry written again, no longer pending (HSET),
 * its id taken out of its account's list at the address the record read again
 * names too (one more SREM: an account moved since), the record deleted only
 * while the lock is still held (EVAL, GET, DEL) and the lock let go (EVAL,
 * GET, DEL).
 */
export const CLOSE_RECORD_COMMANDS = STORE_LOCK_TRIES + 1 + 1 + 1 + 3 + 3;
/**
 * The walk's own read of a prepared store's record before it starts (lib/closed-store-data.ts startableBatch: one GET
 * per entry), so it never walks a store whose record is still there (Codex L, Codex P and Claude 2 cloud L on #3643).
 */
export const WALK_START_READ_COMMANDS = 1;
/**
 * A closing store whose plan reads running (paid or in trial) has its place in the final closing line read before
 * anything of it is touched (lib/closed-store-data.ts prepareStore: one ZSCORE), so a store whose plan runs again is
 * never erased while its closing day has not begun (Claude 5's MEDIUM on #3643). Read again under the store's lock from
 * the record closeStoreRecord already reads and the ZREM's own answer: no command more.
 */
export const PLAN_RUNS_READ_COMMANDS = 1;
export const PREPARE_COMMANDS = (1 + MAX_TEAM) * (2 * 50 + 5) + 100 + CLOSE_RECORD_COMMANDS + WALK_START_READ_COMMANDS + PLAN_RUNS_READ_COMMANDS;

/** What the whole export reads at the most, for a store of `bytes`: every product, course, lesson, post and form there can be, each read together, and its contacts a thousand at a command, each page with a read of the store's fields' values for its people a field (lib/store-export.ts). */
export function exportCommands(bytes: number): number {
  // Every lesson there can be: one with no text takes next to nothing of the room, and is read all the same.
  const lessons = MAX_PRODUCTS * MAX_LESSONS;
  // The contacts' pages: a thousand at a command, as many as the room can hold and never more than lib/free.ts, listAsCsv, reads (MAX_LEADS).
  const contacts = Math.min(Math.ceil(bytes / 100 / 1000), MAX_LEADS / 500 + 10);
  // The people's values, one HMGET a field for each thousand of them, never more than the walk's pages (lib/free.ts, LIST_VALUES_PER_READ; lib/crm.ts, valuesOf; second and third cost reviews of #3354).
  return Math.ceil(EXPORT_COMMANDS.fixed + 3 * Math.ceil(MAX_PRODUCTS / 100) + Math.ceil(MAX_PRODUCTS / 100) + Math.ceil(lessons / BODIES_PER_READ) + Math.ceil(MAX_POSTS / 100) + EXPORT_COMMANDS.form * MAX_FORMS + contacts * (1 + MAX_CRM_FIELDS));
}

/**
 * The bytes a whole export or a list download of a store of `bytes` sends to
 * read its fields' values: each person's key with each field (lib/crm.ts,
 * valuesOf, PERSON_ARG_BYTES), for as many people as its room can hold, never
 * more than MAX_LEADS, at a hundred bytes a contact as exportCommands counts
 * them (second cost review of #3354).
 */
export function valueArgBytes(bytes: number): number {
  return Math.min(Math.ceil(bytes / 100), MAX_LEADS) * MAX_CRM_FIELDS * PERSON_ARG_BYTES;
}

/** What one whole export of a store of `bytes` costs at the most: its reads, the keys it sends for the fields' values, its time at 2 GB (a step's ten seconds for every 20 MB), and one list of its sales at Stripe waited on page by page, the other read beside it. */
export function exportCost(bytes: number, commands = exportCommands(bytes)): number {
  return request("heavy", commands, bytes + valueArgBytes(bytes)) + Math.ceil(bytes / 20_000_000) * request("step", 0) + (EXPORT_STRIPE_PAGES / 2) * EXPORT_PAGE_SECONDS * MEMORY_SECOND;
}

/**
 * What one list download costs at the most once a plan has ended
 * (lib/list-download.ts, holdEndedListDownload), its list as large as a store
 * of `bytes` can hold: every page the walk may take (lib/free.ts, listAsCsv,
 * up to MAX_LEADS / 500 + 10, whatever COUNT a page honors), each with one
 * read of the store's fields' values for its people a field (lib/crm.ts,
 * valuesOf), and its own reads (twenty commands); every byte of the store
 * read twice and sent twice (a review ceiling: the file's text is never more
 * than twice what it is read from, and a value is read for a person on the
 * list only), each person's key sent with each field (valueArgBytes); and
 * its time as a whole export's, a step's ten seconds for every 20 MB.
 */
export function endedListDownloadCost(bytes: number): number {
  const commands = 20 + (MAX_LEADS / 500 + 10) * (1 + MAX_CRM_FIELDS);
  return request("heavy", commands, 2 * bytes + valueArgBytes(bytes)) + 2 * bytes * ORIGIN_PER_BYTE + Math.ceil(bytes / 20_000_000) * request("step", 0);
}

/**
 * What closing one store costs at the most, once nobody pays for it: a store
 * of this plan, or a free trial's (`trial`, its room and its units). The
 * parts are said in the basis of the line closure.
 */
export function closureCost(tier: Tier, trial = false): { deletes: number; follows: number; exports: number; lists: number; prepare: number; total: number } {
  const room = trial ? NON_PAYING_DATA_ROOM_BYTES.trial : DATA_ROOM_BYTES[tier];
  const roomKeys = room / ORDER_KEY_BYTES;
  const keys = roomKeys + closingBytes(tier, trial) / MARK;
  const outside = followedBytes(tier, trial);
  const names = ((room + closingBytes(tier, trial)) * KEY_NAME_BYTES) / (ORDER_KEY_BYTES + KEY_NAME_BYTES);
  const out = {
    deletes: names * DB_BYTE + Math.ceil(keys / DEL_BATCH) * COMMAND,
    follows: (room + outside) * DB_BYTE + (Math.ceil((roomKeys + outside / MARK) / FOLLOW_BATCH) + FOLLOWED_FAMILIES.length * 4) * COMMAND,
    exports: ENDED_STORE_EXPORTS * exportCost(room + MAX_STORE_BYTES),
    lists: ENDED_LIST_DOWNLOADS * endedListDownloadCost(room + MAX_STORE_BYTES),
    prepare: PREPARE_COMMANDS * COMMAND,
    total: 0,
  };
  out.total = out.deletes + out.follows + out.exports + out.lists + out.prepare;
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
    // Its payday's auto-pay takes no integration unit (a press from the studio takes its own, paypalPressUnits).
    + PAYPAL_PRESSES_UNTAKEN * PAYPAL_PRESS
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
      { file: "app/api/store/assistant/route.ts", names: ["\"assist\"", "\"assist-day\"", "\"assist-store\"", "withinStore(\"assist-ask\"", "withinStore(\"assist-read\"", "withinStore(\"assist-handoff\""] },
      { file: "lib/opening.ts", names: ["ASSISTANT_ON_SALE"] },
      { file: "lib/next-offer.ts", names: ["pool(\"reserve\"", "pool(\"settle\"", "pool(\"release\"", "assistantMessageWorstMicroUsd()", "takeBuyerRead(store, NEXT_OFFER_REQUEST_UNITS)", "NEXT_OFFER_KEEP_SECONDS"] },
      { file: "lib/next-offer-rules.ts", names: ["NEXT_OFFER_PRODUCTS", "NEXT_OFFER_CHOICES", "NEXT_OFFER_OUTPUT_TOKENS", "NEXT_OFFER_COMMANDS", "NEXT_OFFER_REQUEST_UNITS", "withinAssistantReply"] },
      { file: "app/api/store/assistant-next/route.ts", names: ["withinStore(\"assist-next-dismiss\""] },
      { file: "lib/assistant-reminder.ts", names: ["pool(\"reserve\"", "pool(\"settle\"", "pool(\"release\"", "assistantMessageWorstMicroUsd()", "takeBuyerRead(store, ASSIST_REMIND_REQUEST_UNITS)", "emailRoom(store, now)", "ASSIST_REMIND_KEEP_SECONDS"] },
      { file: "lib/assistant-reminder-rules.ts", names: ["ASSIST_REMIND_OUTPUT_TOKENS", "ASSIST_REMIND_PRODUCTS", "ASSIST_REMIND_COMMANDS", "ASSIST_REMIND_REQUEST_UNITS", "withinReminderReply"] },
      { file: "lib/checkout-recovery.ts", names: ["remindAssisted", "meter: { by: \"store\""] },
    ],
    basis: "One payment: every reply of the month's pool at its worst (Haiku 5.5 at 24 KiB in and 320 tokens out, the 10% provider allowance, the 45-second wait at 2 GB, and the message's own commands, bytes and day of keeping), the dearer provider's fee on the whole amount charged, the price and the buyer's tax on top at 27% (6.6% + 30 cents, lib/receiving-costs.ts, the one model every plan and add-on is held to since 18 October 2026), a 1.5% remittance allowance, and reserves of one payment in a hundred refunded and one disputed with both $15 fees. The pool is reserved at a message's worst before the store's facts are read or the model is asked, and settled at what was billed (at what the reads cost when it stops before the model or the provider refused), so no month can spend past it; every question is also one public request of the plan's window (withinStore with the scope assist-ask, line public-requests), so a question refused for a spent pool, or handed over by its words with no model, reads nothing of the catalog and is a request of the plan's own figure; handed-over questions are inbox messages and store emails of the plan's own figures (lines inbox, store-email), refused past them. The next product after a purchase (lib/next-offer.ts) asks the model at most once an order, reserved from the same pool at the same worst cost (its request is inside a chat message's caps: withinAssistantReply), so the pool's month is unchanged; when the pool is spent it chooses by the creator's rules with no model. Its reads and Stripe calls are NEXT_OFFER_REQUEST_UNITS public requests of the plan's window, each priced as a later page (public-requests; NEXT_OFFER_READ in tests/plan-cost-registry.test.ts); its line in the confirmation email is two reads inside the order's ORDER_COMPUTE, and no email of its own. The checkout reminder (lib/assistant-reminder.ts) asks the model at most once a checkout, only for a buyer who checked its box, reserved from the same pool at the same worst cost (its request is inside a chat message's caps: withinReminderReply), settled at what was billed, so the pool's month is unchanged; a spent pool or a failed call sends the fixed reminder with no AI line. Its email is one of the store's own emails (line store-email), checked for room before the model is asked and taken before it is sent, refused past the figure; its reads and two Stripe calls are ASSIST_REMIND_REQUEST_UNITS public requests (ASSIST_REMIND_READ in tests/plan-cost-registry.test.ts); the yes it keeps is under a kilobyte for three days, at most ASSIST_REMINDERS_PER_STORE_DAY a store a day (tests/store-data-registry.ts).",
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

/**
 * One run of the five-minute job that takes group places back, for one store (lib/group-buy.ts, revokeRefundedGroups;
 * Claude 7's MEDIUM on #3410), in Redis commands and Stripe calls, held to what the real job sends in its worst run by
 * tests/group-buy-refunds-cost.test.ts:
 * - jobCommands: the run's own commands, whatever the rows: the four GETs of its start (the store's mark, anchor, pass
 *   and the account the anchor is of), the five of a switch to an account with no anchor (ZSCORE, ZRANGEBYSCORE, two
 *   ZADD, ZREMRANGEBYRANK), the retry list's HGETALL, the three of its place in the lost disputes (GET, SMISMEMBER of
 *   the read set, SET or DEL) and one write a page read (the pass's SET, or the EVAL that ends it), at most ten pages;
 * - chargeLookups (CHARGE_REFUND_LOOKUPS) charges asked a run (GET /refunds?charge=), each with commandsPerLookup
 *   commands: one GET of its purchase's held mark before and one SET EX after; a part past them holds with none;
 * - lostDisputePages (LOST_DISPUTE_PAGES) pages of closing events (GET /events);
 * - commandsPerOtherRow: a row (a refund, a lost dispute or a retry entry) of a payment that paid for no group purchase
 *   (SISMEMBER, GET, SADD, EXPIRE; a retry entry one HDEL more). A group row's own commands (a refund on its way: two,
 *   and one SET NX of its alert mark over a week; one going through: the work that takes its places back, once a
 *   purchase) are the rows' and the purchases', bounded by the pages read.
 * Why they are the five-minute job's, not a plan's: NOT_A_COST.CHARGE_REFUND_LOOKUPS.
 */
export const GROUP_REFUND_RUN = { jobCommands: 23, chargeLookups: 10, commandsPerLookup: 2, lostDisputePages: 3, commandsPerOtherRow: 4 } as const;

/**
 * The PayPal watch of a store whose creator disconnected PayPal (lib/store.ts, paypalPast; lib/paypal-delivery.ts,
 * sweepPayPal; Claude 7, 12 November 2026), held to what the real sweep sends by
 * tests/paypal-disconnected-window.test.ts:
 * - countReadsPerStoreRun: before anything else, one round trip of three ZCARD (pending payments, paid orders watched
 *   for a refund, paid orders owed their hand-over), every run while the account is kept;
 * - forgetWritesAtMost: when the three lists are empty and PAYPAL_OPEN_ORDER_SECONDS (three days, how long an order
 *   opened before the disconnection can still be approved) have passed, or the window is over, the kept account is
 *   forgotten with one store write (lib/store.ts, forgetPayPalPast) and the store is no longer swept for PayPal from
 *   the next run on (review of #3924, MEDIUM);
 * - windowSeconds: the account is kept at most PAYPAL_PAST_SECONDS (180 days, PayPal's refund window, the same as a
 *   paid order's watch) after the disconnection;
 * - studioCountReads: the studio's notice (components/paypal-waiting-notice.tsx) reads one ZCARD a page view, only
 *   while the account is kept.
 * While orders are left, the sweep then costs what a connected store's does (PAYPAL_WATCH_RANGES, HAND_OVER_BATCH),
 * so a disconnected store adds 3 commands a run to that, for at most windowSeconds; a store that never disconnected,
 * or whose lists are empty, adds nothing after those three days. Why it is the five-minute job's, not a plan's:
 * NOT_A_COST.PAYPAL_PAST_SECONDS.
 */
export const PAYPAL_PAST_WATCH = { countReadsPerStoreRun: 3, forgetWritesAtMost: 1, windowSeconds: 180 * 86_400, studioCountReads: 1 } as const;

/**
 * The PayPal watch's capture reads for one order (lib/paypal-sales.ts, watchPayPal, nextLook and unknownLook; Claude 2
 * on #4536), held to what the real watch asks by tests/paypal-watch-unknown-looks.test.ts, each sweep run at the
 * moment the order is next due:
 * - looksPerOrderWatched: an order whose capture stays standing is asked hourly for 7 days, every 6 hours to day 30,
 *   then daily to the end of the watch's 180 days, and leaves the watch;
 * - lateLookSeconds, lateLooksPerOrder: an order whose capture PayPal answers in a status the watch does not read (or
 *   about another capture) is never dropped, so after the watch's days it is asked every lateLookSeconds
 *   (LATE_LOOK_SECONDS) until its paid record ends at 400 days: at most lateLooksPerOrder more reads. Before this it
 *   was asked hourly to the end, about 9,600 reads an order.
 * A read PayPal fails, or a paid record Redis does not answer, is still looked at again in an hour; those are not
 * counted here, so they are not certified, never zero. Like the rest of the five-minute job (NOT_A_COST.PAYPAL_WATCH_BATCH),
 * a company fixed cost, not a plan's allowance, and not yet a dollar line of lib/llc-fixed-costs.ts.
 */
export const PAYPAL_WATCH_LOOKS = { looksPerOrderWatched: 410, lateLookSeconds: 30 * 86_400, lateLooksPerOrder: 8 } as const;

/**
 * Zoom's notice that a user removed the app (app/api/integrations/zoom/deauthorize, forgetUser in lib/meet-connect.ts;
 * Claude 7's MEDIUM 2 on #3333): a company cost, never a plan's, since Zoom sends it and no store asks for it. Each
 * notice at its most:
 * - guardCommands: the route's own guard, withinLimit's INCR and EXPIRE, claimMark's SET NX and its read back, and
 *   releaseMark's script (EVAL, GET, DEL) when the notice is let go for Zoom's retry;
 * - forgetFixedCommands: the deletion's mark (SET ... EX GONE_SECONDS) and the read of the user's stores (SMEMBERS),
 *   one pipeline;
 * - for each of at most storesPerPass (FORGET_PASS) stores: its renewal lock tried lockTries times in lockWaitMs
 *   (lib/redis-lock.ts takeLock, waits of 20 ms doubling to 250 ms), then storeCommandsAfterLock: the connection's
 *   GET, its DEL, the test mark's DEL and the store's SREM from the index, and the lock let go (EVAL, GET, DEL);
 * - markBytes kept markSeconds: the mark's key (58 bytes) and its value (at most the 16 digits KEEP_UNLESS_GONE
 *   reads), rounded up, one mark a Zoom account.
 * Bounded per sending address by the route's PER_MINUTE (noticesPerAddressMinute); a notice signed again by Zoom is a
 * new one. The bytes of the connections and the index read back are not in this line (their size is Zoom's tokens and
 * the account's stores): open, never zero. Held to the code by tests/zoom-notice-cost.test.ts; not yet a dollar line
 * of lib/llc-fixed-costs.ts.
 */
export const ZOOM_NOTICE_FORGET = {
  noticesPerAddressMinute: 120,
  guardCommands: 7,
  forgetFixedCommands: 2,
  storesPerPass: 50,
  lockWaitMs: 9_000,
  lockTries: 39,
  storeCommandsAfterLock: 7,
  markBytes: 128,
  markSeconds: 86_400,
} as const;
/** ZOOM_NOTICE_FORGET priced at the registry's rates: one notice at its most, and an address's minute at its most notices. */
export function zoomNoticeForgetCost(): { perNoticeUsd: number; perAddressMinuteUsd: number } {
  const z = ZOOM_NOTICE_FORGET;
  const commands = z.guardCommands + z.forgetFixedCommands + z.storesPerPass * (z.lockTries + z.storeCommandsAfterLock);
  const perNoticeUsd = commands * COMMAND + z.markBytes * DB_BYTE_MONTH * (z.markSeconds / (30 * 86_400));
  return { perNoticeUsd, perAddressMinuteUsd: perNoticeUsd * z.noticesPerAddressMinute };
}

/** Per-use costs that no monthly figure bounds yet: not in worstCost, so nothing here is certified. */
export type OpenItem = { id: string; what: string; names?: string[] };
export const OPEN: OpenItem[] = [];

/** Exported limit or cost constants that are not a per-store monthly cost, and why. */
export const NOT_A_COST: Record<string, string> = {
  HOLDS_PER_ADDRESS: "lib/stock.ts: how many limited units one connection may hold on a store within one hold's time, an abuse bound that keeps a never-paying connection from holding a drop. Not a plan allowance; each press is still counted by the checkout's own lines.",
  TURN_LIMITS: "lib/studio-agent-rules.ts (631 [AA1], studio assistant, unit 1): the byte, step and token ceilings of one turn of the studio's assistant, pure rules. Nothing calls the model yet. They bound turnHoldMicroUsd, the whole turn at its most, which a turn reserves from the store's monthly AI budget (line ai, AUTOMATIC_AI_STORE_MICRO_USD) before its first call once a later unit wires it. Not a monthly figure of its own; unknown cost is not zero, and the wiring unit must cite its route here.",
  MEMORY_FORGET_COMMANDS: "lib/assistant-memory-store.ts forgetMemory is shared by three direct callers, not exclusively a company obligation. app/api/store/assistant-memory/route.ts POST forget belongs to an active store: guardStoreWrite(settings) reaches studioAccess/countStudio and takes one studio request before the operation; this caller and constant are cited by COST_LINES studio. app/api/store/stores/route.ts first attempts store-deletion cleanup after its essential delete admission. lib/store-forget-retry.ts later retries that deleted store as a company obligation, not as another active-store request. The constant bounds outer dispatches only: the measured lock path is eleven SET attempts plus three EVAL dispatches, deleting at most MAX_STORED_MEMORY_BYTES (55,264 bytes) without reading the note payload. Its 87-byte sample is a JSON-serialized stub reply, not RESP, wire or billed bytes. Lua-internal calls and expired data-room month cleanup are additional; sixteen is not a complete supplier invoice ceiling. The studio source citation records existing admission, not proof that its full command or function-time budget covers the lock wait. Complete active-store and company runtime, Lua and funding remain unknown, never zero; this shared exported constant is not a separate monthly allowance or margin approval.",
  FORGET_TRY_COMMANDS: "lib/store-forget-retry.ts forgetBoth adds assistant-note deletion to webhook and API-key cleanup. This is a company obligation after the original essential deletion request, not a per-plan allowance. The declared formula includes MEMORY_FORGET_COMMANDS but does not certify Lua-internal command costs, bytes, runtime or retention; its complete fixed-cost ceiling remains unknown and cannot approve a finite company base.",
  FORGET_TRIES: "lib/store-forget-retry.ts permits eight total attempts per deleted store in one round in its line, including the original deletion. Up to seven later company attempts can repeat assistant-note cleanup. The closing walk's admission of a deleted store (lib/closed-store-data.ts admitDeleted) makes one more attempt and, when it fails while the line no longer holds that store, starts another round; the number of rounds is bounded only by the walk's admissions, one a run while its replies are not confirmed. This bounded work count is not a funded global case/retention or read-byte ceiling; costs remain unknown, never zero.",
  FORGET_PER_RUN: "lib/store-forget-retry.ts limits work to twenty-five stores per daily closing run, but first reads the entire active queue with HGETALL. The synthetic 2,000-row expired-deadline control produces a 166,893-byte JSON-serialized stub reply (not RESP, wire or billed bytes) and does no cleanup work. Twenty-five is not a queue-read byte bound. Complete queue, Lua, runtime, retention and company funding remain unknown; no finite fixed-cost or plan margin certification follows from this classification.",
  STATUS_VIEWS_PER_HOUR: "Requests in an hour, for the whole site, that read the runs on the public status page (247 [SP4] unit 2, lib/status-page.ts): not a plan's cost, since the page belongs to no store; a company cost under MR item 2, every kind of request priced at the rates of lib/spend-cost-table.ts and tests/traffic-cost.ts, held by tests/status-page.test.ts.",
  STATUS_COUNTS_PER_ADDRESS_PER_HOUR: "Times one address may make one server instance count a request on the public status page in an hour (247 [SP4] unit 2, lib/status-page.ts, lib/local-limit.ts): a pace that only refuses, held in memory at no cost, so one client cannot use up the hour's reads; the page's cost is the company's, priced in tests/status-page.test.ts.",
  REPLY_FILE_LIMITS: "The kinds and the largest size of one file a creator may attach to a reply to a buyer's submission (750 [CD1] unit 1, lib/submission-rules.ts, pure rules with no I/O): not an allowance and not metered. The file's bytes are reserved against the plan's own storage before its upload is authorized (preauthorizeSubmission, the same arithmetic as lib/storage-reservations.ts), and its upload starts and requests come from the monthly upload allowance (lib/upload-budget-policy.ts), both already priced per plan. Nothing reads, stores or sends anything in unit 1; the routes, the email for each reply and the video transfer when a file is watched get their cost lines with the units that add them, and that transfer is unmeasured, unknown, never zero.",
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
  LAUNCH_HOLD_SECONDS: "How long a waitlist launch may wait, from its start, while its store is switched off after notices (lib/waitlist.ts, runLaunches and holdLaunch): a scheduled job, bounded by its schedule (a company fixed cost), adding no email (nothing is reserved or sent while held). Each held run takes, beyond the GET of the launch's record and the store read it already made, one pipeline of two EXPIRE (its send list and its record), read exactly; once the bound passes (or a renewal reads in another shape in the hold's last week), one LRANGE of the addresses already handled and one pipeline of SET, HDEL, DEL and SREM, once a launch. While a launch sends, every batch after a run's first reads the store again (storeForHandle, two GET), so a switch-off stops the rest of the run: at most one read per LAUNCH_BATCH emails, inside the same deadline; each batch's record write renews its send list in the same pipeline (one EXPIRE per LAUNCH_BATCH emails), so the list never lapses while the record lives. Like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  MAX_PAGES_PER_STORE: "Pages of Stripe Checkout Sessions (GET /checkout/sessions, up to 100 each) the five-minute job reads per store per run in each of its two walks of the last day (lib/checkout-sweep.ts, walkDay; audit A2, 9 November 2026): the completed checkouts on every store it sweeps, and the expired ones on a store with reminders or a list, never the open ones. So at most 2 x 3 = 6 list calls each time a store is swept; a run sweeps a store once, unless Redis's SCAN hands its key back on another page (#3064 makes that once a run too), so with one sweep a run 2 x 3 x 288 = 1,728 a UTC day, 55,296 a billing month of 32 UTC days; Stripe bills no API call, and each run stops at its deadline. Each walk keeps its place for the next run (nl:sweep:walk:, tests/store-data-registry.ts): one GET a walk and at most one SET or DEL, so at most 4 store commands each time a store is swept, with one sweep a run 1,152 a UTC day, 36,864 a billing month, and only 2 a sweep (the GETs) for a store whose day of checkouts fits in one run; each value at most 220 bytes, kept a day. Held by tests/checkout-sweep-complete.test.ts. Past 3 pages a run, a walk carries on next run instead of reading the same newest pages again, so every session of the day is read in turn; a walk that takes more than an hour to reach the end of the day is said in the log every run it goes on. A scheduled job, bounded by its schedule (a company fixed cost), not a plan's allowance; like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  PLANS_PER_RUN: "Payment plans the daily plans job tries in one run (lib/plans.ts, settlePlans; app/api/cron/plans/route.ts): two read commands a run and, for each plan tried, at most four Redis commands of its own and three calls to the creator's Stripe account (eleven for a plan past its own end with payments to give back: its paid invoices from the end on, the balance, and for at most three of them the refunds made and the refund, lib/plan-late-refunds.ts), inside a 25-second share of the run (PLAN_SETTLE_RUN, held by tests/payment-plan-stuck.test.ts). A plan its account refuses is tried at growing intervals for PLAN_GIVE_UP_DAYS, then once every PLAN_STUCK_RETRY_DAYS until the account answers (never let go), its creator emailed once (tellCommandsPerPlan; the email is the store's own, from its email figure); a payment after its end owed back for PLAN_OWED_TELL_DAYS tells its creator once the same way, and each buyer whose late payment was given back is emailed once from the store's transactional figure (lateTellCommandsPerPlan, at most lateTellsPerTry a try, lib/plan-late-notice.ts); a failure not its account's is tried at the next run, every try inside the limit. A scheduled job that keeps buyers from being charged past their last payment, bounded by its schedule and the limit: a company fixed cost, not a plan's allowance; Stripe bills no API call, and its Redis commands are not yet a line of lib/llc-fixed-costs.ts, so they are not certified, never zero.",
  REFUND_WATCH_BATCH: "Paid PayPal orders the refund watch looks at for a store in one run of the five-minute job (lib/paypal-sales.ts, watchPayPal; C4-13): one ZRANGEBYSCORE of the store's watch list a run, of PAYPAL_WATCH_BATCH orders (the one batch, priced as a read in NOT_A_COST.PAYPAL_WATCH_BATCH), then for each due order one GET of its capture at PayPal (no dated source here gives PayPal's price per API call: an open gap, never zero), the paid record's GET and one write of the list, each order no more often than nextLook (hourly the first week, then every six hours, then daily; daily until the paid record ends, 400 days, only for a status not known here) (PAYPAL_REFUND_WATCH, held by tests/paypal-reversed-access.test.ts). A scheduled job, bounded by its schedule and the batch, a company fixed cost like HAND_OVER_BATCH, not a plan's allowance; its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  PENDING_SWEEP_BATCH: "Pending PayPal orders the sweep asks PayPal about for a store in one run of the five-minute job (lib/paypal-sales.ts, watchPayPal; Claude 6's second money review of #3392): one ZRANGEBYSCORE of the store's pending list a run, of PAYPAL_WATCH_BATCH orders (the one batch, priced as a read in NOT_A_COST.PAYPAL_WATCH_BATCH), then for each order the opened record's and the paid record's GET, one GET of the order at PayPal (no dated source here gives PayPal's price per API call: an open gap, never zero) and at most one write of the list, ZREM or ZADD XX to its back; each order at most 30 days, its opened record's life (PAYPAL_PENDING_SWEEP, held by tests/paypal-reversed-access.test.ts). A scheduled job, bounded by its schedule and the batch, a company fixed cost like REFUND_WATCH_BATCH, not a plan's allowance; its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  HAND_OVER_BATCH: "PayPal orders still owed their hand-over that the five-minute job's sweep of a store tries again in one run (lib/paypal-delivery.ts, handOverAgain; #2909): one ZRANGEBYSCORE of the list a store with PayPal a run, then for each order tried at most four commands of its own (GET of the paid record, ZSCORE of the refund mark, at most two ZREM or ZADD of the list) besides the hand-over's own work, which is the order's (line orders): at most 1 + HAND_OVER_BATCH x 4 commands of its own a store a run, and at most HAND_OVER_BATCH hand-overs tried, each order at most once a run (PAYPAL_HAND_OVER_RETRY, held by tests/paypal-handover-cost.test.ts). A receipt the sender did not accept reruns its order's hand-over at most receiptTriesPerOrder times in its window, each try at most commandsPerReceiptTry commands (PAYPAL_RECEIPT_RETRY_COMMANDS an order), and at most one request a sender attempt through the one sender kept for it. The same sweep's watch of PayPal refunds (watchPayPal, lib/paypal-sales.ts) reads, for each payment refunded in full that it tells the store's webhooks of, the person's own-deletion note once (PAYPAL_REFUND_TOLD); its other per-order commands are REFUND_WATCH_BATCH and PAYPAL_REFUND_WATCH. A scheduled job, bounded by its schedule and the batch, a company fixed cost like MAX_PAGES_PER_STORE, not a plan's allowance; like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  OUTBOX_PER_RUN: "Webhook events noticed once (a free copy's confirmed address, a list sign-up) that could not be queued when they happened, given to emitEvent again by the five-minute job (lib/webhook-outbox.ts, replayKept; #4284, #4275): one ZRANGEBYSCORE a run (OUTBOX_JOB_COMMANDS), then at most OUTBOX_PER_RUN events a run, each at most OUTBOX_COMMANDS_PER_EVENT commands of its own besides emitEvent's, which is the event's own as when it is queued at once; each kept at most a week (OUTBOX_KEEP_SECONDS) and at most OUTBOX_RECORD_MAX_BYTES, and at most OUTBOX_MAX_KEPT kept at once in the whole site (a company ceiling counted in the write that keeps one, past which the event is let go and said: at most 4 MB of records and as many members in line, held by tests/webhook-outbox.test.ts), waiting twice as long after each failed try (OUTBOX_FIRST_WAIT_SECONDS, never past a day). Keeping one costs the request that noticed it two commands more, only when its queueing failed. A scheduled job, bounded by its schedule and the batch, a company fixed cost like MAX_PAGES_PER_STORE, not a plan's allowance; its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  STRIPE_LOOKUPS_PER_STORE: "Calls to the creator's Stripe account the five-minute job makes per store per run to tell whose a refunded charge is and to read a canceled member's address (lib/webhooks.ts, watchStore): a scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call, and a membership's charge (three calls) is taken from the same ten, so no run asks more than before.",
  DEMO_SESSIONS_PER_DAY: "Sessions the whole site may open in a day, the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_COMMANDS_PER_DAY: "Database commands the demo's accepted openings and actions together may send in a day (refusals are priced apart, DEMO_REFUSALS_PER_DAY), reserved at the worst before a session opens: the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_SESSIONS_PER_ADDRESS_PER_DAY: "Demo sessions one address or network may open in a day: a pace that only refuses, inside the day's caps of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_SESSION_WORST_COMMANDS: "The most commands one demo session can send, reserved whole when it opens: inside the day's commands of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSALS_PER_DAY: "Refused demo requests counted in a day, past which the door answers after its reads (one, or two for a made-up cookie) and writes nothing: priced at their worst in the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSALS_PER_ADDRESS_PER_DAY: "Refused demo requests one address or network may count in a day, each counted for the whole site only inside it, so one address cannot spend the day's DEMO_REFUSALS_PER_DAY: a pace that only refuses, inside the day's counted refusals of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSALS_PER_SESSION: "Refused actions one live demo session may count in its own record, whoever shares its address, past which its next actions are answered after one read and write nothing: priced with each day's openings in the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  DEMO_REFUSAL_WORST_COMMANDS: "The commands one refused demo request sends at the most, priced with the refusals of the studio demo without sign-up (256 [KJ1], lib/studio-demo-rules.ts; off while STUDIO_DEMO_ON is false): not a plan's cost, since a demo session belongs to no store; a company exposure under MR item 2, priced in docs/studio-demo.md ($1.53 a day at the most, held by tests/studio-demo-rules.test.ts) and covered from the minimum base, with its line in docs/funded-exposure-review.md needed before it is turned on.",
  CHARGE_REFUND_LOOKUPS: "Charges whose refunds the five-minute job that takes group places back reads in one run for one store (lib/group-buy.ts, revokeRefundedGroups, chargeRefundsSettled): one GET /refunds?charge= of one page of up to 100, only for a succeeded part refund of a payment that paid for a group purchase on a charge read refunded in full without covering it by itself, after the handled mark and the payment's purchase were read (no extra store command), so at most CHARGE_REFUND_LOOKUPS calls a store every five minutes, inside the run's deadline; a part past it holds the anchor and is read next run. Each charge is asked once a run at most (a second part of it reads the run's answer), and one found with a part on its way is asked again only after CHARGE_HELD_RECHECK_SECONDS (an hour): one GET of its purchase's held mark before a lookup (none once the run's lookups are spent) and one SET EX after a lookup that found it held. The same job's other store commands a run, besides the refund rows: the GET of the store's mark, anchor, pass and the account the anchor is of (one pipeline of 4); with no anchor of the store's account today, one ZSCORE and one ZRANGEBYSCORE of the accounts left, then up to two ZADD and one ZREMRANGEBYRANK, at most REFUND_ACCOUNTS_KEPT (16) members; the HGETALL of the retry list; the GET, SMISMEMBER and SET or DEL of its place in the lost disputes; the SET of the pass after each page read; one EVAL at the pass's end; and, for a group refund on its way over a week, one SET NX EX of its purchase's alert mark. So at most GROUP_REFUND_RUN.jobCommands (23) + 2 x CHARGE_REFUND_LOOKUPS (20) = 43 commands of the job's own a store a run, whatever the rows, 43 x 288 runs a UTC day x 32 UTC days = 396,288 a store a billing month, plus GROUP_REFUND_RUN.commandsPerOtherRow (4) for each row read of a payment that paid for no group purchase (held by tests/group-buy-refunds-cost.test.ts). A scheduled job, bounded by its schedule (a company fixed cost) like MAX_PAGES_PER_STORE, not a plan's allowance; Stripe bills no API call. Like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  PAYPAL_PAST_SECONDS: "How long after a creator disconnects PayPal the five-minute job still asks PayPal about the orders it took (lib/paypal-sales.ts, paypalMerchant; lib/paypal-delivery.ts, sweepPayPal; Claude 7, 12 November 2026): 180 days, PayPal's refund window, the same as a paid order's watch (nextLook). Each run first counts the store's three PayPal lists with three ZCARD in one round trip; with none left, once three days have passed since the disconnection (PAYPAL_OPEN_ORDER_SECONDS: an order opened before it can still be approved until then), the kept account is forgotten (one store write) and the store leaves the sweep; with some left the run costs what a connected store's does (PAYPAL_WATCH_BATCH, HAND_OVER_BATCH). So at most 3 x 288 runs a UTC day x 32 UTC days = 27,648 commands a disconnected store a billing month on top of those, for at most 180 days, plus one ZCARD a studio page view while the account is kept (PAYPAL_PAST_WATCH, held by tests/paypal-disconnected-window.test.ts). A scheduled job, bounded by its schedule, the window and the batches, a company fixed cost like MAX_PAGES_PER_STORE, not a plan's allowance; like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  PENDING_GIVE_UP_SECONDS: "How long after its order was opened a PayPal payment PayPal never confirmed is canceled (lib/paypal-sales.ts, watchPayPal and cancelOrder; Claude 7, 12 November 2026): 29 days, one day before the pending order's record ends (30 days, watchLater), so the cancellation runs while the record still says which store, product and price it was. A time, not a cost: the order was already on the pending list, read under PAYPAL_WATCH_BATCH; its cancellation adds once per order one round trip of two commands (SET NX of its mark, CANCELED_KEPT_SECONDS; ZADD NX on the notice queue) and one of two (ZREM, DEL), and one ZREM of the queue once its buyer's notice went, besides its notices (CANCEL_NOTICE_TRIES). Never zero: those commands are the job's, uncounted in dollars like its other per-store work.",
  CANCEL_NOTICE_TRIES: "The most times a canceled PayPal order's buyer notice is tried (lib/paypal-sales.ts, cancelOrder and retryCancelNotices; lib/paypal-cancel.ts, tellCanceled; Claude 7, 12 November 2026): 1 + CANCELED_KEPT_SECONDS / CANCEL_NOTICE_EVERY_SECONDS = 121, the first at the cancellation and then one every six hours only while the sender certainly refused it (\"refused\": nothing sent); one the sender took, or may have taken (\"uncertain\"), is never tried again, so at most one buyer notice delivered an order. The creator's notice is tried the same way, on its own place in the queue, so at most one creator notice delivered an order too. Each under its own idempotency key (nimbus-paypal-cancel: and nimbus-paypal-cancel-creator: with the order). They are counted as the order's emails (meter \"order\", EMAIL_SITES): an order canceled this way never gets its receipt, because its record is let go with the cancellation, so they take the place of the order's confirmation and its second email. A refused try sends nothing; its commands (one GET of the mark, one ZADD or ZREM of the queue, one store read) are the job's. Never zero.",
  CANCELED_KEPT_SECONDS: "How long a canceled PayPal order's mark is kept (lib/paypal-sales.ts, canceledKey; Claude 7, 12 November 2026): 30 days, at most one key of about a kilobyte an order canceled (nl:ppsell:canceled: in tests/store-data-registry.ts). It bounds the notice's tries (CANCEL_NOTICE_TRIES) and is read by the page a buyer comes back to (app/[handle]/thanks/page.tsx, canceledFor): one GET a view, only when the order is neither paid nor pending, inside the page's own thanks-view limit. A time, not a plan's allowance; never zero.",
  CANCEL_NOTICE_EVERY_SECONDS: "How long after the sender refused a canceled PayPal order's buyer notice it is tried again (lib/paypal-sales.ts, retryCancelNotices; Claude 7, 12 November 2026): six hours, so at most 4 tries an order a day and CANCEL_NOTICE_TRIES in all. A time, not a cost; never zero.",
  CANCEL_NOTICE_BATCH: "The canceled PayPal orders' buyer notices one run of the five-minute job tries again, for every store together (lib/paypal-sales.ts, retryCancelNotices, called once a run by lib/checkout-sweep.ts): one ZRANGEBYSCORE of the queue a run (288 a UTC day, 9,216 a 32-day month, for the company, not a store), with LIMIT 0 25, then for each due order at most one GET, one store read, one send try and one ZADD or ZREM. A scheduled job, bounded by its schedule and the batch, a company fixed cost like MAX_PAGES_PER_STORE, not a plan's allowance; like the job's other work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  PAYPAL_WATCH_BATCH: "PayPal orders the five-minute job's sweep of a store with PayPal reads from each of its two lists in one run (lib/paypal-sales.ts, watchPayPal; Claude 5 on #2909): one ZRANGEBYSCORE of the pending payments and one of the orders due a refund look, each with LIMIT 0 PAYPAL_WATCH_BATCH, so 2 commands a store a run, due orders or not, and each reply at most PAYPAL_WATCH_BATCH order ids (at most 36 characters each); a store is swept at most once a run (lib/checkout-sweep.ts walks the list of stores once, stops at its end or the run's deadline, and skips a store already swept that run when SCAN hands its key back on another page), so at most 2 x 288 runs a UTC day x 32 UTC days = 18,432 of these reads a store a billing month (PAYPAL_WATCH_RANGES, held by tests/paypal-watch-cost.test.ts). A scheduled job, bounded by its schedule and the batch, a company fixed cost like MAX_PAGES_PER_STORE, not a plan's allowance. Not stated here: the commands and PayPal calls of each order read (at most PAYPAL_WATCH_BATCH of each list a run), which are bounded in number by the batch but not yet counted command by command. Like the job's other per-store work, its dollar figure is not yet a line of lib/llc-fixed-costs.ts, so it is not certified, never zero.",
  LOST_DISPUTE_PAGES: "Pages of Stripe's closing events (GET /events, up to 100 each) read per store per run by each of the six five-minute jobs that take things back after a lost dispute (lib/refunds.ts, lostDisputesSince; lib/licence-keys.ts, lib/call-meetings.ts, lib/review-proof.ts, and the checkout sweep's gifts, pre-orders and purchases for several, lib/gifts.ts, lib/preorders.ts and lib/group-buy.ts, asked only of a store that ever sold one; queue 388 [TB14]), so at most 6 x LOST_DISPUTE_PAGES calls a store every five minutes, inside each run's deadline and with no other call per dispute: a scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call. Each lost dispute read becomes one row, handled once (its event id kept as read), with the store commands a refund row of the same job takes (SISMEMBER, SADD and EXPIRE of the read set, or for gifts, pre-orders and purchases for several the SISMEMBER, SADD and EXPIRE of the read set, the GET of the payment's gift, pre-order or purchase for several and the read of that gift, pre-order or purchase for several and of what it gave (GET, HGET or HGETALL), each reply read in its exact shape so a row left unknown is read again next run, at most once a row a run, and the closing write: the key revoked (first the sale's place marked refunded, one HSETNX through the store's room, and one HGET when it already holds a key, lib/licence-keys.ts REFUNDED_SALE; Claude 2's second review of #2868; a full refund still pending marks it PENDING_REFUND_SALE instead and is read again each run until it settles, and when it goes through, or a failed or canceled refund row is read, one EVAL of SALE_SWAP turns that mark final or clears it, never growing the place, after the same payment lookups as a refund row and inside REFUND_LOOKUPS; Claude 2's focal review of #2868; a succeeded refund that is only part of a charge read as refunded in full first reads that charge's refunds, one GET /refunds?charge= of up to 100 rows taken from the same REFUND_LOOKUPS, with no store command, and is held as pending while one of them is still on its way; Claude 2's focal money review of #2868 at 9fa5c95602), the meeting ended, the review marked, the gift, pre-order or places of a purchase for several taken back as for a full refund; for a call refunded in full, the calendar feed's changed mark too: SET, INCRBY and EXPIRE, lib/call-records.ts, markBookingsChanged, at most REFUND_LOOKUPS a store a run), at most 100 x LOST_DISPUTE_PAGES rows a job a run, inside the same schedule and deadline as the refund rows. When there are more than a run may read, the job keeps its place in one key (GET at the start, then, once every row read is handled, one SMISMEMBER of the read set and SET or DEL: 3 commands a run, lib/refunds.ts, lostCursorKey and confirmLostRead; a run that could not handle every row writes nothing) and the next run reads on from there.",
  MEET_REFUND_PLACE_COMMANDS: "The Redis commands one run of the meetings' refund job (lib/call-meetings.ts, refundsOf, in the five-minute meetings job for each store with meetings still to come) sends for its place in the store's refunds, outside the rows it reads: one GET of the anchor and one of the pass, for a store with no anchor yet one SET NX EX of it before Stripe is asked anything (so a first turn that fails still leaves the next one reading from there; pre-review of claude5/call-refund-stores-cursor), its reply read exactly and, when another run wrote one first (null), one GET of that one (Codex X4 on #3462), then at most three writes (at the end of a pass the anchor written, the read set's expiry renewed and the pass deleted; otherwise the pass kept or deleted and the anchor and the read set written or their expiry renewed, so a call's refund held for later never lets them lapse), so at most 7 a store a run where it was at most 3 before; held by tests/call-meetings-refund-pass.test.ts. The pass (nl:meet:rf:<callsId>:pass, one key a store under 400 bytes, kept seven days after it last moved) lets a read longer than a run go on from the last refund read instead of the newest pages again (Claude 5's audit of the Stripe reads, A3; pre-review of claude5/call-refunds-confirmed), so no Stripe page is added: a run still reads at most REFUND_PAGES (2) pages of GET /refunds, one of them the newest page when it resumes a pass, and makes at most REFUND_LOOKUPS (10) checkout lookups. A scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call.",
  MEET_REFUND_ROW_COMMANDS: "The Redis commands one refund row of the meetings' refund job (lib/call-meetings.ts, refundsOf) sends at the most outside the meeting's own closing writes (callRefunded, markBookingsChanged and releaseClaim, as before): one SMISMEMBER of the read set (the refund read before, and the mark of a call's refund held for later), one write of at most three commands (SADD and EXPIRE of the read set, with the SREM of the call mark once handled; or SADD and EXPIRE of the call mark of one held for later, the owner's decision 18), and one SET NX EX of the day's alert for a call's refund on its way more than seven days (at most once a day a charge, nl:meet:rf:<callsId>:said:<charge>); only a row whose refund may end a meeting (on its way, whatever its charge reads, or succeeded on a charge read refunded in full, or a lost dispute) sends any. At most 100 x REFUND_PAGES rows a run, plus the lost disputes' rows (LOST_DISPUTE_PAGES). A scheduled job, bounded by its schedule (a company fixed cost).",
  MEET_CHARGE_READS: "Calls to the creator's Stripe account one run of the meetings' refund job makes to read a charge's refunds (GET /refunds?charge=, up to 100 rows, lib/call-meetings.ts chargeRefundsSettled, at the pinned STRIPE_LIST_VERSION), only for a call's refund that succeeded on a charge read refunded in full without covering it by itself (a refund in parts, the owner's decision 18), each charge once a run, apart from the checkout lookups (REFUND_LOOKUPS), so a part held for later never takes the lookups of new refunds; no store command is sent for it. A scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call.",
  MEET_REFUND_STORES: "The stores one run of the meetings' refund job (lib/call-meetings.ts, readRefunds, in the five-minute meetings job) reads the refunds of, at the most: the 20 whose turn is oldest (the stores never read first, in the order they came in, then the ones read longest ago), so every store with meetings to come has its turn in a known order (before: ZRANGEBYSCORE nl:meet:stores ... LIMIT 0 20 by the last meeting's end took the same twenty every run and the 21st onwards never had a refund read). 20 is a ceiling, not the rate: the meetings get six seconds of the run in all (app/api/cron/mail/route.ts), so the stores really read a run are as many as fit in what is left of them, often five to twelve, and the rotation takes ceil(stores / that) runs; a store not reached keeps its turn, a store whose read failed or that did not read keeps an anchor (written before Stripe is asked, or one a day back), so its next turn reads from there however long the rotation, and a turn that waited more than a day is said in the log once a day. Each store read costs what MEET_REFUND_PLACE_COMMANDS, MEET_REFUND_ROW_COMMANDS, MEET_CHARGE_READS, REFUND_PAGES, REFUND_LOOKUPS and LOST_DISPUTE_PAGES price, as before (at most 20 stores a run before too). Held by tests/call-meetings-refund-stores.test.ts. A scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call.",
  MEET_REFUND_TURN_COMMANDS: "The Redis commands one run of the meetings' refund job (lib/call-meetings.ts, readRefunds) sends on the store list and its rotation, outside each store's own refunds: the ZRANGEBYSCORE and ZREM of the stores whose last meeting ended a day ago (as before), one ZUNIONSTORE and one ZINTERSTORE that keep the rotation (nl:meet:refund-turns, one member a member of nl:meet:stores, no more, with a time each: the list's members a second time, under 100 bytes each, in tests/store-data-registry.ts) in step with the list, one ZRANGEBYSCORE of the stores new to it (at most 1,000) and one ZADD XX GT stamping them with the time they came in, one ZRANGEBYSCORE WITHSCORES of the 20 oldest turns, one ZADD XX of the turns taken, only when the oldest turn waited more than a day one SET NX EX of the day's log line (nl:meet:refund-turns:said): 9 a run at most, where it was 3 before; plus one SET NX EX of the anchor of each store of the turn that did not read (at most MEET_REFUND_STORES, in the same pipeline as the ZADD). Held by tests/call-meetings-refund-stores.test.ts. A scheduled job, bounded by its schedule (a company fixed cost).",
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
  SUPPORT_PER_DAY: "The daily cap on \"Send this to support\" requests (lib/help-support.ts): two company emails each, nothing kept, held in SCOPES (help-support) as a company cost, not a plan allowance.",
  DAILY_CAPS: "The choices of a host's own daily booking cap: how many calls a host takes, not a cost.",
  KIT_PER_DAY: "A daily burst limit under the writing jobs an affiliate kit takes (line ai).",
  PITCHES_PER_DAY: "Outreach pitches are drafts the creator sends from their own mailbox: nothing is sent from here, and reading a business's site is a call out (line integrations).",
  OPENS_PER_DAY: "A daily burst limit on one numbers link: each opening is one of the store's public requests (line public-requests).",
  MAX_RANGES_PER_DAY: "How many time ranges a host may set on one day of the week: a setting, not a use.",
  REQUEST_LIMITS: "How many payment requests a store keeps open and in all: each costs only the store emails it sends (line store-email), the order its payment becomes (line orders) and its record in the data room (line database-storage).",
  NON_PAYING_REQUEST_LIMITS: "The same for a store that pays nothing: its emails and orders are in its own figures (nonPayingWorst), its records in its data room.",
  NON_PAYING_ALLOWANCES: "The figures of a store that pays nothing: in nonPayingWorst (line free-share).",
  PIPELINES_BY_TIER: "How many deal pipelines a store keeps: a setting in one record counted in the store's data room (tests/store-data-registry.ts, nl:crm:pipes:); changing or moving deals are studio requests (line studio), and a deal entering a stage takes one more before its workflow is checked (lib/deal-stage-trigger.ts, STAGE_TRIGGER_UNITS).",
  GIFT_REFUND_PAGES_PER_STORE: "Pages of the creator's refunds (GET /refunds, up to 100 each, newest first) the checkout sweep reads per store per run for gifts (lib/gifts.ts, revokeRefundedGifts; CX-123 rule 24, r24 money inventory item 1), asked only of a store that ever sold one, each page from the last one's final row (starting_after) until has_more is false: at most GIFT_REFUND_PAGES_PER_STORE calls a store every five minutes for gifts, and at most GIFT_REFUND_PAGES_PER_STORE + PREORDER_REFUND_PAGES_PER_STORE for the two together, inside each run's deadline; a run that stops with pages left keeps the anchor and goes on next run from where it stopped (the pass, nl:gift:<store>:refunds:pass, a JSON of under 300 bytes kept a week, in the store's data family and erased with it): one more GET in the run's first read (with the GETs of the sold mark and of the anchor), one SET with EX of the pass for each page read whole with more after it (at most GIFT_REFUND_PAGES_PER_STORE a run), and at the end of a pass one SET of the anchor with one DEL of the pass instead of the anchor's SET alone; a run that resumes a pass reads the newest page first, inside the same GIFT_REFUND_PAGES_PER_STORE pages. Each refund read is one row handled as before, with the store commands a refund row of the same job takes (the SISMEMBER of the read set and the GET of the payment's gift, then for a full refund of one sold here the reads of that gift and of what it gave, the course removal, the writes that take it back and the mark of the row as read, a SADD with the EXPIRE that keeps the read set thirty days from its last mark), each reply read in its exact shape, at most 100 x GIFT_REFUND_PAGES_PER_STORE rows a run instead of 100. A scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call.",
  PREORDER_REFUND_PAGES_PER_STORE: "Pages of the creator's refunds (GET /refunds, up to 100 each, newest first) the checkout sweep reads per store per run for pre-orders (lib/preorders.ts, revokeRefundedPreorders; CX-123 rule 24, r24 money inventory item 1), asked only of a store that ever sold one, each page from the last one's final row (starting_after) until has_more is false: at most PREORDER_REFUND_PAGES_PER_STORE calls a store every five minutes for pre-orders, and at most GIFT_REFUND_PAGES_PER_STORE + PREORDER_REFUND_PAGES_PER_STORE for the two together, inside each run's deadline; a run that stops with pages left keeps the anchor and goes on next run from where it stopped (the pass, nl:pre:<store>:refunds:pass, a JSON of under 300 bytes kept a week, in the store's data family and erased with it): one more GET in the run's first read (with the GETs of the sold mark and of the anchor), one SET with EX of the pass for each page read whole with more after it (at most PREORDER_REFUND_PAGES_PER_STORE a run), and at the end of a pass one SET of the anchor with one DEL of the pass instead of the anchor's SET alone; a run that resumes a pass reads the newest page first, inside the same PREORDER_REFUND_PAGES_PER_STORE pages. Each refund read is one row handled as before, with the store commands a refund row of the same job takes (the SISMEMBER of the read set and the GET of the payment's pre-order, then for a full refund of one sold here the reads of that pre-order and of what it gave, the course removal, the writes that take it back and the mark of the row as read, a SADD with the EXPIRE that keeps the read set thirty days from its last mark), each reply read in its exact shape, at most 100 x PREORDER_REFUND_PAGES_PER_STORE rows a run instead of 100. A scheduled job, bounded by its schedule (a company fixed cost); Stripe bills no API call.",
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
  // An AI suggestion of an import's columns: its model call is reserved in the store's AI budget (line ai, askModel); this only spaces the asks.
  "import-columns": BURST("ai"),
  "countUse:shareMonthKey(opened.id": line("funnel-share"), "countUse:storeMonthKey(statsId": line("funnel-share"),
  "countUse:storeMonthKey(store.statsId": line("funnel-share"), "countUse:storeUseKey(statsId": line("funnel-share"), "countUse:key: string": line("funnel-share"),
  // A copy into another store of the same account (18 October 2026): the destination's own previews and imports, the same line.
  "countUse:storeMonthKey(to.statsId": line("funnel-share"), "countUse:storeUseKey(to.statsId": line("funnel-share"),
  ai: line("ai"), ask: line("ai"), "ask-day": line("ai"), "ask-store": line("ai"), "chat-summary": line("ai"),
  "embed-open": line("embed"), checkout: line("orders"), upsell: line("orders"), "group-place": line("orders"),
  // Tries of a code only for people who bought here before, per connection and store; each read is taken from the public requests first (lib/returning-code.ts).
  "returning-code": BURST("public-requests"),
  // Links one address can be sent by one store in an hour; each email is taken from the store's figure before it goes (lib/returning-code.ts).
  "returning-code-address": METERED_EMAIL,
  book: line("orders"), "paypal-return": line("orders"),
  "podcast-feed": line("visits"), "<dynamic:allowance[0]>": line("visits"),
  "<dynamic:scope>": guard("withinStore and withinService pass their scope on to withinLimit (lib/metered-limits.ts)."),
  "<dynamic:scope: string>": guard("The definitions of withinLimit, withinMonth, withinStore and withinService themselves (lib/request-guard.ts, lib/metered-limits.ts)."),
  api: line("rest-api"), "studio-essential": line("studio"), "studio-paused": line("studio"), "bundle-picker": line("studio"),
  // The studio's one search box (766 [STN13]): its counters, checked before the search's STUDIO_SEARCH_UNITS studio requests are taken and counted inside them when it is answered.
  "studio-search": BURST("studio"), "studio-search-day": BURST("studio"),
  // Sign-in and account security.
  join: ACCOUNT, passkey: ACCOUNT, "google-signin": ACCOUNT, "google-signin-back": ACCOUNT, "passkey-change": ACCOUNT, "passkey-remove-locked": ACCOUNT, "move-ask": ACCOUNT, "two-step": ACCOUNT, "two-step-backup": ACCOUNT, "two-step-change": ACCOUNT,
  "two-step-rescue": ACCOUNT, "recovery-address": ACCOUNT, "recovery-address-change": ACCOUNT, "lost-email": ACCOUNT, "lost-email-ip": ACCOUNT,
  "discord-return": ACCOUNT, "metaads-return": ACCOUNT, "meet-return": ACCOUNT, report: guard("Takedown reports, per connection: a company cost."),
  "stock-hold": guard("Holds one connection may start on a store's limited products within one hold's time (lib/stock.ts, HOLDS_PER_ADDRESS): a bound on held units, not per store use."),
  "mail-ses": guard("The email provider's own notices: a company cost."), "mail-inbound": guard("The email provider's inbound notices, per connection: a company cost; what is sent on to a creator is one of their store's emails (lib/inbound-mail.ts)."),
  "mail-clicked": guard("A click beacon from a store page opened from an email link, which the page itself counts: a few commands and no work, per connection."),
  "stream-hook": guard("The video service's own notices: a company cost."), "zoom-notice": guard("Zoom's own notices: a company cost, priced per notice and per address a minute by ZOOM_NOTICE_FORGET (the deletion's mark kept a day and up to FORGET_PASS stores walked)."),
  "plan-refund": guard("The plan refund route (app/api/billing/refund, 305 [SY1]): at most PER_DAY (10) a store a day, each a bounded Stripe reading (MAX_CALLS) and one write; the money is the reviewed refund exposure (docs/funded-exposure-review.md), a company cost."),
  "plan-withdraw": guard("The plan withdrawal route (app/api/billing/withdraw, 588 [KB9] unit 3): at most PER_DAY (10) a store a day, each a bounded Stripe reading (MAX_CALLS) and, once per withdrawal, the plan refund flow; the money is the reviewed refund exposure under the money-back guarantee (docs/funded-exposure-review.md), a company cost."),
  "plan-refund-review": guard("The plan refund's review page (app/studio/refund, 305 [SY1]): drawn at most SHOWN_PER_DAY (20) a store a day, each a bounded Stripe reading (MAX_CALLS) and one short key: a company cost."),
  "help-support": guard("\"Send this to support\" from the studio's help (lib/help-support.ts, 491 [PP2] complement): at most SUPPORT_PER_DAY (5) requests a store in 24 hours, counted before sending and refused when the count cannot be read; each is SUPPORT_EMAILS_PER_REQUEST (2) emails on the company meter and nothing kept: a company cost."),
  "metaads-deauth": guard("Meta's own notices: a company cost."), "outreach-stop": guard("A recipient's stop link: a company cost."),
  "free-conn": PUBLIC, "free-net": PUBLIC,
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
  "assist-ask": PUBLIC, "assist-read": PUBLIC, "assist-handoff": PUBLIC, "assist-next-dismiss": PUBLIC,
  "quiz-connection": BURST("public-requests"), "quiz-student": BURST("public-requests"),
  "lesson-comment": BURST("buyer-actions"), "lesson-comment-day": BURST("buyer-actions"), "task-hand-in": BURST("buyer-actions"), "lesson-note": BURST("buyer-actions"), "task-upload": BURST("buyer-actions"),
  // Per store, under a figure of the window.
  "api-add": BURST("rest-api"), "api-give": BURST("rest-api"),
  "picture-door": BURST("studio"),
  "inbox-new": BURST("inbox"), "chat-send": BURST("inbox"), "chat-start": BURST("inbox"),
  // A buyer's report of a problem with an order (567 [GD1] (a), app/api/store/order-problem): at most ORDER_PROBLEM_PER_DAY a buyer a store, each one inbox message from the store's figure (lib/inbox.ts, open) and its notice from the store's email figure (tellTeam).
  // Its own commands beyond the message (the per-buyer counter, the order's mark, the room: ORDER_PROBLEM_COMMANDS in
  // lib/order-problem.ts) are taken from the lookup's buyer requests (found.meter, ORDERS_UNIT_COMMANDS each, priced as
  // the store's public requests) before they are sent, never from this unit, which the message uses (Claude 7 on #3837).
  "order-problem": BURST("inbox"),
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
  "lib/plan-withdrawal.ts": COMPANY, "lib/help-support.ts": COMPANY,
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
  // A PayPal order PayPal never confirmed, canceled (Claude 7, 12 November 2026): one notice to its buyer, tried again
  // only while the sender refused it (CANCEL_NOTICE_TRIES), and one to its creator, in place of the order's receipt.
  "lib/paypal-cancel.ts": ORDER,
  "lib/purchase-email.ts": ["order", "store"], "lib/calls.ts": ["order", "store"], "lib/licence-keys.ts": ["order", "store"],
  "lib/affiliate-hub.ts": STORE, "lib/affiliate-payday.ts": STORE, "lib/affiliates.ts": STORE, "lib/assignment-notify.ts": STORE,
  "lib/buyer-library.ts": STORE, "lib/erasure-request.ts": STORE, "lib/buyer-orders.ts": STORE, "lib/checkout-recovery.ts": STORE, "lib/checkout-trouble.ts": STORE, "lib/plan-stuck-notice.ts": STORE, "lib/plan-late-notice.ts": STORE,
  "lib/community-access.ts": STORE, "lib/community-event-mail.ts": STORE, "lib/inbox.ts": STORE, "lib/learn.ts": STORE, "lib/letter-access.ts": STORE,
  "lib/lesson-comment-notify.ts": STORE, "lib/member-nudge.ts": STORE, "lib/membership-manage.ts": STORE, "lib/membership-pause.ts": STORE,
  "lib/payment-recovery.ts": STORE, "lib/podcast-access.ts": STORE, "lib/quiet-sales.ts": STORE, "lib/store-contact.ts": STORE,
  "lib/store-join.ts": STORE, "lib/team.ts": STORE, "lib/api-key-pause.ts": STORE, "lib/tier-switch.ts": STORE, "lib/waitlist.ts": STORE,
  "lib/welcome-offer-send.ts": STORE, "lib/winback-send.ts": STORE,
  // The email that a scheduled discount code could not be switched on (511 [CK3], unit 2): the store's own email, taken before it goes.
  "lib/discount-schedule-notice.ts": STORE, "lib/yearly-ask.ts": STORE, "lib/yearly-switch.ts": STORE,
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

/**
 * One run of the one-time walk that notes the products of private podcast feeds granted before the product note
 * (#4471; lib/podcast-access.ts notePodcastProducts, run by app/api/cron/recount every hour until it is done): its
 * commands and bytes at their ceilings (NOTE_RUN_COMMANDS, NOTE_RUN_BYTES), each SCAN page taken at its COUNT (1,000
 * names, as if every key examined were a feed's index of another store). A company cost (100% Marktmorgen, FX275),
 * never a plan's: one run covers twice the database the daily backup accepts; on a larger one, how many runs it takes
 * is not known, so its total stays unknown, never zero (docs/funded-exposure-review.md). Once it is done, a run sends
 * two commands. What a deletion adds while it is not done is in its own units
 * (lib/erasure-rules.ts, ERASE_FIXED_COMMANDS and ERASE_PER.podcastProducts).
 */
export const PODCAST_NOTE_RUN_USD = NOTE_RUN_COMMANDS * COMMAND + NOTE_RUN_BYTES * DB_BYTE;

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
