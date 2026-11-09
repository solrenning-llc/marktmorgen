/**
 * What every key family a store can make in the database costs to keep, and
 * how it is bounded (added 18 October 2026, when the open item
 * database-storage of tests/plan-cost-registry.ts was closed).
 *
 * tests/store-data-registry.test.ts reads every key the code builds under
 * "nl:" (app/ and lib/), file by file, and fails when one is not here, or
 * when an entry here no longer matches anything. So a new key family cannot
 * be added without saying, here, how what it keeps is bounded:
 *
 *   - room: counted in the store's data room where it is written
 *     (lib/store-data.ts) and refused past it, or kept only while it fits;
 *     the files named must take and give it (takeData, needData, keepFor,
 *     noteData, giveData). Priced as the room: DATA_ROOM_BYTES of
 *     lib/store-data-rules.ts.
 *   - kept, item: written by an order and kept for as long as the store is,
 *     at most `kept` bytes an order and `item` bytes for each product it
 *     hands over: inside ORDER_DATA_BYTES and ITEM_DATA_BYTES, which every
 *     checkout holds before it opens (lib/order-admission.ts). Since 18
 *     October 2026 what each order really writes is charged to the room as
 *     it is written (lib/order-data.ts, orderWrite), so the file named must
 *     write through it; these ceilings bound only the hold.
 *   - per: written by one unit of a figure the store's window counts (an
 *     order, a public request, a studio request, an email...), at most
 *     `bytes` a unit, gone by itself within `days`. Parts of one `group` are
 *     never written by the same unit (each email is one kind of email), so a
 *     group costs its dearest part, not their sum.
 *   - capped: bounded by caps in the code, at most `capped(tier)` bytes per
 *     store, worked out from the constants named (checked to be there).
 *   - company: not a store's: an account, a person signing in, the company's
 *     own jobs, ledgers and indexes, which the fixed costs carry.
 *   - line: kept bytes already priced by another line of the cost registry.
 *
 * Bytes are review ceilings stated as such: a key's name, its value at the
 * largest the code writes, and what Redis keeps beside it (KEY for a small
 * key, ENTRY_BYTES for a field or member), rounded up.
 *
 * tests/plan-cost-registry.ts prices the room and these parts together at
 * Upstash's storage rate (line database-storage): the room full every day,
 * each part at what it keeps on average over a month (Upstash bills the
 * daily average, lib/spend-cost-table.ts), and once more what all of it can
 * keep at one time, for the closing days after a plan ends
 * (PER_PAYMENT_LINES).
 */
import { BOOK_SNAPSHOT_MAX_BYTES } from "@/lib/affiliate-book-snapshot";
import type { Tier } from "@/lib/plan";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { EXTRA_REQUESTS, REQUESTS_PER_VISIT, VISITS_INCLUDED } from "@/lib/traffic-rules";
import { CALL_ORDER_UNITS, ORDERS_INCLUDED } from "@/lib/order-rules";
import { monthlyEmails } from "@/lib/plan";
import { DAILY_RUNS_BY_TIER } from "@/lib/flow-limits";
import { IMPORT_ALLOWANCES, IMPORT_ROW_BYTES } from "@/lib/import-limits";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { ANSWERS_MONTHLY } from "@/lib/answers-rules";
import { QUIZ_MONTHLY_SUBMISSIONS } from "@/lib/quiz-usage-rules";
import { PAID_UPLOAD_OPENS } from "@/lib/upload-budget-policy";
import { ENTRY_BYTES } from "@/lib/store-data-rules";
import { TASK_COUNT_WEIGHT } from "@/lib/crm";
import { MAX_STORE_BYTES } from "@/lib/store";
import { KEPT_DAYS, ALL_TIME_PAGES, DAY_FIELDS_MAX, LIFE_WRITE_MAX } from "@/lib/stats";
import { NUMBERS_KEPT_BYTES } from "@/lib/api-read-rules";
import { MAX_AFFILIATES } from "@/lib/affiliate-setting";
import { MAX_SPEND_ENTRIES } from "@/lib/ad-spend-rules";
import { MAX_LINKS } from "@/lib/short-link-rules";
import { MAX_NOTES, MAX_NOTE_LENGTH as MAX_STATS_NOTE } from "@/lib/stats-notes";
import { MAX_CRM_FIELDS, MAX_FIELD_OPTIONS, MAX_STAGES } from "@/lib/crm-rules";
import { MAX_FORMS, MAX_FIELDS, MAX_OPTIONS, MAX_OUTCOMES } from "@/lib/forms";
import { MAX_DRAFTS } from "@/lib/mail-drafts";
import { MAX_MAIL_BODY } from "@/lib/mail";
import { MAX_SEGMENTS } from "@/lib/segments-rules";
import { MAX_CHAT_KEPT, MAX_CHAT_TEXT } from "@/lib/community-chat-rules";
import { MAX_REPORT_QUEUE, MAX_SPACES, MAX_QUESTIONS, MAX_WELCOME } from "@/lib/community-text";
import { MAX_PHOTO_BYTES } from "@/lib/photo-limits";
import { MAX_TEAM, LOG_LINES } from "@/lib/team";
import { DELIVERY_MAX_BYTES, GIVEN_UP_LINES_PER_DAY, MAX_ENDPOINTS, SKIPPED_LINES_PER_DAY, LOG_SIZE as HOOK_LOG } from "@/lib/webhooks";
import { LOG_SIZE as SYNC_LOG } from "@/lib/email-sync";
import { MAX_DEVICES } from "@/lib/phone-alerts";
import { CALENDAR_POLLS_PER_HOUR, MAX_FEEDS } from "@/lib/calendar-sync";
import { CALENDAR_FILE_BYTES } from "@/lib/read-ceilings";
import { READING_COPY_MAX_BYTES } from "@/lib/store-readings";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { CLOSING, FOLLOWED_FAMILIES } from "@/lib/data-families";
import { CLOSING_DAYS } from "@/lib/plan-closing-rules";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { ASSIST_REMINDERS_PER_STORE_DAY } from "@/lib/assistant-reminder-rules";
import { SETUP_EXTRA_REQUESTS, SETUP_VISITS, TRIAL_EXTRA_REQUESTS, TRIAL_VISITS } from "@/lib/traffic-rules";
import { TRIAL_ORDERS } from "@/lib/order-rules";
import { TRIAL_MONTHLY_EMAILS } from "@/lib/plan";
import { TRIAL_DAILY_RUNS } from "@/lib/flow-limits";

const KB = 1_024;
/** A key with its name and a small value: what most links and records of a few fields weigh, rounded up. */
const KEY = 256;
/** A mark: a key of under 80 characters holding a word, a count or a time. */
export const MARK = 160;

/** What a figure of the store's window counts, by plan: the units a `per` part is written by. */
export type Unit = "order" | "call" | "request" | "studio" | "api" | "inbox" | "own" | "access" | "store" | "monthly" | "integration" | "buyer" | "webhook" | "run" | "row" | "ai" | "quiz" | "upload" | "day";
export const UNITS: Record<Unit, (tier: Tier) => number> = {
  // Every order of the window, paid and free together (lib/order-admission.ts).
  order: (tier) => ORDERS_INCLUDED[tier],
  // A booked call is CALL_ORDER_UNITS of them.
  call: (tier) => Math.floor(ORDERS_INCLUDED[tier] / CALL_ORDER_UNITS),
  // Every public request of the window, pages and routes together (lib/traffic-rules.ts, requestLimitFor).
  request: (tier) => REQUESTS_PER_VISIT * VISITS_INCLUDED[tier] + EXTRA_REQUESTS[tier],
  // The studio's figure, and the never-paused requests of every UTC day the window touches.
  studio: (tier) => STORE_ALLOWANCES[tier].studio + ESSENTIAL_PER_DAY * 32,
  api: (tier) => STORE_ALLOWANCES[tier].api,
  inbox: (tier) => STORE_ALLOWANCES[tier].inbox,
  // The emails a store sends, by the figure each is taken from (lib/email.ts, EmailMeter): its own,
  // its buyers' access emails, either of those where a file sends both, and the monthly ones.
  own: (tier) => STORE_ALLOWANCES[tier].email,
  access: (tier) => STORE_ALLOWANCES[tier].transactional,
  store: (tier) => STORE_ALLOWANCES[tier].email + STORE_ALLOWANCES[tier].transactional,
  monthly: (tier) => monthlyEmails(tier),
  integration: (tier) => STORE_ALLOWANCES[tier].integration,
  buyer: (tier) => STORE_ALLOWANCES[tier].buyer,
  webhook: (tier) => STORE_ALLOWANCES[tier].webhook,
  run: (tier) => DAILY_RUNS_BY_TIER[tier] * 32,
  row: (tier) => IMPORT_ALLOWANCES[tier].rows,
  ai: (tier) => AI_MONTHLY[tier] + ANSWERS_MONTHLY[tier],
  quiz: () => QUIZ_MONTHLY_SUBMISSIONS,
  upload: (tier) => PAID_UPLOAD_OPENS[tier],
  // A key a UTC day: the 32 a billing month touches.
  day: () => 32,
};

/** Windows a span of `days` can touch: a billing month is at least 28 days, and the span may start inside one. */
export const windowsOver = (days: number) => Math.ceil(days / 28) + 1;

export type Source = { file: string; names: string[] };
export type Part =
  | { kept: number; what: string }
  | { item: number; what: string; kind?: string }
  | { per: Unit; days: number; bytes: number; what: string; group?: string }
  | { capped: (tier: Tier) => number; names: Source[]; what: string };
export type Family = {
  what: string;
  /** Files that take and give this family's room (lib/store-data.ts). */
  room?: string[];
  /** Why it is not a store's. */
  company?: string;
  /** The line of tests/plan-cost-registry.ts that already prices what it keeps. */
  line?: string;
  parts?: Part[];
};

/** Kept for as long as the store is, at most `bytes` an order. */
const kept = (bytes: number, what: string): Part => ({ kept: bytes, what });
/**
 * Kept for as long as the store is, at most `bytes` for each product an
 * order hands over. Parts of one `kind` are for one kind of product (a call
 * is never a membership), so a product keeps the parts of its kind or of
 * none, never of two kinds.
 */
const item = (bytes: number, what: string, kind?: string): Part => ({ item: bytes, what, ...(kind ? { kind } : {}) });
const per = (unit: Unit, days: number, bytes: number, what: string, group?: string): Part => ({ per: unit, days, bytes, what, ...(group ? { group } : {}) });
const capped = (bytes: number | ((tier: Tier) => number), what: string, ...names: Source[]): Part => ({ capped: typeof bytes === "number" ? () => bytes : bytes, names, what });
const src = (file: string, ...names: string[]): Source => ({ file, names });
const lock = (what: string): Family => ({ what, company: "A lock a scheduled job holds for a few minutes: one key, the company's." });
const company = (what: string, why: string): Family => ({ what, company: why });
/** A short-lived key a store's unit leaves: a lock, a mark, a link, a rate count. */
const short = (what: string, unit: Unit, days: number, bytes = KEY, group?: string): Family => ({ what, parts: [per(unit, days, bytes, what, group)] });
/** A family name lib/closed-store-data.ts reads a closing store's keys of (FOLLOWERS): the family's own entry bounds it. */
const follower = (family: string): Family => company(`The family ${family}, which a closing store's follower reads`, "Not a key: the name of a family whose keys lib/closed-store-data.ts reads before the walk deletes them; the family's own entry says how they are bounded.");
/** Counted in the store's data room by these files. */
const room = (what: string, ...files: string[]): Family => ({ what, room: files });

/**
 * Each email is one kind of email (a broadcast, a product update, a review
 * ask, a sign-in link...), and leaves the keys of its kind: so the email
 * figure is priced at its dearest kind, every email of the window of that
 * kind, not at every kind at once.
 */
const MAIL = (kind: string) => `email kind/${kind}`;
/**
 * Each public request is one route's: a page drawn, a checkout opened, a
 * search, a link asked for... and leaves the keys of its kind (the counts
 * every request leaves, the guard's and the visit's, are priced on their
 * own): so the request figure is priced at its dearest kind.
 */
const REQ = (kind: string) => `request kind/${kind}`;
/** A calendar's reading: at most 2,000 busy times of two times each in milliseconds, as JSON, and the key. */
const READING_BYTES = 2_000 * 30 + 2 * KB;
/** What an emailed link keeps: its key and who it is for, an address of up to 254 characters with the store's names. */
const LINK_BYTES = 768;
/** Each order is one kind at the most: a gift, a purchase for several people, a pre-order, a PayPal order, a call, a membership. */
const KIND = (kind: string) => `order kind/${kind}`;

export const FAMILIES: Record<string, Family> = {
  // ---------------------------------------------------------------- app/
  "nl:rl:creators:@app/api/creators/route.ts": company("Applications to the creators' page, per connection", "The company's own sign-up page for creators, not a store's."),
  "nl:aff:payday:lock@app/api/cron/affiliates/route.ts": lock("The affiliates' payday job"),
  "nl:closing:lock@app/api/cron/closing/route.ts": lock("The closing job"),
  "nl:closed:lock@app/api/cron/closed-data/route.ts": lock("The deletion of closed stores' records"),
  "nl:closing:refund:@lib/closing-refunds.ts": lock("A store's refunds of its members' unused time, one request at a time"),
  "nl:closing:credit:@lib/closing-credit.ts": { what: "What is left of a closing's emails to its buyers (queue item 307 EC1)", parts: [capped(MARK, "One count a store.", src("lib/closing-credit.ts", "creditKey"))] },
  "nl:closing:told:@lib/closing-buyers.ts": { what: "The addresses told that a store closes, until it closes or stays", line: "closure" },
  "nl:closing:paid:@lib/closing-holds.ts": { what: "A closing store's members' last payments, from its plan's end to its closing", line: "closure" },
  "nl:closing:work:@lib/closing-holds.ts": { what: "Where a closing store's hold and release stopped, its members not held yet and its call budget", line: "closure" },
  "nl:closing:undo@lib/closing-plan-guard.ts": company("Plans paid for a store already closing, until each is ended, returned in full and its creator told", "One hash for the company: a field a plan subscription; once settled only its dates are kept, looked at again and taken out DONE_KEEP_DAYS (40) later (lib/closing-plan-guard.ts); a step that fails keeps it for the next run."),
  "nl:closing:shut:@lib/closing-plan-guard.ts": company("A closing store's address, hashed, with the day its closing began", "One key an address, the company's, expiring by itself SHUT_DAYS (30) after the store's last closing run (lib/closing-plan-guard.ts)."),
  "nl:closing:final@lib/closing-holds.ts": company("Stores whose closing day has begun, seen through to the end", "One sorted set for every store, a member a store from its closing day's start to its end (lib/plan-closing.ts)."),
  "nl:closing:held@lib/closing-holds.ts": company("Stores whose members' charges are held until they close or run again", "One sorted set for every store, a member a store; taken out when it closes or runs again (lib/closing-holds.ts)."),
  "nl:courses:lock@app/api/cron/courses/route.ts": lock("The courses job"),
  "nl:dc:lock@app/api/cron/discord/route.ts": lock("The Discord job"),
  "nl:imports:lock@app/api/cron/imports/route.ts": lock("The imports job"),
  "nl:backup:ran:@lib/backup-run.ts": company("The count of a day's calls to the backup run, taken before any cost: at most a run and one new try after a failure (273 [BK1], inbox C4-49)", "One key a day holding a small count, made with its expiry only if absent and kept 2 days, so at most 3 at once for the company. Built and off: nothing calls the run."),
  "nl:backup:last-ok@lib/backup-run.ts": company("When the last backup copy was verified, and its manifest's id, the copy never deleted to make room (273 [BK1], inbox C4-53)", "One key for the company: a short JSON of a time in ms and a manifest id, kept for good (replaced by each verified copy; its absence would be a loss), never more than one. Built and off: nothing calls the run."),
  "nl:backup:lock@lib/backup-run.ts": company("The lock that keeps backup runs one at a time (273 [BK1], inbox C4-53)", "One key for the company holding the run's random token, made only if absent, kept at most 15 minutes and let go, only by its own run, when the run ends. Built and off: nothing calls the run."),
  "nl:backup:last-fail@lib/backup-run.ts": company("The last failed backup run and the step that failed (273 [BK1])", "One key for the company: a short JSON of a time and a reason name, kept 8 days. Built and off: nothing calls the run."),
  "nl:@lib/backup-export.ts": company("Not a key: the start of every key the backup export copies (273 [BK1])", "Read only: SCAN with MATCH nl:*, then DUMP and PEXPIRETIME of each key found, under a command budget, a row cap and a size cap, all set before any is sent; nothing is written. Built and off: nothing calls it. Each key family keeps its own bound."),
  "nl:@lib/backup-codec.ts": company("Namespace filter for offline backup rows", "Not a Redis key or write: startsWith validates imported synthetic/exported names; codec has no provider adapter or persistence. Actual source key families retain their own bounds."),
  "nl:mail-check:last@app/api/cron/mail-check/route.ts": company("When the mail check last ran", "One key, the company's job."),
  "nl:indexnow:sent@lib/indexnow.ts": company("The site's own pages already announced to IndexNow", "One set, the company's: only addresses from its own sitemap (app/sitemap.ts), each once, so it is as large as the sitemap and never holds a store's data."),
  "nl:mail-check:lock@app/api/cron/mail-check/route.ts": lock("The mail check"),
  "nl:mail:lock@app/api/cron/mail/route.ts": lock("The mail job"),
  "nl:monthly:lock@app/api/cron/monthly/route.ts": lock("The monthly job"),
  "nl:plans:lock@app/api/cron/plans/route.ts": lock("The plans job"),
  "nl:quiet:at:@app/api/cron/quiet/route.ts": company("When the quiet-sales job ran each day", "One key a day, the company's job, kept two days."),
  "nl:quiet:lock@app/api/cron/quiet/route.ts": lock("The quiet-sales job"),
  "nl:recount:lock@app/api/cron/recount/route.ts": lock("The one-time count of what stores keep"),
  "nl:remind:lock@app/api/cron/reminders/route.ts": lock("The reminders job"),
  "nl:share:lock@app/api/cron/shares/route.ts": lock("The shares job"),
  "nl:stream:lock@app/api/cron/stream/route.ts": lock("The video job"),
  "nl:stripe-check:last@app/api/cron/stripe-check/route.ts": company("When the Stripe check last ran", "One key, the company's job."),
  "nl:stripe-check:lock@app/api/cron/stripe-check/route.ts": lock("The Stripe check"),
  // 247 [SP4] unit 2: the public status page's history of the two daily checks (lib/status-page.ts).
  "nl:mail-check:runs@lib/status-page.ts": company("The mail check's last runs, for the public status page (247 [SP4])", "One list, the company's job: a time and a pass or fail per run, nothing else, cut to STATUS_RUNS_KEPT (60) entries of under 64 bytes and kept 70 days after the last run."),
  "nl:status:views:@lib/status-page.ts": company("The public status page's requests in an hour (247 [SP4])", "One key an hour, the company's: a count and nothing else, kept two hours, so at most three at once."),
  "nl:stripe-check:runs@lib/status-page.ts": company("The Stripe check's last runs, for the public status page (247 [SP4])", "One list, the company's job: a time and a pass or fail per run, nothing else, cut to STATUS_RUNS_KEPT (60) entries of under 64 bytes and kept 70 days after the last run."),
  "nl:usage-watch:told@app/api/cron/usage/route.ts": company("What the usage watch told the owner", "One key, the company's job."),
  "nl:weekly:lock@app/api/cron/weekly/route.ts": lock("The weekly job"),
  "nl:meet:zoomseen:@app/api/integrations/zoom/deauthorize/route.ts": company("Zoom's notices already handled", "Zoom's own notices, kept a day: the company's."),
  "nl:inbound:seen:@app/api/mail/inbound/route.ts": company("Inbound mail already handled", "The email provider's notices, kept a few days: the company's."),
  "nl:sns:seen:@app/api/mail/ses/route.ts": company("Amazon's notices already handled", "The email provider's notices, kept a few days: the company's."),
  "nl:course:@app/api/store/course/route.ts": short("A course's lock while the studio changes it", "studio", 1),
  "nl:rl:export:@app/api/store/export/route.ts": { what: "Downloads of a store's files: counted ten minutes at a time, and its whole exports since its plan ended", parts: [per("studio", 1, KEY, "Downloads counted ten minutes at a time."), capped(() => KEY, "One count of whole exports since the plan ended, sixty days.")] },
  "nl:rl:licence:@app/api/store/licence/route.ts": short("A license check's count per connection", "request", 1, KEY, REQ("license")),
  "nl:pod:@app/api/store/podcast/route.ts": short("A podcast's lock while the studio changes it", "studio", 1),

  // ---------------------------------------------------------------- lib/ a–b
  "nl:adsrv:@lib/ad-events.ts": { what: "The store's server-side ad settings, its sealed tokens", parts: [capped(8 * KB, "Four platforms' sealed tokens and a test code: one record a store.")] },
  "nl:adsrv:ctx:@lib/ad-events.ts": room("What a checkout opened with ad consent carries to its sale (four days), kept only while it fits", "lib/ad-events.ts"),
  "nl:adsrv:last:@lib/ad-events.ts": { what: "The last answers of the ad platforms, for the studio", parts: [capped(4 * KB, "One record a store, ninety days.")] },
  "nl:adsrv:sent:@lib/ad-events.ts": { what: "A sale, renewal or lead already sent to the ad platforms", room: ["lib/ad-events.ts"], parts: [per("order", 3, MARK, "A sale's mark, three days."), per("request", 3, MARK, "A lead's mark, three days.", REQ("sign-up"))] },
  "nl:adsrv:sub:@lib/ad-events.ts": { what: "What a membership's renewals are sent with", parts: [per("order", 400, KB, "Its cookies and clicks, once per membership sold, 400 days.", KIND("membership"))] },
  "nl:stats:@lib/ad-spend.ts": { what: "What the creator spent on ads", parts: [capped(MAX_SPEND_ENTRIES * 512, "MAX_SPEND_ENTRIES entries, the oldest let go.", src("lib/ad-spend-rules.ts", "MAX_SPEND_ENTRIES"))] },
  "nl:stats:@lib/api-numbers.ts": { what: "The numbers as the API and the MCP tools read them, kept an hour", parts: [capped(2 * (NUMBERS_KEPT_BYTES + KB), "Two copies, without and with the products' listings, each at most NUMBERS_KEPT_BYTES and its first line.", src("lib/api-read-rules.ts", "NUMBERS_KEPT_BYTES"))] },
  "nl:aff:@lib/affiliate-bond.ts": { what: "Which affiliate a buyer belongs to", parts: [kept(MARK, "A field per buyer, written with a sale, kept for good.")] },
  "nl:aff:@lib/affiliate-codes.ts": { what: "Discount codes given to affiliates", room: ["lib/affiliate-codes.ts"] },
  // An affiliate program's book worked out for all its affiliates and kept a day (4 November 2026), past its cap not kept at all.
  "nl:aff:@lib/affiliate-book-snapshot.ts": { what: "An affiliate program's book, shown a day and kept a week more for its affiliates' own pages, the draft of its refresh and that draft's name, the lock of its refresh, its version, its count of refreshes without a complete book and when the last began", parts: [capped(2 * BOOK_SNAPSHOT_MAX_BYTES + 6 * KEY, "One book a store, BOOK_SNAPSHOT_MAX_BYTES at the most (UTF-8 bytes, as Redis counts them), BOOK_KEEP_SECONDS, and one draft while it is written, renamed into its place (the next refresh deletes one a stopped refresh left, so never two); the draft's name, its lock BOOK_LOCK_SECONDS, the version raised by a person's deletion (BOOK_KEEP_SECONDS), the count of paid refreshes in a row without a complete book (BOOK_TRIES_KEEP_SECONDS) and when the last one began until it writes (BOOK_FRESH_SECONDS), a key each.", src("lib/affiliate-book-snapshot.ts", "BOOK_SNAPSHOT_MAX_BYTES", "BOOK_KEEP_SECONDS", "BOOK_LOCK_SECONDS", "BOOK_TRIES_KEEP_SECONDS", "BOOK_FRESH_SECONDS"))] },
  "nl:affhub:@lib/affiliate-hub.ts": company("The stores an address is an affiliate of", "Per affiliate across stores, in the set of the quarter it was noted in, kept QUARTERS_KEPT quarters at the most: written with an affiliate record (capped by MAX_AFFILIATES per store, below); what a closed store leaves in it is the company's as the hub is, and runs out with its quarter."),
  "nl:affhub:link:@lib/affiliate-hub.ts": company("An emailed link to an affiliate's page, a day", "Per affiliate across stores, behind a per-address limit."),
  "nl:sdemo:@lib/studio-demo-rules.ts": company("The studio demo's day: its counts and caps (nl:sdemo:day:<day>), and the day's sessions and refusals by a keyed fingerprint of each address or network, with the day's count of refusals (nl:sdemo:addr:<day>)", "The company's, no store's (256 [KJ1], off): the day's hash holds only the fields of DEMO_COUNTS and the caps' counters, kept 400 days; the addresses' hash holds at most DEMO_SESSIONS_PER_DAY fields of sessions, DEMO_REFUSALS_PER_DAY fields of an address's refusals and the day's count of refusals, and ends with the day (EXPIREAT)."),
  "nl:sdemo:{<session>}:<family>[:<part>]@lib/studio-demo-rules.ts": company("A studio demo session: its record and the drafts it changed, one key a family of DEMO_KEY_FAMILIES", "The company's, no store's (256 [KJ1], off): written only through sandboxKey, at most DEMO_SESSIONS_PER_DAY sessions a day, each held under DEMO_BYTES_PER_SESSION and ending all at once DEMO_SESSION_SECONDS (21 hours) after it opened (EXPIREAT, never extended), so two days of openings are alive at the most (docs/studio-demo.md)."),
  "nl:affkit:@lib/affiliate-kit.ts": short("An affiliate kit's counts, by the day and the window", "ai", 40),
  "nl:aff:payday:@lib/affiliate-payday.ts": short("A store's monthly payday claimed", "day", 40),
  "nl:aff:@lib/affiliates.ts": {
    what: "Affiliates: their records, addresses, codes, clicks, sales and shares, and what the creator says was paid",
    room: ["lib/affiliates.ts"],
    parts: [
      capped(MAX_AFFILIATES * (1_536 + 4 * ENTRY_BYTES), "MAX_AFFILIATES records (an address, a note of MAX_NOTE_LENGTH in any script, the rest), each with its address, code and click counts.", src("lib/affiliate-setting.ts", "MAX_AFFILIATES"), src("lib/affiliates.ts", "MAX_NOTE_LENGTH")),
      kept(512, "A sale credited and up to two partners' shares of it."),
    ],
  },
  // Confirmed leads (18 October 2026): each counted in the store's data room before it is written, with room for its decision, and refused past it.
  "nl:aff:leads:lock:@lib/affiliate-leads.ts": short("A program's leads being decided or a person's address taken off one, ten seconds at the most", "studio", 1, 128),
  "nl:aff:@lib/affiliate-lead-rules.ts": { what: "Confirmed leads an affiliate was credited for: the person's address, the kind, the terms then and the creator's decision", room: ["lib/affiliate-leads.ts"] },
  "nl:aff:link:@lib/affiliates.ts": short("An emailed link to apply or sign in, a day", "store", 1, LINK_BYTES, MAIL("affiliate")),
  "nl:aff:seen:@lib/affiliates.ts": short("A click counted once per visitor a day", "request", 2, KEY, REQ("affiliate")),
  "nl:aff:session:@lib/affiliates.ts": short("An affiliate signed in on one browser, thirty days, from an emailed link", "store", 30, KEY, MAIL("affiliate")),
  "nl:rl:aff:addr:@lib/affiliates.ts": short("Applications per address, an hour", "request", 1, KEY, REQ("affiliate")),
  "nl:rl:aff:click:@lib/affiliates.ts": short("Clicks per connection, an hour", "request", 1, KEY, REQ("affiliate")),
  "nl:rl:aff:ip:@lib/affiliates.ts": short("Applications per connection, an hour", "request", 1, KEY, REQ("affiliate")),
  "nl:ai-spend:v2:{@lib/ai-spend-policy.ts": company("The company's AI spending ledger, a month", "One key a month with a field a store: the company's ledger, carried by its fixed costs."),
  "nl:ai-spend:v2:{YYYY-MM}@lib/ai-spend-policy.ts": company("The ledger's name, as the policy states it", "The same ledger."),
  "nl:ai:@lib/ai.ts": short("Writing jobs counted in the window", "day", 40, 128),
  "nl:assist:pool:@lib/store-assistant.ts": { what: "The Store assistant's pool of replies for one month of the add-on", line: "store-assistant" },
  "nl:assist:c:@lib/store-assistant.ts": { what: "A conversation with the Store assistant, a day after its last message", line: "store-assistant" },
  "nl:assist:missed:@lib/store-assistant.ts": { what: "Questions the Store assistant could not answer, for the creator", line: "store-assistant" },
  "nl:assist:next:@lib/next-offer.ts": short("The one next product the Store assistant chose for an order, and whether the buyer dismissed it", "order", 3, KB),
  "nl:assist:nextlock:@lib/next-offer.ts": short("An order's next product being chosen, a minute", "order", 1, MARK),
  // At most ASSIST_REMINDERS_PER_STORE_DAY yeses a store a day, each the address, the sentence checked and when (768 bytes at the most), gone in three days.
  "nl:assist:remind:@lib/assistant-reminder-rules.ts": short("A buyer's yes to one checkout reminder, three days from the checkout", "day", 3, ASSIST_REMINDERS_PER_STORE_DAY * LINK_BYTES),
  "nl:assist:remindwho:@lib/assistant-reminder.ts": short("The checkouts one address said yes on, by a one-way hash, three days", "day", 3, ASSIST_REMINDERS_PER_STORE_DAY * KEY),
  "nl:assist:remindq@lib/assistant-reminder.ts": company("Store assistant checkout reminders due", "One sorted set for every store, each member a store, its handle and a checkout, never an address, gone when sent or dropped within hours: at most ASSIST_REMINDERS_PER_STORE_DAY a store a day."),
  "nl:ask:@lib/answers.ts": short("Visitors' answers counted in the window", "day", 40, 128),
  "nl:ask:a:@lib/answers.ts": short("An answer already given to a question about a page, a day", "ai", 1, 8 * KB),
  "nl:ask:missed:@lib/answers.ts": { what: "Questions a page did not answer, for the creator", parts: [capped(100 * KB, "The newest MISSED_KEPT, trimmed on every write.", src("lib/answers.ts", "MISSED_KEPT", "LTRIM"))] },
  "nl:api:k:@lib/api-keys.ts": { what: "The lookup an API request makes", parts: [capped(20 * KEY, "A key's lookup for each of the store's keys (MAX_KEYS).", src("lib/api-key-rules.ts", "MAX_KEYS"))] },
  "nl:api:keys:@lib/api-keys.ts": { what: "The store's API keys", parts: [capped(20 * KB, "MAX_KEYS records.", src("lib/api-key-rules.ts", "MAX_KEYS"))] },
  "nl:api:hold:@lib/api-keys.ts": { what: "Which of the store's API keys are paused (the team's two-step rule, a maker who left or whose role changed) or were turned back on (owner C3-100)", parts: [capped(1 * KB, "One short mark for each of MAX_KEYS keys; a revoked key's mark goes with it.", src("lib/api-key-rules.ts", "MAX_KEYS"))] },
  "nl:api:used:@lib/api-keys.ts": { what: "When each of the store's API keys was last used, kept apart from its record", parts: [capped(1 * KB, "One time for each of MAX_KEYS keys; a revoked key's goes with it.", src("lib/api-key-rules.ts", "MAX_KEYS"))] },
  "nl:course:@lib/assignment.ts": { what: "A course's assignments, the work handed in and what came back", room: ["lib/assignment.ts"], parts: [per("studio", 1, KEY, "The creator told of new work, an hour.")] },
  "nl:tasks:bytes:@lib/assignment.ts": { what: "What a store's students keep handed in, in bytes", parts: [capped(KEY, "One count a store.")] },
  "nl:tasks:taken:@lib/assignment.ts": short("A handed-in file's mark of the bytes it took of the store's room, an hour, so a lost answer gives them back", "buyer", 1, 128),
  "nl:tasks:doors@lib/assignment.ts": company("Hand-in doors not yet used, swept a day on", "One sorted set for every store, each door a buyer action's (priced in buyer-actions), gone within two days."),
  "nl:pictures:doors:@lib/picture-door.ts": { what: "A store's picture uploads not yet put on anything", parts: [capped(1_000 * 128, "One sorted set a store, trimmed to a day and to its newest 1,000 notes (PICTURE_DOOR_MAX) each time one is added, and expiring a day after the last.")] },
  "nl:auth:devices:@lib/auth.ts": company("Devices an account signed in on", "An account's, not a store's."),
  "nl:auth:fresh:@lib/auth.ts": company("A fresh sign-in", "An account's, minutes."),
  "nl:auth:second:@lib/auth.ts": company("The second step a session was opened with", "An account's, as long as its session."),
  "nl:auth:link:@lib/auth.ts": company("A sign-in link", "An account's, minutes."),
  "nl:auth:code:@lib/auth.ts": company("The six-digit code sent with a sign-in link, as a hash, and its tries", "An account's, minutes (652 [WG12])."),
  "nl:auth:linkcode:@lib/auth.ts": company("From a sign-in link to its code, so either spends both", "An account's, minutes (652 [WG12])."),
  "nl:auth:lastcode:@lib/auth.ts": company("An address's newest sign-in code, the only one that opens", "An account's, minutes (652 [WG12])."),
  "nl:rl:code-addr:@lib/auth.ts": company("Sign-in code tries for one address in the hour", "An account's, an hour (652 [WG12])."),
  "nl:rl:code-day:@lib/auth.ts": company("Sign-in code tries for one address in a day", "An account's, a day from its first try (652 [WG12], Claude 3 on #2736)."),
  "nl:rl:code-ip:@lib/auth.ts": company("Sign-in code tries from one machine in the hour", "A machine's count under a one-way hash of its address on the internet, an hour (652 [WG12], Claude 3 on #2736)."),
  "nl:auth:move:@lib/auth.ts": company("An address change", "An account's, a day."),
  "nl:auth:moving:@lib/auth.ts": company("An address in the middle of a move", "An account's, minutes."),
  "nl:auth:move-broken:@lib/auth.ts": company("A move that could be neither finished nor undone", "An account's, until it is repaired at the next login or move."),
  "nl:auth:session:@lib/auth.ts": company("A session", "An account's."),
  "nl:auth:sessions:@lib/auth.ts": company("An account's sessions", "An account's."),
  "nl:rl:address:@lib/auth.ts": company("Sign-in links per address", "An account's, an hour."),
  "nl:rl:signin:@lib/auth.ts": company("Sign-ins per connection", "An account's, an hour."),
  "nl:stream:auto:@lib/auto-captions.ts": { what: "Captions being written for a video, and their charge", parts: [per("upload", 400, KB, "One record a video asked for: seven days, or up to 400 days while a refund Stripe has not confirmed is owed.")] },
  "nl:stream:autoowed:@lib/auto-captions.ts": short("The videos of a store with a captions refund owed", "upload", 400),
  "nl:stream:autoq@lib/auto-captions.ts": company("Videos to ask about", "One sorted set, its members gone within days."),
  "nl:bench:ranges@lib/benchmarks.ts": company("The benchmark ranges", "One key, the company's, a month."),
  "nl:bench:s:@lib/benchmarks.ts": company("Each store's sample a week", "One key a week with a field a store, three weeks: the company's."),
  "nl:remind:@lib/billing-reminders.ts": company("A billing reminder sent", "The company's emails to creators about their own plan."),
  "nl:remind:failed:@lib/billing-reminders.ts": company("A failed invoice told", "The company's emails to creators about their own plan."),
  "nl:billing:sync:after@lib/billing-sync.ts": company("Where the billing sync stopped", "One key, the company's job."),
  "nl:billing:sync:cursor@lib/billing-sync.ts": company("Where the billing sync stopped", "One key, the company's job."),
  "nl:plan-refund:@lib/plan-refund-flow.ts": company("One store's plan refund lock while its refund is made and its plan ended (305 [SY1])", "One short key a store, the company's money job: a random token, expiring by itself FLOW_LOCK_SECONDS (505) after it was taken, released at once when done (lib/plan-refund-flow.ts)."),
  "nl:plan-refund:ending@lib/plan-refund-flow.ts": company("Plan refunds not finished yet (305 [SY1])", "One hash, one small field a store with a refund in progress (a subscription id, two times, a flag and up to MAX_PARTS (6) charge ids with their amounts; no person's data), removed when the plan is ended or the refund is found not made, by the request itself or the daily job within GIVE_UP_DAYS (7) (lib/plan-refund-flow.ts)."),
  "nl:plan-withdraw:@lib/plan-withdrawal.ts": company("A creator's withdrawal from their own plan (EU art. 11a, 588 [KB9] unit 3)", "One small hash a store's plan subscription, the company's proof of the withdrawal as trader: the first statement's time, the receipts tried (at most PLAN_WITHDRAW_ACK_SENDS, 3), a sent flag, a refund flag and, when support is owed a note, its short reason (the flow's own words), the notes tried (at most PLAN_WITHDRAW_SUPPORT_TRIES, 3) and a told flag; no name or email. Written with HSETNX and EXPIRE, gone by itself PLAN_WITHDRAW_KEEP_DAYS (400) after (lib/plan-withdrawal.ts)."),
  "nl:plan-refund:@lib/plan-refund-write.ts": company("A store's plan refund lock while one is made (305 [SY1])", "One short key a store, the company's money job: a random token, expiring by itself LOCK_SECONDS (345) after it was taken, released at once when the refund is done (lib/plan-refund-write.ts)."),
  "nl:plan-disputes:seen@lib/plan-disputes.ts": company("What each dispute on our own Stripe account turned out to be (232 [CA1] unit 5)", "One hash, the company's job: dispute ids with 'final', 'unmatched:<seconds>' or 'open:<store id>', never an address; 400 days from the last write; a deleted store's id reads as unmatched."),
  "nl:mail:bc:@lib/broadcasts.ts": { what: "Broadcasts and who each goes to", room: ["lib/broadcasts.ts"], parts: [per("studio", 1, KEY, "A broadcast's lock while it sends, minutes.")] },
  "nl:mail:bcs:@lib/broadcasts.ts": { what: "A store's broadcasts, newest first", room: ["lib/broadcasts.ts"] },
  "nl:mail:queue@lib/broadcasts.ts": company("Broadcasts waiting or under way", "One set for every store, each member gone when its broadcast is done; a store's are counted with its broadcasts."),
  "nl:lib:@lib/buyer-library.ts": { what: "The stores an address bought from", parts: [kept(MARK, "A store's id in its buyer's set of the quarter, kept QUARTERS_KEPT quarters at the most (lib/joined-stores.ts): counted as for good, and its whole life priced with its order besides (tests/plan-cost-registry.ts, ORDER_LIBRARY), since it outlives a store that closes.")] },
  "nl:lib:joined:@lib/joined-stores.ts": company("The stores an address joined the list of", "A person's, across stores: one member a store, in the set of the quarter it joined in, kept QUARTERS_KEPT quarters at the most."),
  "nl:lib:link:@lib/buyer-library.ts": short("A library link, a day", "access", 1, LINK_BYTES, MAIL("library")),
  "nl:listed:@lib/buyer-list.ts": short("An order put on the list", "order", 8, MARK),
  "nl:lostdispute:cursor:@lib/refunds.ts": short("Where a job that takes things back left off in a store's lost disputes, when there were more than one run reads", "run", 30),
  "nl:orders:link:@lib/buyer-orders.ts": short("A buyer's purchases link, a day", "access", 1, LINK_BYTES, MAIL("orders")),
  "nl:rl:orders:addr:@lib/buyer-orders.ts": short("Purchase links per address, an hour", "request", 1, KEY, REQ("orders link")),
  "nl:rl:orders:ip:@lib/buyer-orders.ts": short("Purchase links per connection, an hour", "request", 1, KEY, REQ("orders link")),
  "nl:person:@lib/buyer-profile.ts": { what: "Notes about people", room: ["lib/buyer-profile.ts"] },
  "nl:person:find:@lib/buyer-profile.ts": short("A buyer's page found from a search, an hour", "studio", 1, 512),

  // ---------------------------------------------------------------- lib/ c
  "nl:cal:busy:@lib/calendar-sync.ts": { what: "A calendar feed's busy times, ten minutes", parts: [capped(MAX_FEEDS * READING_BYTES, "MAX_FEEDS feeds, each its parsed busy times: at most 2,000 of them.", src("lib/calendar-sync.ts", "MAX_FEEDS"), src("lib/ics-parse.ts", "maxIntervals ?? 2000"))] },
  "nl:cal:cfg:@lib/calendar-sync.ts": { what: "The store's calendar feeds", parts: [capped(MAX_FEEDS * 2 * KB, "MAX_FEEDS addresses.", src("lib/calendar-sync.ts", "MAX_FEEDS"))] },
  "nl:cal:err:@lib/calendar-sync.ts": { what: "A feed's last failure", parts: [capped(MAX_FEEDS * KB, "One per feed, six hours.")] },
  "nl:none@lib/calendar-sync.ts": company("A key that is never written", "Read in place of a list a store does not have."),
  "nl:cal:good:@lib/calendar-sync.ts": { what: "A feed's last good reading", parts: [capped(MAX_FEEDS * READING_BYTES, "One per feed, six hours.", src("lib/calendar-sync.ts", "MAX_FEEDS"))] },
  "nl:cal:lock:@lib/calendar-sync.ts": short("A feed read at a time", "request", 1, 128, REQ("page")),
  // Since 4 November 2026 (C4-4) the last good copy of the store's feed, kept CALENDAR_COPY_SECONDS, at most CALENDAR_MAX_EVENTS events (lib/read-ceilings.ts, CALENDAR_FILE_BYTES).
  "nl:cal:out:@lib/calendar-sync.ts": { what: "The last good copy of the store's calendar file, forty days", parts: [capped(CALENDAR_FILE_BYTES + KB, "One file a store, of what is booked, at its largest.", src("lib/read-ceilings.ts", "CALENDAR_FILE_BYTES"), src("lib/calendar-sync.ts", "CALENDAR_MAX_EVENTS", "CALENDAR_COPY_SECONDS"))] },
  "nl:cal:pace:@lib/calendar-sync.ts": { what: "The feed's answers of the last hour, a sliding hour", parts: [capped(CALENDAR_POLLS_PER_HOUR * 2 * 64 + KEY, "The times of at most CALENDAR_POLLS_PER_HOUR answers (and one refused, taken back), a store, an hour.", src("lib/calendar-sync.ts", "CALENDAR_POLLS_PER_HOUR"))] },
  // C4-33 (a): the feed's answers refused in the hour, counted until the address stops.
  "nl:cal:refused:@lib/calendar-sync.ts": { what: "The feed's answers refused in the last hour", parts: [capped(KEY, "One count a store, an hour.")] },
  "nl:cal:builds:@lib/calendar-sync.ts": { what: "The feed's file made again today, and its credits used", parts: [capped(4 * KEY, "Two counts a store a UTC day, kept two days.")] },
  "nl:cal:chg:@lib/call-records.ts": short("When the store's bookings last changed, by its calls id, forty days; and the day's credits, two days: set at each booking made, moved or let go", "call", 40),
  // C4-4 (owner's decision of 4 November 2026, C4-18): a store's readings of its numbers, kept a day for the pages that show them, and the day's count.
  "nl:reading:@lib/store-readings.ts": { what: "A store's last readings of its visits, sales and memberships, a day", parts: [capped(3 * READING_COPY_MAX_BYTES, "Three readings a store, each at most READING_COPY_MAX_BYTES.", src("lib/store-readings.ts", "READING_COPY_MAX_BYTES", "READING_KEEP_SECONDS"))] },
  "nl:list:try:@lib/store-readings.ts": short("A store with no list: its one try of the day to be given one", "day", 2),
  "nl:reading:day:@lib/store-readings.ts": { what: "A store's readings of the day, and of them the heavy ones", parts: [capped(4 * KEY, "Two counts a store a UTC day, kept two days.")] },
  // C4-33 (4): a product update's searches for its buyers, from a count of their own.
  "nl:cal:tok:@lib/calendar-sync.ts": { what: "The store's calendar file's token", parts: [capped(KEY, "One a store.")] },
  "nl:meet:rf:@lib/call-meetings.ts": short("Refunds already handled for meetings, kept sixty-one days after the last one read", "order", 61, MARK),
  "nl:pkg:@lib/call-packages.ts": { what: "A call package bought", parts: [item(KB, "Its record, a year after its last call: counted as for good.", "call")] },
  "nl:pkg:t:@lib/call-packages.ts": { what: "A call package's token", parts: [item(KEY, "One per package, kept with it.", "call")] },
  "nl:pkg:s:@lib/call-packages.ts": { what: "The packages a store sold, so a closed store finds them (18 October 2026)", parts: [item(160, "A checkout's id in the store's set, one per package.", "call")] },
  "nl:call:moved:@lib/call-records.ts": short("A call moved: its record, kept 200 days by the booking", "call", 200, KB),
  "nl:closed:batch@lib/closed-store-data.ts": company("What the walk needs of each store it deletes, while it runs", "The company's job: a field a closing store, deleted when its walk is done (lib/closed-store-data.ts)."),
  "nl:closed:due@lib/closed-store-data.ts": company("Closed stores waiting for the walk that deletes their records", "The company's job: a member a closed store, taken out when its walk begins."),
  "nl:closed:walk@lib/closed-store-data.ts": company("Where the walk that deletes closed stores' records is", "One key, the company's job."),
  "nl:*@lib/closed-store-data.ts": company("The pattern the walk reads the database by", "Not a key: a pattern."),
  // The families whose keys a closing store's follower reads before the walk deletes them: names, not keys.
  "nl:cal:cfg:@lib/closed-store-data.ts": follower("nl:cal:cfg:"),
  "nl:cm:@lib/closed-store-data.ts": follower("nl:cm:"),
  "nl:course:@lib/closed-store-data.ts": follower("nl:course:"),
  "nl:erase:ix:@lib/closed-store-data.ts": follower("nl:erase:ix:"),
  "nl:fshares:@lib/closed-store-data.ts": follower("nl:fshares:"),
  "nl:inbox:@lib/closed-store-data.ts": follower("nl:inbox:"),
  "nl:learn:passes:@lib/closed-store-data.ts": follower("nl:learn:passes:"),
  "nl:mail:bcs:@lib/closed-store-data.ts": follower("nl:mail:bcs:"),
  "nl:mv:@lib/closed-store-data.ts": follower("nl:mv:"),
  "nl:outreach:@lib/closed-store-data.ts": follower("nl:outreach:"),
  "nl:payreq:s:@lib/closed-store-data.ts": follower("nl:payreq:s:"),
  "nl:agent:book:@lib/agent-book.ts": room("A store's book of the AI agent's proposals and what it did (631 [AA1] (c)), bounded by lib/agent-proposal-rules.ts", "lib/agent-book.ts"),
  "nl:agent:book:lock:@lib/agent-book.ts": short("A store's agent book being changed, a minute at the most", "studio", 1, 128),
  "nl:agree:s:@lib/closed-store-data.ts": follower("nl:agree:s:"),
  "nl:letters:s:@lib/closed-store-data.ts": follower("nl:letters:s:"),
  "nl:pkg:s:@lib/closed-store-data.ts": follower("nl:pkg:s:"),
  "nl:pod:by:@lib/closed-store-data.ts": follower("nl:pod:by:"),
  "nl:ppsell:sales:@lib/closed-store-data.ts": follower("nl:ppsell:sales:"),
  "nl:slink:store:@lib/closed-store-data.ts": follower("nl:slink:store:"),
  "nl:store:leads:@lib/closed-store-data.ts": follower("nl:store:leads:"),
  "nl:@lib/closed-store-data.ts": company("Not a key: the start of every key a follower may delete", "Read only, to check what is deleted."),
  "nl:call:remindq@lib/call-records.ts": company("Call reminders due", "One sorted set for every store, members gone when sent: each a booked call's, an order's."),
  "nl:call:creator-reminded:@lib/call-reminders.ts": short("The creator reminded of a call", "call", 430, 2 * MARK),
  "nl:call:reminded:@lib/call-reminders.ts": short("A buyer reminded of a call", "call", 430, 2 * MARK),
  "nl:call:room:@lib/call-rooms.ts": short("A call's video room, until the call is over", "call", 430, 2 * KEY),
  "nl:call:busy:@lib/calls.ts": { what: "A store's booked calls", parts: [item(512, "One entry per call booked.", "call")] },
  "nl:call:confirmed:@lib/calls.ts": { what: "A call's confirmation sent", parts: [item(MARK, "One per call.", "call")] },
  "nl:call:series:@lib/call-series-open.ts": { what: "A store's call series still running", parts: [item(224, "One member per series booked (lib/order-data.ts charges a ZADD 32 + 8 + 128 bytes, a quarter more), removed with its bytes given back at the next write once its last session is over.", "call")] },
  "nl:call:lock:@lib/calls.ts": short("A store's calls while one is booked", "request", 1, 128, REQ("checkout")),
  "nl:card:link:@lib/card-update.ts": short("A member's link to update their card, sent by email", "own", 21, KEY, MAIL("card")),
  "nl:card:open:@lib/card-update.ts": short("The latest Stripe page made for a card update", "own", 2, KEY, MAIL("card")),
  "nl:card:opens:@lib/card-update.ts": short("Presses of a card link", "own", 21, MARK, MAIL("card")),
  "nl:catalog:@lib/catalog.ts": { what: "Products: their listings, their heavy rest, their cards", room: ["lib/store.ts"], parts: [capped(KEY, "The mark of a catalog moved.")] },
  "nl:cert:@lib/certificate.ts": { what: "Certificates, kept for good", room: ["lib/certificate.ts"] },
  "nl:course:@lib/certificate.ts": { what: "A course's certificates, by student", room: ["lib/certificate.ts"] },
  "nl:cm:@lib/chat-grant.ts": short("A member's leave from the live room's cooldown", "buyer", 1),
  "nl:chatsum:@lib/chat-summary.ts": { what: "Where a chat summary goes, sealed", parts: [capped(KB, "One a store.")] },
  "nl:recover:asks@lib/checkout-ask.ts": company("Checkout asks due", "One sorted set for every store, members gone when asked (a few hours): each a public request's."),
  "nl:none@lib/checkout-recovery.ts": company("A key that is never written", "Read in place of a list a store does not have."),
  "nl:recover:link:@lib/checkout-recovery.ts": short("A stop link of a checkout reminder, 400 days", "own", 400, LINK_BYTES, MAIL("reminder")),
  "nl:recover:off:@lib/checkout-recovery.ts": room("An address that pressed stop, kept for good: its room taken before each reminder is sent (RECOVER_TRACE_BYTES)", "lib/checkout-recovery.ts"),
  "nl:recover:once:@lib/checkout-recovery.ts": short("An address told of a product this week", "own", 8, KEY, MAIL("reminder")),
  "nl:recover:sent:@lib/checkout-recovery.ts": short("A checkout's reminder sent, or found paid", "request", 15, MARK, REQ("checkout")),
  "nl:sweep:cursor@lib/checkout-sweep.ts": company("Where the checkout sweep stopped", "One key, the company's job."),
  "nl:taxobs:v1:@lib/checkout-sweep.ts": room("Inactive diagnostic checkout observations: no production policy. A reviewed synthetic policy reserves its whole bounded document, index and byte count atomically in the existing room before one SET PXAT; at most 300 observations and an absolute expiry within 24 hours. Activation still needs reviewed scope, retention and full-lifetime cost funding.", "lib/checkout-sweep.ts"),
  "nl:wf:abandoned:@lib/checkout-sweep.ts": short("An abandoned checkout noticed", "request", 2, KEY, REQ("checkout")),
  // The reader now selects seven days + last (CHECKOUT_TROUBLE_READ in the
  // plan registry); historical fields are not downloaded. Separate audit gap:
  // renewing the hash TTL does not enforce this legacy per-field storage cap.
  // Bounding the read does not certify the stored-byte allocation below.
  "nl:cotrouble:@lib/checkout-trouble.ts": { what: "Checkouts refused by day, and the last reason", parts: [capped(40 * 64 + KB, "Legacy 35-day allocation; per-field retention remains unverified.")] },
  "nl:cotrouble:mail:@lib/checkout-trouble.ts": short("The day's email about it claimed", "day", 2, 128),
  "nl:imports:cf:@lib/clickfunnels-funnel.ts": { what: "What a ClickFunnels move made, so it is not made twice", parts: [capped((tier) => (IMPORT_ALLOWANCES[tier].funnelSaves * 14 + 1) * 4 * KB, "A record per funnel made, 400 days.", src("lib/import-limits.ts", "IMPORT_ALLOWANCES"))] },
  "nl:imports:cf:lock:@lib/clickfunnels-funnel.ts": short("One move at a time", "studio", 1, 128),

  // community
  "nl:cm:@lib/community-access.ts": { what: "A buyer's ticket answered, the welcome sent", parts: [per("request", 1, 512, "Stripe's answer cached for minutes.", REQ("page")), item(MARK, "The welcome's mark, once per member.", "membership")] },
  "nl:cm:link:@lib/community-access.ts": short("An emailed link into the community, an hour", "access", 1, LINK_BYTES, MAIL("community link")),
  "nl:rl:cm:addr:@lib/community-access.ts": short("Links asked per address, an hour", "request", 1, KEY, REQ("community link")),
  "nl:rl:cm:ip:@lib/community-access.ts": short("Links asked per connection, an hour", "request", 1, KEY, REQ("community link")),
  "nl:cm:@lib/community-chat.ts": {
    what: "The live room: its messages, their counter, each speaker's cooldown",
    parts: [capped(MAX_CHAT_KEPT * (MAX_CHAT_TEXT * 3 + 512), "MAX_CHAT_KEPT messages, the oldest let go.", src("lib/community-chat-rules.ts", "MAX_CHAT_KEPT", "MAX_CHAT_TEXT")), per("buyer", 1, KEY, "A speaker's cooldown, minutes.")],
  },
  "nl:cm:@lib/community-dm.ts": { what: "Private messages, the lists of conversations and requests, who declined whom", room: ["lib/community-dm.ts"] },
  "nl:cm:evmail:@lib/community-event-mail.ts": { what: "An event's emails, and who they go to", parts: [per("own", 30, 512, "Each reader's place in a send, thirty days.", MAIL("event"))] },
  "nl:cm:evmailq@lib/community-event-mail.ts": company("Event sends under way", "One set, members gone when sent."),
  "nl:cm:@lib/community-events.ts": { what: "Events, their places and who is coming", room: ["lib/community-events.ts"] },
  "nl:cm:evq@lib/community-events.ts": company("Event reminders due", "One sorted set for every store, counted with each event's room."),
  "nl:rl:cm:ev:@lib/community-events.ts": short("Event changes an hour", "studio", 1),
  "nl:cimg:@lib/community-files.ts": { what: "Community pictures, their owners and counts", line: "community-pictures" },
  "nl:cimg:doors@lib/community-files.ts": company("Picture doors not yet used, swept a day on", "One sorted set for every store, each door a buyer action's."),
  "nl:cimg:n:@lib/community-files.ts": { what: "A community's pictures counted", parts: [capped(KEY, "One count a store.")] },
  "nl:cm:@lib/community-found.ts": short("A member's ticket for a course in the search, answered", "request", 1, 512, REQ("search")),
  "nl:cm:mail:@lib/community-mail.ts": { what: "An announcement's emails, and who they go to", parts: [per("monthly", 30, 512, "Each reader's place in a send, thirty days.", MAIL("announcement"))] },
  "nl:cm:mailq@lib/community-mail.ts": company("Announcements under way", "One set, members gone when sent."),
  "nl:cm:unsub:@lib/community-mail.ts": { what: "A member's stop link, made once and kept", parts: [item(KEY, "One a member.", "membership")] },
  "nl:cm:@lib/community-mentions.ts": { what: "Members' handles", room: ["lib/community.ts"] },
  "nl:cm:@lib/community-notify.ts": { what: "What happened to each member, and when they last looked", room: ["lib/community-notify.ts"], parts: [item(MARK, "A member's last look.", "membership")] },
  "nl:cm:@lib/community-points.ts": { what: "Points: all-time, by day, by period; rewards; what each member reached", parts: [item(512, "A member's points, their board places and what reached them.", "membership"), per("buyer", 32, 128, "A day's points."), capped(4 * KB, "The rewards a community sets.")] },
  "nl:cm:@lib/community-polls.ts": { what: "Votes and their tallies", room: ["lib/community-polls.ts"] },
  "nl:cm:@lib/community-trace.ts": { what: "What each member wrote and did, by reference, for the copy of their data (619 [SZ3])", room: ["lib/community.ts", "lib/community-polls.ts"] },
  "nl:cm:@lib/community-push.ts": { what: "Members' devices for notifications", room: ["lib/community-push.ts"] },
  "nl:cm:@lib/community-search.ts": { what: "The words posts, lessons, events and members are found by", room: ["lib/community.ts", "lib/course.ts", "lib/community-events.ts"], parts: [per("request", 1, 2 * KB, "One search's working set, a minute.", REQ("search"))] },
  "nl:cm:@lib/community-walk.ts": { what: "Whether a community's index is up to date, and the walk that builds it", parts: [capped(KEY, "One mark a store."), per("studio", 1, 128, "A walk, minutes.")] },
  "nl:cm:@lib/community.ts": {
    what: "The community: settings, posts, feeds, comments, likes, members, reports",
    room: ["lib/community.ts"],
    parts: [
      capped(MAX_SPACES * KB + MAX_QUESTIONS * KB + MAX_WELCOME * 3 + 8 * KB, "The settings, its spaces, questions and welcome.", src("lib/community-text.ts", "MAX_SPACES", "MAX_QUESTIONS", "MAX_WELCOME")),
      capped(MAX_REPORT_QUEUE * KEY, "The reports waiting, the newest MAX_REPORT_QUEUE.", src("lib/community-text.ts", "MAX_REPORT_QUEUE")),
      item(512, "A member's record as they come in, and their place in the directory.", "membership"),
      per("buyer", 90, KEY, "Who reported what, ninety days."),
    ],
  },
  "nl:cm:rl:@lib/community.ts": short("What one member did lately, for the limits", "buyer", 1),
  "nl:mail:unsub:@lib/contacts.ts": { what: "A contact's stop link", room: ["lib/contacts.ts"] },
  "nl:store:leads:@lib/contacts.ts": { what: "The store's list: every contact, and how many agreed and left", room: ["lib/contacts.ts"], parts: [kept(768, "A buyer put on the list: the record, its token and flags."), item(512, "Each product's title and id on it, up to MAX_TITLES.")] },
  "nl:contract-reserve:v1@lib/contract-restart-publication.ts": company("Closed joint funded restart publication in the same ledger", "Same permanent company hash, not a second ledger. One new published receipt at most1536 raw payload bytes per owned restart grant, plus field/hash/replication overhead; existing4096 intent and384 checkpoint remain retained. Clears only the acknowledged pending owner, never source/grant cash or permanent first-owner proof. Lifetime grant/invocation count, retention, copies and all six monthly/annual all-cost totals remain unknown/rejected; coveragefalse before IO.64write/64one-readback ceilings and149publication-stage command envelope are not lifetime/global spend permission."),
  "nl:pause:@lib/contract-restart-publication.ts": { what: "Exact existing pause generation in joint publication", parts: [capped(4 * KB, "Same one-per-store pause, at most1536 raw proof bytes; removed only with acknowledged owned Store/index/receipt publication. No new pause or allocation.")] },
  "nl:pause:due@lib/contract-restart-publication.ts": company("Existing due membership completed by joint publication", "Same sorted set, at most one member per store; exact observed generation is checked before removal. No second index or new due entry. Global cardinality/horizon and command/transfer costs still require funding."),
  "nl:pause:last:@lib/contract-restart-publication.ts": { what: "Retained annual eligibility proof during publication", parts: [capped(KEY, "Same one-per-store marker, read-only and never deleted or rewritten by publication.")] },
  "nl:plan:ended@lib/contract-restart-publication.ts": company("Existing ended-plan index in joint publication", "Same sorted set, at most one member per store; removes this owned store after paid publication. No second index or allocation."),
  "nl:plan:paying@lib/contract-restart-publication.ts": company("Existing paying-store membership in joint publication", "Same company set, at most one member per store; owned active nontrial plan joins with acknowledged publication. No second set; global allocation and write costs remain required."),
  "nl:share:stores@lib/contract-restart-publication.ts": company("Existing sharing-store membership in joint publication", "Same company set, at most one member per store; membership follows the exact retained observed share flag. No second set; global allocation and write costs remain required."),
  "nl:store:lock:@lib/contract-restart-publication.ts": short("Same owned store lock validated by the joint publisher; one15-second lease, no second lock", "studio", 1, 128),
  "nl:store:owner:@lib/contract-restart-publication.ts": { what: "Same bounded owner record in joint funded publication", parts: [capped(MAX_STORE_BYTES + KB, "Same physical one-per-store record, not a copy; exact raw CAS and raw/next ceiling1M with bounded read1000001. Existing creator/catalog fields preserved; transfer/CPU costs are not certified by this storage ceiling.", src("lib/store.ts", "MAX_STORE_BYTES"))] },
  "nl:contract-reserve:v1@lib/contract-funding-rules.ts": company("The company's contract reserve", "The company's ledger."),
  "nl:contract-reserve:v1@lib/contract-resource-window.ts": company("Paid resource cohorts in the company contract reserve", "Same permanent contract hash, not another ledger. At most one field per monthly grant or twelve per annual grant; field and value at most140 raw bytes per cohort. Every grant, slot and cash principal is retained. Redis overhead, copies and retention costs remain unknown/rejected in AB(a), never zero or a certified storage allocation."),
  "nl:contract-reserve:v1@lib/contract-restart-activation.ts": company("Closed restart activation in the existing contract ledger", "Same permanent hash. Writes the existing activated grant family and active pointer with a binding at most256 raw bytes, plus one at-most384-byte observed renewal/share checkpoint per restart grant and matching flags within the existing4096-byte intent cap, retaining pending/source/index/cash/receipts. No TTL, release, second ledger or new funded slot. Lifetime cardinality, Redis overhead, copies, retention and full-stage polling costs remain unknown/rejected; pauseRestart=false before IO. Command ceiling17 per stage requires actual Redis INFO, not whole-flow approval."),
  "nl:contract-reserve:v1@lib/contract-funding.ts": company("The company's contract reserve", "Same permanent ledger; restart intent adds at most one4096-byte payload (including one-way submission state,256-byte headroom, retained provider ID and at most3 recovery-read reservations) per reserved restart grant, retains all source/cash/pending proofs and has no TTL. One permanent restart-owner index per original source grant adds at most182 raw field+value bytes, with unknown Redis overhead/retention explicitly rejected. Actual command ceiling17 per stage is tested with Redis INFO, including the original activated source and already-activated owner proof during recovery; it is not the whole-flow total. Per-grant cardinality, Redis overhead, copies and permanent retention must be quoted and prefunded in AB(a); unknown remains rejected and coveragefalse, never zero or a certified storage allocation."),
  "nl:course:@lib/course-finish.ts": short("A student who opened, or finished, a course", "order", 400, 2 * MARK),
  "nl:course:@lib/course.ts": { what: "Courses: outlines and lessons' text", room: ["lib/course.ts"] },
  "nl:ref:cursor@lib/creator-invite-credit.ts": company("Where the invite credit job stopped", "One key, the company's job."),
  "nl:ref:all@lib/creator-invites.ts": company("Creators' invitations", "The company's program for creators."),
  "nl:ref:by:@lib/creator-invites.ts": company("Who invited a creator", "The company's program for creators."),
  "nl:ref:c:@lib/creator-invites.ts": company("A credit owed", "The company's program for creators."),
  "nl:ref:code:@lib/creator-invites.ts": company("An invitation code", "The company's program for creators."),
  "nl:ref:list:@lib/creator-invites.ts": company("A creator's invitations", "The company's program for creators."),
  "nl:ref:mine:@lib/creator-invites.ts": company("A creator's credits", "The company's program for creators."),
  "nl:ref:mycode:@lib/creator-invites.ts": company("A creator's code", "The company's program for creators."),
  "nl:ref:owed@lib/creator-invites.ts": company("Credits owed", "The company's program for creators."),
  "nl:creators:responses@lib/creator-research-store.ts": company("Answers to the creators' survey", "The company's own research."),
  "nl:crm:deals:@lib/crm.ts": { what: "Deals: one slot a deal, at what it weighs, at most MAX_DEALS", room: ["lib/crm.ts"] },
  "nl:crm:tasks:@lib/crm.ts": {
    what: "Tasks about a person, at what they weigh, at most MAX_STORE_TASKS, and the store's count of them (TASK_COUNT_WEIGHT)",
    room: ["lib/crm.ts"],
    // room + TASK_COUNT_WEIGHT: a paid recount saves the count and notes its field even past a full room (noteData, never refused), so at most this much over the room, once a store.
    parts: [capped(TASK_COUNT_WEIGHT, "The count's field noted once past a full room, when a paid recount saves it.", src("lib/crm.ts", "TASK_COUNT_WEIGHT", "noteData(room, [{ slot: TASKS_SLOT, bytes: TASK_COUNT_WEIGHT }])"))],
  },
  "nl:crm:tasks:@lib/person-agenda-read.ts": { what: "Tasks about a person, only counted here (one HLEN, tasksKept) before the agenda reads them; kept and counted by lib/crm.ts", room: ["lib/crm.ts"] },
  "nl:crm:tasklock:@lib/crm.ts": short("One change of a store's tasks at a time, ten seconds at the most", "studio", 1, 128),
  "nl:crm:taskrecount:@lib/crm.ts": short("One paid recount of a store's tasks at a time, thirty seconds at the most", "studio", 1, 128),
  "nl:crm:fields:@lib/crm.ts": { what: "The store's own fields", parts: [capped(MAX_CRM_FIELDS * (MAX_FIELD_OPTIONS + 2) * 160, "MAX_CRM_FIELDS fields and their choices.", src("lib/crm-rules.ts", "MAX_CRM_FIELDS", "MAX_FIELD_OPTIONS"))] },
  "nl:crm:stages:@lib/crm.ts": { what: "The first pipeline's stages, as the board kept them before pipelines", parts: [capped(MAX_STAGES * 256, "MAX_STAGES stages.", src("lib/crm-rules.ts", "MAX_STAGES"))] },
  "nl:crm:pipes:@lib/crm.ts": { what: "The deals' pipelines and their stages (17 October 2026): one slot, at what the record weighs", room: ["lib/crm.ts"] },
  "nl:crm:pacc:@lib/pipeline-access.ts": { what: "What each teammate may do with each pipeline, only where restricted", room: ["lib/pipeline-access.ts"] },
  "nl:crm:v:@lib/crm.ts": { what: "People's values of the store's fields", room: ["lib/crm.ts"] },
  "nl:vcard:@lib/creator-card.ts": { what: "The creator's business card, as they typed it", room: ["lib/creator-card.ts"] },
  "nl:voice:@lib/customer-voice.ts": { what: "What buyers said, summed up a month", parts: [capped(14 * 16 * KB, "One summary a month, 400 days.")] },
  "nl:voice:lock:@lib/customer-voice.ts": short("One summary at a time", "studio", 1, 128),
  "nl:rsum:@lib/review-ai-summary.ts": short("A product's AI summary of its reviews, kept eight days: its head (under 400 bytes) and its themes' sorted set (:themes), at most three entries of under 1,000 bytes each (the kept one, the one being kept, and one a failed clean-up left, taken out by the next try)", "studio", 8, 4 * KB),
  "nl:rsum:@lib/reviews.ts": short("The same summary: its themes removed here by a review they counted that is deleted, hidden, refunded or rewritten; head and themes deleted with the product's reviews", "studio", 8, 4 * KB),
  "nl:rsum:lock:@lib/review-ai-summary.ts": short("One review summary at a time, two minutes", "studio", 1, 128),
  "nl:rsum:last:@lib/review-ai-summary.ts": short("When a product's last AI summary of its reviews was made, kept eight days and not deleted with the summary, so the week's limit holds", "studio", 8, 64),
  "nl:rsum:ver:@lib/review-ai-summary.ts": short("A random mark of a product's reviews, read and checked in the same step as keeping a summary", "studio", 8, 64),
  "nl:rsum:ver:@lib/reviews.ts": short("The same mark, set new each time a review a summary may count is deleted, hidden, refunded or rewritten", "studio", 8, 64),

  // ---------------------------------------------------------------- lib/ d–f
  "nl:store:delivery:@lib/delivery.ts": { what: "Bytes delivered, by the month", parts: [capped(14 * KEY, "One count a month, 400 days.")] },
  "nl:store:delivery:over:@lib/delivery.ts": company("The stores past their deliveries, a month", "One set a month for every store."),
  "nl:store:folder-owner:@lib/delivery.ts": { what: "Whose folder this is", parts: [capped(KEY, "One a store.")] },
  "nl:house:seed:lock@lib/demo-seed.ts": lock("The demo store's seeding"),
  "nl:house:seed@lib/demo-seed.ts": company("The demo store's seeding", "The company's own demo store."),
  "nl:dir:listed@lib/directory-index.ts": company("The stores listed in the directory", "One set for every store."),
  "nl:dir:page@lib/directory-index.ts": company("The directory's page, cached", "The company's own page."),
  "nl:dc:ok:@lib/discord-access.ts": short("A buyer's Discord access, answered", "request", 1, 512, REQ("page")),
  "nl:dc:addr:@lib/discord-store.ts": { what: "The Discord account an address brought in", parts: [item(KEY, "One a buyer.", "membership")] },
  "nl:dc:due@lib/discord-store.ts": company("Discord members to check next", "One sorted set for every store, a member each: an order's."),
  "nl:dc:mem:@lib/discord-store.ts": { what: "Each person given roles", parts: [item(512, "One a buyer: their roles.", "membership")] },
  "nl:dc:prod:@lib/discord-store.ts": { what: "The roles a product gives: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:dc:srv:@lib/discord-store.ts": { what: "The creator's server", parts: [capped(2 * KB, "One a store.")] },
  "nl:dc:state:@lib/discord-store.ts": short("A trip to Discord and back, ten minutes", "integration", 1, 512),
  "nl:domain:@lib/domains.ts": { what: "The store's own domain", parts: [capped(KB, "One a store.")] },
  "nl:dun:@lib/dunning-keys.ts": short("A failed renewal's reminder sent, by email", "own", 60, MARK, MAIL("failed payment")),
  "nl:dun:count:@lib/dunning-keys.ts": { what: "Reminders counted a month", parts: [capped(14 * KEY, "One a month.")] },
  "nl:esync:bad:@lib/email-sync.ts": { what: "The last problem with the email platform", parts: [capped(KB, "One a store.")] },
  "nl:esync:cfg:@lib/email-sync.ts": { what: "The email platform's settings", parts: [capped(4 * KB, "One a store.")] },
  "nl:esync:j:@lib/email-sync.ts": { what: "One sync job and how it went, a week", parts: [per("order", 7, KB, "A buyer's job."), per("access", 7, KB, "A sign-up confirmed by email.", MAIL("join"))] },
  "nl:esync:log:@lib/email-sync.ts": { what: "The store's last jobs", parts: [capped(SYNC_LOG * 64, "The newest LOG_SIZE.", src("lib/email-sync.ts", "LOG_SIZE"))] },
  "nl:esync:q@lib/email-sync.ts": company("Sync jobs waiting", "One sorted set, members gone within a week."),
  "nl:esync:seen:@lib/email-sync.ts": { what: "A person and event already sent", parts: [per("order", 30, MARK, "A buyer."), per("access", 30, MARK, "A sign-up confirmed by email.", MAIL("join"))] },
  "nl:esync:tags:@lib/email-sync.ts": { what: "Tag ids learned from the email platform, per product: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:erased:@lib/suppression.ts": { what: "A deleted person's fingerprint, so the store never writes to them again: kept in place of their contact, whose room in the data room is not given back, and is more", room: ["lib/contacts.ts"] },
  "nl:none@lib/suppression.ts": company("A key that is never written", "Read in place of a list a store does not have."),
  "nl:sender:@lib/email.ts": company("Emails handed to the sender, a month", "One count a month, the company's."),
  "nl:ses:once:@lib/email.ts": company("An email already handed over", "The company's, minutes."),
  "nl:ses:rest:@lib/email.ts": company("A batch's rest already handed over", "The company's, minutes."),
  "nl:ses:told:@lib/email.ts": company("The owner told of the sender", "One key a day, the company's."),
  "nl:@lib/erasure-index.ts": company("Not a key: the start every key noted for a deletion must have", "Read only, to check what is deleted."),
  "nl:erase:ix:@lib/erasure-index.ts": {
    what: "The records made for one address, so deleting the person finds them: each noted with when, and let go INDEX_SECONDS after",
    parts: [
      per("order", 401, MARK, "A free copy's link noted."),
      per("own", 401, MARK, "A link in one of the store's own emails noted."),
      per("access", 401, MARK, "A link in an access email noted."),
      per("monthly", 401, MARK, "A link in a monthly email noted."),
    ],
  },
  "nl:transparency:@lib/transparency.ts": company("The public transparency page's counts: notices received and acted on, year by year (624 [SZ8](47))", "The company's: one hash and one set of notice ids a year, nothing about any store or person."),
  "nl:transparency:acted:@lib/transparency.ts": company("The notices acted on each year, so each counts once", "The company's: notice ids only, one set a year."),
  "nl:transparency:since@lib/transparency.ts": company("The day counting began", "The company's: one key for the whole platform, a date and nothing else."),
  "nl:erase:link:@lib/erasure-request.ts": company("A person's link to delete themselves from the stores they ask, an hour", "A person's, across stores, behind a per-address limit."),
  "nl:held:walk@lib/plan-closing.ts": company("Final closing continuation", "One global rank cursor, at most1KiB,30days TTL; resumes past a full first page of coverage holds. Partial/changing walks never certify a monthly complete observation; included in HELD_EXPOSURE."),
  "nl:held:stores@lib/held-stores.ts": company("Held closing stores awaiting complete billing evidence", "One private reference up to1280bytes plus score/member overhead per existing obligation; funded post_cancellation case ceiling bounds financed cases, overflow stays counted and funding is unknown. Pruned on deletion; never expires an unresolved obligation. Cost in HELD_EXPOSURE of tests/plan-cost-registry.ts."),
  "nl:held:retry:@lib/held-stores.ts": company("Daily held recheck claims", "At most HELD_RECHECKS_PER_DAY hashed identities and one count, two days TTL (up to3 dated hashes overlap). Global funded work ceiling; no raw store/address in the hash. Cost in HELD_EXPOSURE."),
  "nl:held:month:@lib/held-stores.ts": company("Monthly held store aggregate", "Count, observed peak, last observation day and completeness only; at most15 monthly keys alive for400days. Cost in HELD_EXPOSURE; unknown/partial is never zero."),
  "nl:forget:q@lib/store-forget-retry.ts": company("Deleted stores whose webhooks, API keys and assistant notes are tried again", "One field a deleted store whose first try failed, its stats id and id with a count and two times (under 160 bytes); taken out when done, or moved to nl:forget:kept after FORGET_TRIES tries. Only deletes that failed add to it."),
  "nl:forget:kept@lib/store-forget-retry.ts": company("Deleted stores whose webhooks and API keys were given up after every try", "One field a given-up deleted store (under 160 bytes), never read by the daily run; kept on purpose for the owner's report until it is acted on. Only deletes that failed FORGET_TRIES times add to it."),
  "nl:forget:month:@lib/store-forget-retry.ts": company("Monthly counts of deleted stores' forgetting tried again", "Three counts a month, no store or person; at most 14 monthly keys alive for 400 days."),
  "nl:exposure:v1:YYYY-MM@lib/exposure-budget-policy.ts": company("The exposure ledger's name", "The company's ledger."),
  "nl:exposure:v1:@lib/exposure-budget.ts": company("The company's exposure ledger, a month", "The company's ledger, carried by its fixed costs."),
  "nl:fair:c:@lib/fair-coupon.ts": { what: "A fair-price coupon made on the creator's Stripe", parts: [capped(96 * KEY, "One per percent offered.")] },
  "nl:mail:flows:@lib/flow-list.ts": { what: "The store's workflows", room: ["lib/flows.ts"] },
  "nl:wf:day:@lib/flow-runs.ts": short("Runs started and refused a day", "day", 3, 128),
  "nl:wf:held:@lib/flow-runs.ts": { what: "Held runs", room: ["lib/flows.ts"] },
  "nl:wf:log:@lib/flow-runs.ts": { what: "A run's history", room: ["lib/flows.ts"] },
  "nl:wf:run:@lib/flow-runs.ts": { what: "A run", room: ["lib/flows.ts"] },
  "nl:wf:runs:@lib/flow-runs.ts": { what: "A workflow's runs", room: ["lib/flows.ts"] },
  "nl:mail:flowstats:@lib/flow-stats.ts": { what: "A workflow's counts", parts: [capped(20 * KB, "A hash of counts for each of MAX_FLOWS.", src("lib/flow-limits.ts", "MAX_FLOWS"))] },
  "nl:mail:enr:@lib/flows.ts": { what: "Who started a workflow, 400 days", room: ["lib/flows.ts"] },
  "nl:flow-rotate:@lib/flows.ts": short("A store's lock while a workflow step shares its deals: one key a store, ROTATE_LOCK_SECONDS (two minutes), counted as if each run left one for a day", "run", 1, 128),
  "nl:mail:flowq:lease@lib/flows.ts": company("Steps being worked on", "One sorted set, minutes."),
  "nl:mail:flowq@lib/flows.ts": { what: "Steps due", room: ["lib/flows.ts"] },
  "nl:mail:flows:@lib/flows.ts": { what: "The store's workflows", room: ["lib/flows.ts"] },
  "nl:mail:flowstats:@lib/flows.ts": { what: "A workflow's counts", parts: [capped(KB, "Counted with flow-stats.")] },
  "nl:crm:deals:@lib/form-opportunity.ts": { what: "Deals made from forms: counted as every deal is", room: ["lib/form-opportunity.ts"] },
  "nl:form:r:@lib/form-store.ts": { what: "Forms' answers", room: ["lib/form-store.ts"] },
  "nl:forms:@lib/form-store.ts": { what: "The store's forms", parts: [capped(MAX_FORMS * (MAX_FIELDS * (MAX_OPTIONS + 2) * 240 + MAX_OUTCOMES * 2 * KB + 4 * KB), "MAX_FORMS forms, each its fields, choices and results.", src("lib/forms.ts", "MAX_FORMS", "MAX_FIELDS", "MAX_OPTIONS", "MAX_OUTCOMES"))] },
  "nl:plan:paying@lib/free-pool-rules.ts": company("The stores that pay", "One set for every store."),
  "nl:free:in:@lib/free-pool.ts": company("A store that pays nothing's place, a month", "The company's shared places (lib/free-pool-rules.ts)."),
  "nl:free:n:@lib/free-pool.ts": company("The places taken, a month", "The company's."),
  "nl:free:claim:@lib/free.ts": short("A free copy's link, seven days: each free copy is an order", "order", 7, 512),
  "nl:free:uses:@lib/free.ts": short("Uses of a free copy's link, seven days", "order", 7, MARK),
  "nl:rl:free:addr:@lib/free.ts": short("Free copies per address", "request", 1, KEY, REQ("free copy")),
  "nl:rl:free:ip:@lib/free.ts": short("Free copies per connection", "request", 1, KEY, REQ("free copy")),
  "nl:forms:@lib/funnel-form-review.ts": { what: "Forms read for a funnel's review", parts: [capped(0, "Read only: counted with lib/form-store.ts.")] },
  "nl:product:page:@lib/funnel-form-review.ts": { what: "Pages read for a funnel's review", parts: [capped(0, "Read only: counted with lib/sales-page-store.ts.")] },
  "nl:fshare:@lib/funnel-share-store.ts": { what: "Share links and their snapshots", line: "funnel-share" },
  "nl:fshare:n:@lib/funnel-share-store.ts": short("A link's reads counted a month", "day", 62, 128),
  "nl:fshares:@lib/funnel-share-store.ts": { what: "A store's share links", line: "funnel-share" },
  "nl:copy:@lib/store-copy.ts": room("A copy of a whole store's progress, seven days, counted in the receiving store's data room until it goes", "lib/store-copy.ts"),
  "nl:copy:lock:@lib/store-copy.ts": short("One step of a store copy at a time, a minute", "studio", 1, 128),
  "nl:fuse:@lib/funnel-share-store.ts": { what: "A store's imports and previews counted, by the share and the month", parts: [capped(64 * KEY, "A count a share link used and a month, two months.")] },
  "nl:fuse:m:@lib/funnel-share-store.ts": short("A store's uses counted a month", "day", 62, 128),

  // ---------------------------------------------------------------- lib/ g–l
  "nl:gift:@lib/gifts.ts": { what: "Gifts: the gift, its payment, the refunds read", parts: [per("order", 400, 2_560, "A gift and its payment: two addresses, a message of MAX_GIFT_MESSAGE and a name of MAX_GIFT_FROM in any script, GIFT_KEPT_SECONDS.", KIND("gift")), capped(2 * KEY + 64 * KB, "The store's marks and the refunds already handled (thirty days).")] },
  "nl:gift:pi:@lib/gifts.ts": short("The gift a payment paid for", "order", 400, KEY, KIND("gift")),
  "nl:grp:@lib/group-buy.ts": { what: "Purchases for several people: the purchase, who took a place, the emails, the refunds read", parts: [per("order", 400, KB, "A purchase and each place taken in it (each place is an order, and takes a member of at most an address).", KIND("group")), capped(2 * KEY + 64 * KB, "The store's marks and the refunds already handled."), per("store", 1, MARK, "Today's emails of a link.", MAIL("place"))] },
  "nl:grp:pi:@lib/group-buy.ts": short("The purchase a payment paid for", "order", 400, KEY, KIND("group")),
  "nl:grp:take:@lib/group-buy.ts": short("A place's link", "store", 30, LINK_BYTES, MAIL("place")),
  "nl:ab:@lib/headline-test.ts": room("A headline test's counts: counted with its page while it runs, and on their own after (AB_RECORD_BYTES)", "lib/sales-page-store.ts"),
  "nl:ab:paid:@lib/headline-test.ts": short("A checkout counted in a test", "order", 40, MARK),
  "nl:heard:done:@lib/heard.ts": short("A buyer asked how they heard", "order", 30, MARK),
  "nl:heard:off@lib/heard.ts": company("Stores that switched the question off", "One set for every store."),
  "nl:hostcal:cfg:@lib/host-calendar.ts": { what: "Each host's calendar", parts: [capped((MAX_TEAM + 1) * 4 * KB, "One per host, the store's team.", src("lib/team.ts", "MAX_TEAM"))] },
  "nl:hostcal:err:@lib/host-calendar.ts": { what: "A host's last failure", parts: [capped((MAX_TEAM + 1) * KB, "One per host, seven days.")] },
  "nl:hostcal:good:@lib/host-calendar.ts": { what: "A host's last reading", parts: [capped((MAX_TEAM + 1) * READING_BYTES, "One per host, seven days: at most 2,000 busy times.", src("lib/team.ts", "MAX_TEAM"), src("lib/ics-parse.ts", "maxIntervals ?? 2000"))] },
  "nl:hostcal:lock:@lib/host-calendar.ts": short("One reading at a time", "request", 1, 128, REQ("page")),
  "nl:host:claims:@lib/host-claims.ts": short("A host's claimed times: a booking's claim on each host, until the call is over", "call", 430, 512),
  "nl:imp:buy:@lib/imported-purchases.ts": { what: "What an import or the API gave an address, and what an order gave", room: ["lib/imported-purchases.ts"], parts: [kept(512, "A gift's, a place's, a pre-order's or a PayPal purchase's grant.")] },
  "nl:imp:who:@lib/imported-purchases.ts": { what: "The buyers an import brought over", room: ["lib/imported-purchases.ts"] },
  "nl:import:@lib/imports.ts": { what: "An import job: its rows until they are brought in, what it saw, its errors, its emails", parts: [per("row", 3, IMPORT_ROW_BYTES + 128, "A row as it came in, kept at most RAW_DAYS (an upload counts a row for every IMPORT_ROW_BYTES it carries)."), per("row", 14, 560, "Its mark among the rows seen, and its line in the report.")] },
  "nl:imports:active@lib/imports.ts": company("Imports under way", "One set, members gone when done."),
  "nl:imports:busy:@lib/imports.ts": short("One import at a time", "studio", 1, 128),
  "nl:imports:list:@lib/imports.ts": { what: "A store's imports", parts: [capped((tier) => IMPORT_ALLOWANCES[tier].starts * 14 * 512, "One entry per start, 400 days.", src("lib/import-limits.ts", "IMPORT_ALLOWANCES"))] },
  "nl:imports:moved:@lib/imports.ts": short("People brought over and emailed, a month", "day", 62, 128),
  "nl:imports:rows:@lib/imports.ts": short("Rows counted in the window", "day", 62, 128),
  "nl:inbox:@lib/inbox.ts": { what: "The inbox: conversations and their messages", room: ["lib/inbox.ts"] },
  "nl:inbox:tok:@lib/inbox.ts": { what: "What a visitor's chat opens", room: ["lib/inbox.ts"] },
  "nl:intro:c:@lib/intro-coupon.ts": { what: "An introductory price's coupon: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:course:@lib/learn.ts": { what: "A course's students, what they marked done, who is blocked, the drip emails sent", room: ["lib/learn.ts"], parts: [per("store", 400, MARK, "A drip email's mark.", MAIL("drip"))] },
  "nl:courses:drip@lib/learn.ts": company("Courses with drip emails", "One set for every store."),
  "nl:learn:enr:@lib/learn.ts": { what: "What a buyer is enrolled in", parts: [kept(KEY, "The record itself, one a buyer."), item(128, "Each product's place in it.")] },
  "nl:learn:link:@lib/learn.ts": short("A course link and its opens, an hour", "store", 1, LINK_BYTES, MAIL("course link")),
  "nl:learn:passes:@lib/learn.ts": { what: "The passes a buyer was given, so a deletion can find them", parts: [per("store", 90, MARK, "A pass's place, ninety days.", MAIL("course link"))] },
  "nl:learn:paid:@lib/learn.ts": short("A buyer's paid courses, ten minutes", "request", 1, 2 * KB, REQ("page")),
  "nl:learn:pass:@lib/learn.ts": short("A buyer's pass into the store, ninety days, from an emailed link", "store", 90, LINK_BYTES, MAIL("course link")),
  "nl:learn:rate:addr:@lib/learn.ts": short("Links asked per address", "request", 1, KEY, REQ("course link")),
  "nl:learn:rate:ip:@lib/learn.ts": short("Links asked per connection", "request", 1, KEY, REQ("course link")),
  "nl:leave:@lib/leave-flow.ts": short("Leavers counted a month", "day", 62, 128),
  "nl:lc:@lib/lesson-comment-notify.ts": short("A student told of an answer, once in a while", "buyer", 1),
  "nl:lc:@lib/lesson-comments.ts": { what: "Lesson comments", room: ["lib/lesson-comments.ts"] },
  "nl:keys:@lib/licence-keys.ts": { what: "License keys: the pool, every key added, who got which", room: ["lib/licence-keys.ts"], parts: [item(512, "A key given: its record and who got it.", "membership"), capped(64 * KB, "The refunds already handled (sixty-one days after the last one read) and the marks.")] },
  // ---------------------------------------------------------------- lib/ m
  "nl:mail:clk:@lib/mail-clicks.ts": short("The emails whose links a person used, ninety days", "monthly", 90, 128, MAIL("list")),
  "nl:mail:mk:@lib/mail-clicks.ts": { what: "The stop token a link key was made from: one a contact, counted with it (TOKEN_BYTES)", room: ["lib/contacts.ts"] },
  "nl:mail:drafts:@lib/mail-drafts.ts": { what: "Email drafts", parts: [capped(MAX_DRAFTS * (MAX_MAIL_BODY * 3 + 2 * KB), "MAX_DRAFTS drafts.", src("lib/mail-drafts.ts", "MAX_DRAFTS"), src("lib/mail.ts", "MAX_MAIL_BODY"))] },
  "nl:mail:health:@lib/mail-health.ts": { what: "Sent, bounced and complained, by the day; addresses already counted", parts: [per("day", 33, 128, "A day's counts."), per("monthly", 33, MARK, "An address counted this week.", MAIL("list"))] },
  "nl:mail:paused:@lib/mail-health.ts": { what: "Why sending is paused", parts: [capped(KB, "One a store.")] },
  "nl:mail:ramp:@lib/mail-health.ts": { what: "The portion being sent", parts: [capped(KB, "One a store.")] },
  "nl:stats:@lib/mail-revenue.ts": { what: "What emails sold, cached; visits from emails", parts: [capped(2 * 256 * KB, "Two cached views.")] },
  "nl:mail:day:@lib/mail.ts": company("Emails sent a day", "One count a day, the company's."),
  "nl:mail:used:@lib/mail.ts": { what: "Monthly emails used in the window", parts: [capped(14 * KEY, "One a window.")] },
  "nl:sender:@lib/mail.ts": company("The owner told of the sender's month", "The company's."),
  "nl:meet:conn:@lib/meet-connect.ts": { what: "Connections to Zoom and Google, the store's and each host's", parts: [capped((MAX_TEAM + 2) * 2 * 4 * KB, "Two providers, the store and each host.", src("lib/team.ts", "MAX_TEAM"))] },
  "nl:meet:log:@lib/meet-connect.ts": { what: "The store's last problems", parts: [capped(20 * KB, "The newest LOG_SIZE.", src("lib/meet-connect.ts", "LOG_SIZE"))] },
  "nl:meet:refresh:@lib/meet-connect.ts": short("A token being refreshed", "integration", 1, 128),
  "nl:meet:state:@lib/meet-connect.ts": short("A consent in progress, ten minutes", "integration", 1, 512),
  "nl:teams:state:@lib/microsoft-teams-pending-state.ts": short("Teams consent pending: sealed at most2048bytes plus key/Redis overhead, TTL600seconds; one reserved integration unit before each write; inactive until real budget wiring", "integration", 1, 4096),
  "nl:meet:test:@lib/meet-connect.ts": short("A connection tested", "integration", 1),
  "nl:meet:user:@lib/meet-connect.ts": company("The stores a Zoom user connected", "Per Zoom user, for Zoom's uninstall notice."),
  "nl:meet:lock:@lib/meet-links.ts": short("A meeting being made", "integration", 1, 128),
  "nl:meet:stores@lib/meet-links.ts": company("Stores with meetings to tidy", "One sorted set for every store."),
  "nl:meet:q@lib/meet-records.ts": company("Meeting records due", "One sorted set for every store: each a booked call's or an event's."),
  "nl:meet:r:@lib/meet-records.ts": short("A meeting's record: a booked call's (a group call's time keeps its guests), until 60 days after it", "call", 430, 1536),
  "nl:health:@lib/member-health.ts": { what: "Members' scores, cached", parts: [capped(512 * KB, "One cached view.")] },
  "nl:nudge:@lib/member-nudge.ts": short("A member nudged by email before a renewal", "own", 400, MARK, MAIL("nudge")),
  "nl:nudge:count:@lib/member-nudge.ts": short("Nudges counted a month", "day", 62, 128),
  "nl:nudge:cursor@lib/member-nudge.ts": company("Where the nudge job stopped", "One key, the company's job."),
  "nl:member:status:@lib/membership-access.ts": short("A membership's status, cached two minutes", "request", 1, KEY, REQ("page")),
  "nl:manage:link:@lib/membership-manage.ts": short("A member's link to manage", "access", 1, LINK_BYTES, MAIL("manage")),
  "nl:manage:opens:@lib/membership-manage.ts": short("Opens of that link", "access", 1, KEY, MAIL("manage")),
  "nl:manage:portal:@lib/membership-manage.ts": { what: "A member's portal settings, cached", parts: [capped(8 * 2 * KB, "One per language.")] },
  "nl:rl:manage:addr:@lib/membership-manage.ts": short("Links asked per address", "request", 1, KEY, REQ("manage")),
  "nl:rl:manage:ip:@lib/membership-manage.ts": short("Links asked per connection", "request", 1, KEY, REQ("manage")),
  "nl:save:@lib/membership-manage.ts": { what: "A save offer made to a member", parts: [item(MARK, "One per membership.", "membership")] },
  "nl:mnum:@lib/membership-numbers.ts": { what: "Membership numbers, cached", parts: [capped(512 * KB, "One cached view.")] },
  "nl:metaads:conn:@lib/meta-ads.ts": { what: "The Meta ads connection", parts: [capped(4 * KB, "One a store.")] },
  "nl:metaads:read:@lib/meta-ads.ts": { what: "When Meta was last read", parts: [capped(KB, "One a store.")] },
  "nl:metaads:reading:@lib/meta-ads.ts": short("A reading under way", "integration", 1, 128),
  "nl:metaads:state:@lib/meta-ads.ts": short("A consent in progress", "integration", 1, 512),
  "nl:metaads:stores@lib/meta-ads.ts": company("Stores connected to Meta", "One set for every store."),
  "nl:metaads:user:@lib/meta-ads.ts": company("The stores a Meta user connected", "Per Meta user."),
  "nl:stats:@lib/meta-ads.ts": { what: "What Meta says the ads spent", parts: [capped(KEPT_DAYS * 256, "A line a day.", src("lib/stats.ts", "KEPT_DAYS"))] },
  "nl:mv:@lib/move-members.ts": room("Members invited over from another platform", "lib/move-members.ts"),
  "nl:mv:due@lib/move-members.ts": company("Invites to remind", "One sorted set for every store, each an invite's."),
  "nl:mv:link:@lib/move-members.ts": room("An invite's link, until a while after the renewal it is for", "lib/move-members.ts"),
  // ---------------------------------------------------------------- lib/ n–p
  "nl:next:@lib/next-bought.ts": { what: "What buyers bought next, cached", parts: [capped(256 * KB, "One cached view.")] },
  "nl:next:lock:@lib/next-bought.ts": short("One reading at a time", "studio", 1, 128),
  "nl:nlink:@lib/numbers-links.ts": { what: "A numbers link", parts: [capped(20 * KB, "The store's links (MAX on the store record).")] },
  "nl:nlink:opens:@lib/numbers-links.ts": short("A link's opens, by the day", "request", 2, 128, REQ("numbers link")),
  "nl:orders:n:@lib/order-admission.ts": { what: "Orders counted in the window", parts: [capped(14 * KEY, "One count a window, 400 days.")] },
  "nl:orders:open:@lib/order-admission.ts": { what: "Checkouts held, and the bytes they hold, by the hour", parts: [capped(2 * (26 * 64 + KEY), "Two hashes of the last 25 hours.")] },
  "nl:orders:pending:@lib/order-admission.ts": { what: "Orders paid while a paying store's billing window was unknown, until it is known", parts: [capped(KEY, "One count a store, emptied by the next admission or order once the window is known.")] },
  "nl:orders:folders:@lib/orders.ts": company("The stores with orders, a month", "One set a month for every store."),
  "nl:orders:n:@lib/orders.ts": { what: "Orders counted in the window", parts: [capped(0, "Counted with lib/order-admission.ts.")] },
  // Only the LIVE legacy countOrder('1') is priced by this 45-day part.
  // The unconnected checkpoint writes a different 68-byte OCI/OC1 value:
  // fixed original window end +400 days, at most767 from capture, with23
  // Redis commands for first application and200-byte MEMORY in one fixture.
  // These are not a universal byte quote or funding for the new path; other
  // counters/indexes can lack TTL after partial Lua failure. Keep that tail
  // unknown/rejected, not priced as45days, bounded by receipt or called zero.
  "nl:orders:seen:@lib/orders.ts": short("LIVE legacy counted-order marker only: '1' for45days. The constructed/unconnected checkpoint OCI/OC1 intent/receipt is68bytes and expires at ORIGINAL window end +400days (cap767from capture); its measured23commands/200-byte fixture and partial-error reconciliation tail remain outside this legacy price, unknown/unfunded.", "order", 45, MARK),
  "nl:store:folder-owner:@lib/orders.ts": { what: "The new checkpoint's writer of the EXISTING folder-owner index; no second key or paid room", parts: [capped(0, "Same key already counted once by nl:store:folder-owner:@lib/delivery.ts. This writer is unconnected; its new command path and partial-failure retention are not certified by the existing key's byte allocation.")] },
  "nl:resend-budget:{@lib/resend-fallback-budget.ts": company("Built, inactive account-wide fallback financial ledger and claims", "One account-hash-tagged company ledger HASH, schema1/10fields with no TTL, and claim HASHes keyed by send-intent SHA-256, schema2/15fields. Claims bind account/attempt/payload fingerprints, units, reservation token, exclusive dispatch token, original period/deadline and outcome timestamps; hashes are pseudonymous, not anonymous, and no message body/plain recipient is stored. Reserved/dispatched/unknown holds have no TTL; fully completed accepted/released claims get35days from Redis time, never refreshed on read. Partial HSET/expiry/settlement failure can keep an uncertain hold or terminal record indefinitely; only validated owner transitions release quota, not erasure. At most50000 new claims per reviewed billing period; this is not a lifetime retention, copies or financial-cleanup envelope. Accepted proof requires exact account/intent/payload/units/schema/state/provenance/PEXPIRETIME and RedisTIME; it neither grants POST nor proves inbox delivery. Measured EVAL+internal commands:4initialize/11reserve/11dispatch/14accepted/10read/13reserved-cancel, excluding fixture clock reads. Real review isnull, bootstrap never automatic, and the source/transport bindings still require their separate review. Global ledger, permanent unknowns, repeated calls, overhead, copies, cleanup and post-retirement costs remain unknown/rejected: not store-room funded, not a numerical allocation and not zero."),
  "nl:outreach:@lib/outreach.ts": { what: "Pitches, the domains that asked to stop, who writes, the day's count: each pitch at its largest (PITCH_BYTES) while it is kept, and its stop link for good (OUTREACH_TRACE_BYTES)", room: ["lib/outreach.ts"], parts: [capped(4 * KB, "Who writes, and the day's count.")] },
  "nl:outreach:stop:all@lib/outreach.ts": company("Domains that asked that nobody here write to them", "One set for every store."),
  "nl:outreach:stoplink:@lib/outreach.ts": room("A pitch's stop link, kept for good: counted in the room when the pitch is written (OUTREACH_TRACE_BYTES)", "lib/outreach.ts"),
  "nl:depth:@lib/page-depth.ts": { what: "How far a page is read: at most DEPTH_FIELDS_MAX fields a product, counted with the product (DEPTH_RECORD_BYTES)", room: ["lib/store.ts"] },
  "nl:pfunnel:done:@lib/page-funnel-store.ts": room("Who signed up or paid at a step: counted with its funnel", "lib/page-funnel-store.ts"),
  "nl:pfunnel:seen:@lib/page-funnel-store.ts": room("Who opened a step: counted with its funnel", "lib/page-funnel-store.ts"),
  "nl:pfunnels:@lib/page-funnel-store.ts": { what: "The store's funnels of pages", room: ["lib/page-funnel-store.ts"], parts: [capped(0, "Counted with each funnel (FUNNEL_COUNT_BYTES_PER_STEP); at most MAX_PAGE_FUNNELS.", src("lib/page-funnel.ts", "MAX_PAGE_FUNNELS"))] },
  "nl:pinv:@lib/partner-invites.ts": company("A partnership offered to an address", "Per address across stores, behind the affiliates' limits."),
  "nl:pk:@lib/passkeys.ts": company("An account's passkeys", "An account's."),
  "nl:pk:auth:@lib/passkeys.ts": company("A passkey sign-in", "An account's, minutes."),
  "nl:pk:cred:@lib/passkeys.ts": company("A passkey's credential", "An account's."),
  "nl:pk:drop:@lib/passkeys.ts": company("Passkeys waiting to be removed", "An account's, until the day comes and it is applied at the next login or check."),
  "nl:pk:lock:@lib/passkeys.ts": company("An account's passkeys being changed", "An account's, seconds."),
  "nl:pk:reg:@lib/passkeys.ts": company("A passkey being added", "An account's, minutes."),
  "nl:pwyw:@lib/pay-what-you-want.ts": short("A price made for a pay-what-you-want amount: at most one an order, a year", "order", 365, KEY),
  "nl:agree:r:@lib/agreement-store.ts": room("A proposal or agreement: who it is for, each version's fingerprint and signature; counted with room for its signatures and its two index entries before it is written, until it goes by itself (recordRoomBytes)", "lib/agreement-store.ts"),
  "nl:agree:v:@lib/agreement-store.ts": room("One version's exact text, written once: counted before it is written, until its agreement goes by itself (versionRoomBytes)", "lib/agreement-store.ts"),
  "nl:agree:s:@lib/agreement-store.ts": room("The store's agreements, by when made: an entry each, counted with its record", "lib/agreement-store.ts"),
  "nl:agree:p:@lib/agreement-store.ts": room("One person's agreements in a store (at most MAX_PER_PERSON): an entry each, counted with its record", "lib/agreement-store.ts"),
  "nl:agree:lock:@lib/agreement-store.ts": short("An agreement being signed or given a new version, ten seconds", "request", 1, MARK, REQ("agreement-sign")),
  "nl:letters:i:@lib/letters.ts": room("An email published on the store: its subject and words as sent, counted with its entry before it is written, until it goes by itself (letterRoomBytes)", "lib/letters.ts"),
  "nl:withdraw:@lib/withdrawal.ts": room("A buyer's withdrawal from an order (EU art. 11a): the order's reference and the time, written once with SET NX after its bytes are counted, gone by itself after WITHDRAWAL_KEEP_DAYS", "lib/withdrawal.ts"),
  "nl:letters:link:@lib/letter-access.ts": short("An emailed link to read an email kept for members, and its opens, an hour", "access", 1, LINK_BYTES, MAIL("letter link")),
  "nl:letters:ok:@lib/letter-access.ts": short("Whether a reader holds one of a published email's products, answered for minutes", "request", 1, KEY, REQ("page")),
  "nl:letters:rl:addr:@lib/letter-access.ts": short("Links to read an email asked per address, an hour", "request", 1, KEY, REQ("letter link")),
  "nl:letters:rl:ip:@lib/letter-access.ts": short("Links to read an email asked per connection, an hour", "request", 1, KEY, REQ("letter link")),
  "nl:letters:s:@lib/letters.ts": room("The store's published emails, by when published (at most MAX_PUBLISHED_LETTERS): an entry each, counted with its copy", "lib/letters.ts"),
  "nl:payreq:r:@lib/payment-request-store.ts": room("A payment request: what it asks for, of whom, and what became of it; counted with its four index entries before it is written, until it goes by itself (requestRoomBytes)", "lib/payment-request-store.ts"),
  "nl:payreq:s:@lib/payment-request-store.ts": room("The store's payment requests, by when made: an entry each, counted with its request", "lib/payment-request-store.ts"),
  "nl:payreq:o:@lib/payment-request-store.ts": room("The store's open payment requests: an entry each, counted with its request", "lib/payment-request-store.ts"),
  "nl:payreq:p:@lib/payment-request-store.ts": room("One person's payment requests in a store (at most MAX_PER_PERSON): an entry each, counted with its request", "lib/payment-request-store.ts"),
  "nl:payreq:due@lib/payment-request-store.ts": room("Payment request reminders waiting for their day: an entry each, counted with its request in its store's room", "lib/payment-request-store.ts"),
  "nl:payreq:stores@lib/payment-request-store.ts": company("The stores with open payment requests", "One member a store, read once a run by the five-minute job and let go when it has none open: the job's own index, like its cursor."),
  "nl:payreq:lock:@lib/payment-request-store.ts": short("A payment request's checkout being opened, a minute", "request", 1, MARK, REQ("pay-request")),
  "nl:payreq:w:@lib/payment-request-store.ts": short("A payment request's record being changed, ten seconds at the most", "request", 1, MARK, REQ("pay-request")),
  "nl:pay:currencies:@lib/payment-methods.ts": { what: "The currencies a Stripe account takes, cached", parts: [capped(KB, "One a store.")] },
  "nl:taxreg:@lib/tax-registrations.ts": { what: "The tax registrations active on a Stripe account, cached half a day", parts: [capped(32 * KB, "One a store, at most TAX_REGISTRATIONS_MAX_BYTES, checked before it is written.")] },
  "nl:dun:report:@lib/payment-recovery-report.ts": { what: "Failed renewals, cached", parts: [capped(256 * KB, "One cached view.")] },
  "nl:dun:card:@lib/payment-recovery.ts": { what: "A card already asked about", parts: [per("own", 60, MARK, "Per card asked about by email.", MAIL("card ask"))] },
  "nl:dun:cards:@lib/payment-recovery.ts": { what: "Where the cards were read to", parts: [capped(KEY, "One a store.")] },
  "nl:dun:cursor@lib/payment-recovery.ts": company("Where the recovery job stopped", "One key, the company's job."),
  "nl:pp:@lib/paypal-payouts.ts": { what: "The creator's PayPal app, and its lock", parts: [capped(4 * KB, "One a store.")] },
  "nl:pp:item:@lib/paypal-payouts.ts": short("A PayPal payout item written into the book: up to three partners a sale", "order", 400, 3 * MARK),
  "nl:pp:open:@lib/paypal-payouts.ts": { what: "Payout batches not yet settled", parts: [capped((MAX_AFFILIATES + 1) * 512, "A line per affiliate in an open batch.", src("lib/affiliate-setting.ts", "MAX_AFFILIATES"))] },
  "nl:pp:stores@lib/paypal-payouts.ts": company("Stores with a batch open", "One set for every store."),
  "nl:pp:unk:month:@lib/paypal-payouts.ts": company("Monthly counts of PayPal payout batches whose answer was not known", "Three counts a month (unknown, settled, manual), no store or person; at most 14 monthly keys alive for 400 days."),
  "nl:ppsell:o:@lib/paypal-sales.ts": { what: "A PayPal order opened", parts: [per("order", 30, KB, "Its record, thirty days at most.", KIND("paypal")), per("request", 3, 768, "One opened and never paid, three days.", REQ("paypal checkout"))] },
  "nl:ppsell:own:@lib/paypal-sales.ts": short("The paid orders behind one address's product", "order", 400, MARK, KIND("paypal")),
  "nl:ppsell:paid:@lib/paypal-sales.ts": short("A PayPal order paid", "order", 400, KB, KIND("paypal")),
  "nl:ppsell:pending:@lib/paypal-sales.ts": short("Orders whose payment PayPal holds, until it completes", "order", 30, MARK, KIND("paypal")),
  "nl:ppsell:refunded:@lib/paypal-sales.ts": short("Orders PayPal refunded", "order", 400, MARK, KIND("paypal")),
  "nl:ppsell:sales:@lib/paypal-sales.ts": short("Every paid order", "order", 400, MARK, KIND("paypal")),
  "nl:ppsell:watch:@lib/paypal-sales.ts": short("Paid orders inside PayPal's refund window", "order", 180, MARK, KIND("paypal")),
  "nl:ppsell:handover:@lib/paypal-sales.ts": short("Paid orders still owed their hand-over, from being written down until handed over (lib/paypal-delivery.ts)", "order", 400, MARK, KIND("paypal")),
  "nl:preview:@lib/pdf-preview.ts": room("A PDF's preview, kept a year only while it fits", "lib/pdf-preview.ts"),
  "nl:stamp:copy:@lib/pdf-stamp.ts": room("A stamped copy's record, kept only while it fits", "lib/pdf-stamp.ts"),
  "nl:stamp:problem:@lib/pdf-stamp.ts": { what: "A file that could not be stamped", parts: [per("upload", 31, KB, "Per file.")] },
  "nl:phone:cfg:@lib/phone-alerts.ts": { what: "Phones that hear of sales", parts: [capped(MAX_DEVICES * 6 * 2 * KB, "MAX_STORE_DEVICES devices.", src("lib/phone-alerts.ts", "MAX_DEVICES"))] },
  "nl:phone:seen:@lib/phone-alerts.ts": { what: "An event already sent to phones", parts: [per("order", 40, MARK, "A sale."), per("buyer", 40, MARK, "A buyer's action.")] },
  "nl:phone:st:@lib/phone-alerts.ts": { what: "How the last send went, a device", parts: [capped(MAX_DEVICES * 6 * KB, "One a device.", src("lib/phone-alerts.ts", "MAX_DEVICES"))] },
  "nl:rl:phone:quiet:@lib/phone-alerts.ts": short("A quiet hour's count", "buyer", 1, 128),
  "nl:rl:phone:test:@lib/phone-alerts.ts": short("A test's count", "studio", 1, 128),
  "nl:course:@lib/plan-closing.ts": short("A course's lock while the closing job takes its files", "day", 1, 128),
  "nl:plan:closing:@lib/plan-closing.ts": { what: "What an ended store was told, and when", parts: [capped(2 * KB, "One a store.")] },
  "nl:plan:closing:after@lib/plan-closing.ts": company("Where the closing job stopped", "One key, the company's job."),
  "nl:pod:@lib/plan-closing.ts": short("A podcast's lock while the closing job takes its files", "day", 1, 128),
  "nl:pause:@lib/contract-restart-activation.ts": { what: "Read-only exact pause proof for closed restart activation", parts: [capped(4 * KB, "Same one-per-store pause; reads at most1536 raw bytes and never changes or removes it.")] },
  "nl:pause:due@lib/contract-restart-activation.ts": company("Read-only existing due member for closed restart activation", "Same sorted set; no entry, allocation, removal or score mutation."),
  "nl:pause:last:@lib/contract-restart-activation.ts": { what: "Read-only existing annual marker for closed restart activation", parts: [capped(KEY, "Same one-per-store marker; no new marker or expiry.")] },
  "nl:pause:@lib/contract-funding.ts": { what: "Read-only exact observation of the existing pause for a funded intent", parts: [capped(4 * KB, "Same one-per-store pause as plan-pause.ts; this caller creates no second pause. Claim reads at most1536 raw bytes.")] },
  "nl:pause:due@lib/contract-funding.ts": company("Read-only existing break due membership for intent ownership", "Same sorted set owned by plan-pause.ts; no new entry, allocation or mutation from the claim."),
  "nl:pause:last:@lib/contract-funding.ts": { what: "Read-only annual eligibility evidence for the existing pause", parts: [capped(KEY, "Same one-per-store annual marker as plan-pause.ts; no new marker or expiry.")] },
  "nl:pause:@lib/plan-pause.ts": { what: "A store's break and when it was last taken", parts: [capped(4 * KB, "One a store.")] },
  "nl:pause:due@lib/plan-pause.ts": company("Breaks due", "One sorted set for every store."),
  "nl:pause:last:@lib/plan-pause.ts": { what: "When a break was last taken", parts: [capped(KEY, "One a store.")] },
  "nl:plan:ended@lib/plan-standing.ts": company("Stores whose plan ended, by the day", "One sorted set for every store."),
  "nl:plans:pending@lib/plans.ts": company("Plans being started", "One set, minutes."),
  "nl:share:stores@lib/platform-share.ts": company("Stores whose sales pay a share", "One set for every store."),
  "nl:pod:by:@lib/podcast-access.ts": { what: "A listener's access to a private podcast", parts: [item(MARK, "One a buyer.", "membership")] },
  "nl:pod:n:@lib/podcast-access.ts": short("A feed's reads a day", "request", 2, 128, REQ("page")),
  "nl:pod:ok:@lib/podcast-access.ts": short("A listener's access, answered", "request", 1, KEY, REQ("page")),
  "nl:pod:t:@lib/podcast-access.ts": { what: "A listener's feed token", parts: [item(KEY, "One a buyer.", "membership")] },
  "nl:pod:@lib/podcast.ts": { what: "A podcast's episodes", parts: [capped((tier) => 0 * MAX_PRODUCTS + (tier ? 0 : 0), "Kept on the product's record (lib/store.ts, setPodcastEpisodes): counted with products.")], room: ["lib/store.ts"] },
  // Read-only alias of the existing retained family below; no storage or TTL write.
  "nl:pre:@lib/dispute-preorder-review.ts": { what: "One retained pre-order row read with its existing PTTL; storage and 400-day retention priced by nl:pre:@lib/preorders.ts, with no duplicate bytes", line: "database-storage" },
  "nl:pre:@lib/preorders.ts": { what: "Pre-orders: who paid, the refunds read", parts: [per("order", 430, KB, "A pre-order and its payment, 400 days after its last change.", KIND("preorder")), capped(2 * KEY + 64 * KB, "The store's marks and the refunds already handled.")] },
  "nl:pre:give:@lib/preorders.ts": short("A pre-order being handed over", "day", 1, 128),
  "nl:pre:jobs@lib/preorders.ts": company("Products with pre-orders to hand over", "One set for every store."),
  "nl:pre:pi:@lib/preorders.ts": short("The pre-order a payment paid for", "order", 430, KEY, KIND("preorder")),
  "nl:wl:@lib/preorders.ts": { what: "Products taking pre-orders: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:product:about:@lib/product-about.ts": { what: "Products' long descriptions", room: ["lib/product-about.ts"] },
  "nl:none@lib/product-updates.ts": company("A key that is never written", "Read in place of a list a store does not have."),
  "nl:upd:job:@lib/product-updates.ts": { what: "An update's send and who it goes to", parts: [per("monthly", 120, KEY, "A buyer's place in a send.", MAIL("update"))] },
  "nl:upd:last:@lib/product-updates.ts": { what: "When a product's buyers were last written to: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:upd:latest:@lib/product-updates.ts": { what: "A product's latest update: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:upd:off:@lib/product-updates.ts": { what: "A buyer who stopped updates", parts: [kept(MARK, "Updates go to buyers: one mark a buyer, kept for good.")] },
  "nl:upd:stop:@lib/product-updates.ts": { what: "An update's stop link: one for each address a store writes to, the same in every email", parts: [kept(LINK_BYTES, "Updates go to buyers: one a buyer, kept while they are written to.")] },
  "nl:updq@lib/product-updates.ts": company("Updates under way", "One sorted set, members gone when sent."),
  "nl:confirm:@lib/purchase-email.ts": short("An order's confirmation sent", "order", 40, MARK),
  // ---------------------------------------------------------------- lib/ q–s
  "nl:quiet:seen:@lib/quiet-sales.ts": company("A store's sales checked a day", "The company's daily job, two days."),
  "nl:quiet:sent:@lib/quiet-sales.ts": company("A quiet-sales email sent", "The company's email to a creator."),
  "nl:quiz:usage:@lib/quiz-usage-rules.ts": short("Quiz submissions counted in the window", "day", 62, 128),
  "nl:course:@lib/quiz.ts": { what: "Quizzes, and students' tries, results and passes", room: ["lib/quiz.ts"] },
  "nl:recent:@lib/recent-sales.ts": { what: "Recent sales shown on the store", parts: [capped(64 * KB, "The newest few, trimmed.")] },
  "nl:recent:feed:@lib/recent-sales.ts": { what: "The recent sales feed, cached", parts: [capped(64 * KB, "One cached view.")] },
  "nl:auth:rec:@lib/recovery-address.ts": company("An account's recovery address", "An account's."),
  "nl:auth:rec:link:@lib/recovery-address.ts": company("A recovery link", "An account's, minutes."),
  "nl:auth:rec:set:@lib/recovery-address.ts": company("A recovery address being set", "An account's, minutes."),
  "nl:auth:rec:until:@lib/recovery-address.ts": company("Until when a recovery holds", "An account's."),
  "nl:rl:@lib/request-guard.ts": short("Per connection, person or store counts, by their scope", "request", 1),
  "nl:rlm:@lib/request-guard.ts": short("Monthly counts by their scope", "day", 62, 128),
  "nl:rev:ask:due@lib/review-ask.ts": company("Review asks due", "One sorted set for every store: each an order's, gone when asked."),
  "nl:rev:link:@lib/review-proof.ts": short("A review link, sixty days", "monthly", 60, LINK_BYTES, MAIL("review ask")),
  "nl:rev:refunds:seen:@lib/review-proof.ts": { what: "Refunds already handled for reviews", parts: [capped(64 * KB, "Sixty-one days after the last one read.")] },
  "nl:rev:refunds:since:@lib/review-proof.ts": { what: "How far refunds were read", parts: [capped(KEY, "One a store.")] },
  "nl:none@lib/review-requests.ts": company("A key that is never written", "Read in place of a list a store does not have."),
  "nl:rev:ask:sent:@lib/review-requests.ts": short("An order asked for a review", "order", 120, MARK),
  "nl:rev:off:@lib/review-requests.ts": { what: "An address that stopped review asks, for good", parts: [kept(MARK, "Review asks go to buyers: one mark a buyer, kept for good.")] },
  "nl:rev:stop:@lib/review-requests.ts": { what: "A review ask's stop link: one for each address, the same in every email", parts: [kept(LINK_BYTES, "Review asks go to buyers: one a buyer, kept while they are asked.")] },
  "nl:rev:@lib/reviews.ts": { what: "Reviews and their lists", room: ["lib/reviews.ts", "lib/store.ts"], parts: [kept(MARK, "A payment's reviews, for refunds.")] },
  "nl:rev:all:@lib/reviews.ts": { what: "Every review, for the studio", room: ["lib/reviews.ts"] },
  "nl:rev:lock:@lib/reviews.ts": short("A product's reviews being written", "buyer", 1, 128),
  "nl:rev:new:@lib/reviews.ts": { what: "Reviews not seen yet", room: ["lib/reviews.ts"] },
  "nl:rev:pay:@lib/reviews.ts": { what: "The reviews a payment paid for", parts: [kept(MARK, "One a payment.")] },
  "nl:rev:stores@lib/reviews.ts": company("Stores with any review", "One set for every store."),
  "nl:rev:sum:@lib/reviews.ts": { what: "The numbers a product's pages show of its reviews: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:rev:vis:@lib/reviews.ts": { what: "The reviews on a page", room: ["lib/reviews.ts"] },
  "nl:sale:told:@lib/sale-events.ts": short("A sale told to the creator", "order", 40, MARK),
  "nl:goal:@lib/sales-goal.ts": { what: "The store's sales goal", parts: [capped(KB, "One a store.")] },
  "nl:path:board:v1@lib/path-board.ts": { what: "Shared mission board: one pseudonymous member per store, charged PATH_BOARD_ROOM_BYTES in its own room atomically", room: ["lib/path-atomic.ts"] },
  "nl:path:board:owners:v1@lib/path-board.ts": { what: "Private reverse lookup for removal: one field per opted-in store, included in its board room charge", room: ["lib/path-atomic.ts"] },
  "nl:path:@lib/path.ts": { what: "Marktmorgen Path: the owner's four answers, the days they opened it, the best level reached and the last reading of the money (18 October 2026): one slot, at what the record weighs", room: ["lib/path-atomic.ts"] },
  "nl:product:page:@lib/sales-page-store.ts": { what: "Products' and pages' blocks", room: ["lib/sales-page-store.ts"] },
  "nl:product:pages:@lib/sales-page-store.ts": { what: "A page's earlier versions", room: ["lib/sales-page-store.ts"] },
  "nl:product:landing:@lib/campaign-landing-store.ts": { what: "A product's campaign landing words", room: ["lib/campaign-landing-store.ts"] },
  "nl:amem:@lib/assistant-memory-store.ts": { what: "The creator's notes for their assistant", room: ["lib/assistant-memory-store.ts"] },
  "nl:amem:lock:@lib/assistant-memory-store.ts": short("The creator's notes for their assistant being changed, ten seconds at the most", "studio", 1, 128),
  "nl:product:pics:@lib/sales-page-store.ts": { what: "Which page a picture belongs to", room: ["lib/sales-page-store.ts"] },
  "nl:sblock:uses:@lib/saved-block-store.ts": { what: "The pages carrying a saved section", room: ["lib/sales-page-store.ts"] },
  "nl:sblocks:@lib/saved-block-store.ts": { what: "Saved sections", line: "funnel-share" },
  "nl:gsc:conn@lib/search-console.ts": company("The company's Search Console connection", "One key, the company's."),
  "nl:gsc:q:@lib/search-console.ts": { what: "What people searched for, cached", parts: [capped(256 * KB, "One cached view.")] },
  "nl:gsc:state:@lib/search-console.ts": company("A consent in progress", "The company's, minutes."),
  "nl:mail:segs:@lib/segments.ts": { what: "Saved groups", parts: [capped(MAX_SEGMENTS * 2 * KB, "MAX_SEGMENTS.", src("lib/segments-rules.ts", "MAX_SEGMENTS"))] },
  "nl:stats:@lib/segments.ts": { what: "Buyers' ledger, cached ten minutes", parts: [capped(ALL_TIME_PAGES * 100 * 4 * 512, "One row per buyer, at most one for each of ALL_TIME_PAGES pages of checkouts, offers after paying, PayPal sales and renewals (270 [GR1], unit 2).", src("lib/stats.ts", "ALL_TIME_PAGES"))] },
  "nl:ses:did:@lib/ses.ts": company("A send already handed to Amazon", "The company's, minutes."),
  "nl:ses:h:@lib/ses.ts": company("Amazon's sends an hour", "The company's."),
  "nl:ses:state@lib/ses.ts": company("Amazon's state", "One key, the company's."),
  "nl:share:applied@lib/share-settle.ts": company("Shares applied, by store", "One hash for every store: a field a store."),
  "nl:share:read-until@lib/share-settle.ts": company("How far shares were read, by store", "One hash for every store: a field a store."),
  "nl:ship:done:@lib/shipments.ts": short("An order shipped", "order", 400, MARK),
  // Built, never activated: no outbox status/cleanup Redis and no UI GET.
  // Active plus policy admits work; active/retired retains status and erasure
  // even with null policy. Lifecycle is deployment history, not funding.
  // Full cleanup/failure/retention coverage must precede first activation;
  // never return to never_activated while any payload/uncertain reserve remains.
  "nl:ship:done:@lib/shipment-mail-outbox.ts": company("The physical shipment record held with a pending protected email", "Never-activated company queue, CURRENT_SHIPMENT_MAIL_POLICY null: no outbox source writes today. If activated, no expiry while its pending row survives, including dispatch acceptance unknown; after accepted/canceled only a matching source receives SHIPMENT_MAIL_SOURCE_SECONDS (400 days). An altered/unknown source is not given a certified expiry. This is not the direct 400-day path's priced lifetime and not a store-room allocation. Indefinite pending retention, copies, post-closure source retention and reconciliation cost remain unknown/rejected; no zero cost or numerical funding is claimed."),
  "nl:order-confirmation:row:@lib/order-confirmation-outbox.ts": company("Inactive protected physical-confirmation source", "Built, never activated/policy null; simple physical product only. AES-GCM original body, authentic preintent, original store/product snapshot and winning Stripe/account/settlement source; paid CAS adds the complete immutable recipient/from/reply/subject/text, delivery address and paid amount inside the envelope reserved before payment. At most64 linked erased-recipient hashes/4096bytes and a saturation bit fit inside the originally reserved131072byte row envelope; paid CAS cannot strip/ignore them. They remain as long as this unresolved origin, with no new slot/TTL extension or plain recipient address. Saturation holds the payload rather than dropping a different buyer right. No TTL while pending/refused/acceptance or accounting unknown. Original-account worker ignores the legacy24h sweep cutoff, rechecks expanded payment/charge/refund evidence immediately before dispatch and never substitutes current catalog/account/window. Unknown accounting does not prevent the paid email: acceptance parks the protected source until its original checkpoint is acknowledged; no second POST after dispatch uncertainty. MaximumChecks parks unresolved work, not deletes it. Accepted+settled or explicit erasure drops the row and indexes through shared Lua. Redis7.2.7 EVAL+internal commands:20paid,16dispatch,19accepted-unsettled,19settlement-retry,25cancel; reads add3commands, plus providerGET before preparation and again immediately before dispatch, and original financial checkpoint. Test includes TSworker+actualLua with an authentic73h source and another held order. All provider/payment responses remain synthetic; these component profiles are not a six-contract lifetime envelope or invoice. Prepayment bound/source tests plus exact Redis Lua are synthetic; full lifetime, copies, reconciliation, privacy and failure funding remain unknown/rejected. No other purchase categories or production delivery certified."),
  "nl:order-confirmation:source:@lib/order-confirmation-outbox.ts": company("Inactive original confirmation binding", "One STRING per linked origin SHA-256, not anonymous: original nonce/account/body digest, winning session and binding fingerprint. Compared atomically with its own protected row; separate from shipment doneKey. No TTL while pending, refused, acceptance or accounting uncertain. Accepted+acknowledged accounting or erasure gives only an exactly matching source400days; altered source retention stays unknown. Reserved once in original company envelope, no store-room allocation. Never_activated/policy null; lifetime copies and terminal source cardinality/failure costs remain unknown/rejected."),
  "nl:order-confirmation:due@lib/order-confirmation-outbox.ts": company("Inactive confirmation work schedule", "One EXISTING ZSET of linked origin IDs and next check, no TTL. Shared claim plus CAS schedules original-account read-only creation recovery, payment/send and accepted-but-unsettled retries, with at most25 ordinary score>=0 members per pass and finite reviewed maximumChecks. Known queued waits at exhaustion retain negative=-checks discovery markers; finite explicitly covered recovery may restore score0 without rewriting row/token/creation time/checks, including pre-session lost creation ACK after23h with no new POST. Accepted-unsettled retry caps and permanent dispatch uncertainty retain their separate original barriers, never become fresh sends. Physical and shipping workers retain the existing concurrent five-second cron slice; no in-flight request timeout is overridden. Accepted+settled or erasure removes its member. IDs are linked data; producer/snapshot caps are not lifetime invocation or retention funding. Never_activated/policy null; trigger/provider/Redis reads, polling, copies and cleanup remain unknown/rejected, not zero."),
  "nl:order-confirmation:store:@lib/order-confirmation-outbox.ts": company("Inactive confirmation origins by store", "One SET per statsId, reserved in the original company envelope; no TTL and no paid-room allocation. Tracks unbound and paid origins. The actual store eraser sets its dedicated confirmation fence before atomically snapshotting and canceling this own origin index, payload/source retention and shared reserve, also after retirement/null policy. Unknown index/ACK leaves cleanup incomplete and fence retained. Maximum live global/store items is a reviewed cap, not complete lifetime/storage/copy/failure funding. Never_activated/policy null, activation blocked."),
  "nl:order-confirmation:person:@lib/order-confirmation-outbox.ts": company("Inactive confirmation recipient index", "One SET per statsId and linked SHA-256. Prepayment uses hash(unbound:nonce), not an email. Paid CAS atomically moves the member to hash(normalized verified recipient), checking both original and new recipient erasure fences before saving the encrypted email; no extra slot/room is created after payment. Actual person eraser removes linked paid payload/index; prepayment unknown buyer carries bounded older-erasure hashes within its original row; paid CAS rejects a marked buyer after the ten-minute successful fence expires, while saturation keeps the source held. This is request-scoped suppression of older origins, not a global permanent suppression preference. No TTL pending; release uses exact current person index. Never_activated/policy null; lifetime/copies/privacy/reconciliation funding unknown/rejected."),
  "nl:ship:mail:pool@lib/order-confirmation-outbox.ts": company("Inactive confirmation user of existing global pool", "SAME global items/bytes HASH as shipment, one allocation. Complete future origin envelope131072 plus twice10original key-name bytes plus16384 is reserved before payment creation. The same envelope funds recipient-key replacement and encrypted paid-message growth, capped by reviewed plaintext max60000; overhead remains a declared unverified storage ceiling. Accepted+settled or erasure releases exactly one provable hold; corruption keeps uncertain reserve charged. No TTL. Never_activated/policy null; indefinite copies, leakage/reconciliation and cleanup funding remain unknown/rejected."),
  "nl:ship:mail:pool:@lib/order-confirmation-outbox.ts": company("Inactive confirmation user of existing store pool", "SAME per-statsId items/bytes HASH as shipment, not another quota/store-room charge. Shared enqueue reserves the whole future row; paid transition does not add a slot. Confirmed completion or erasure decrements one validated hold and deletes exact local0/0. Corrupt counters retain the uncertain reserve while erasure still removes personal payload. No TTL while pending. Never_activated/policy null; full lifetime/copy/failure funding unknown/rejected."),
  "nl:ship:mail:all@lib/order-confirmation-outbox.ts": company("Inactive confirmation user of existing live-ID set", "SAME company live-ID SET as shipment; no new allocation. Adds one origin ID at prepayment enqueue and removes it only after accepted+settled or erasure. Shared hold covers key/member bytes. Its own erasers use confirmation row/store/person indexes, not shipment indexes. No TTL; unknown accounting/dispatch remains held. Never_activated/policy null, full indefinite copies/reconciliation/failure funding unknown/rejected."),
  "nl:order-confirmation:closed:@lib/order-confirmation-outbox.ts": company("Inactive confirmation store erasure fence", "Dedicated confirmation fence, never shared with shipment cleanup. Atomic begin installs a random-token STRING before validating/snapshotting at most10000 live own origins, including wrong-type/malformed indexes; unknown cleanup cannot authorize creation/bind/paid/dispatch. Fence stays without a fixed expiry on failure, and only the matching request-token finish applies600000ms after confirmed cleanup. Never_activated does no IO; retired cleanup remains. Linked company deletion state, not anonymous or legal-basis certification; live-row caps do not prove total failure-fence cardinality, retention, copies or funding. Full lifetime/failure funding remains unknown/rejected; policy null prevents activation."),
  "nl:order-confirmation:erased:@lib/order-confirmation-outbox.ts": company("Inactive confirmation recipient erasure fence", "Dedicated per-statsId/recipient SHA256 fence, never shared with shipping erasers, so later shipment cleanup cannot expire an incomplete confirmation erasure. Begin sets it before atomically snapshotting older origins; each unresolved origin receives at most64 distinct linked recipient hashes/4096bytes within the originally reserved row envelope, with no additional slot. Paid binding preserves/checks these markers after the short fence expires; an exact erased-recipient CAS triggers protected-row cancellation without persisting that recipient, retaining only the matching400day source barrier, while unknown cancellation remains protected; saturation holds the original payload/reserve without dispatch or discard. Different known buyers keep their delivery, and new origins after the snapshot do not inherit completed older erasures. Exact CAS token finish allows600000ms only after every marker/deletion is acknowledged; unknown/partial cleanup keeps this fence without fixed expiry. Real Redis profiles include6begin+8mark per unresolved origin+4finish; marking64entries is bounded work per origin, not a funded lifetime allowance. Hashes are pseudonymous linked data, not anonymous or proof of legal basis. Never_activated/policy null, no live IO; full request/failure cardinality, copies, retention, privacy and funding remain unknown/rejected."),
  "nl:order-confirmation:closed:@lib/shipment-mail-outbox.ts": company("Inactive original confirmation store-fence check", "Reads the SAME existing confirmation closed-store key, not a new fence or ownership index. Its exact byte name must match the validated source statsId before any DUE repair. EXISTS only: recovery neither deletes, renews nor writes the fence. Existing dedicated erasure still owns cleanup and its acknowledged retention; unknown/failed cleanup cannot authorize a send. These are linked company-operated privacy guards, not anonymous data or paid store room. Actual policy null/lifecycle never_activated; trigger, reads, copies, residual retention and failure funding remain unknown/rejected, never zero."),
  "nl:order-confirmation:row:@lib/shipment-mail-outbox.ts": company("Inactive bounded observation of existing confirmation rows", "Reads the SAME protected confirmation STRING by existing linked origin SHA-256; no new row or allocation. GETRANGE bounds each read at131072 bytes before validation. Recovery reserves64 logical command units and1MiB logical read capacity per ticket BEFORE variable reads, with finite review/window/attempt/trigger caps; these counters are not a supplier invoice or proof that invocation before the Redis debit is funded. Exact raw CAS, original source/fences and supported physical state precede DUE repair; dispatching/accepted/refused/course remain closed. No TTL change or original accounting reconstruction. Current policy null; full lifetime, copies, historical index holes outside the bounded ALL cohort, and failure/reconciliation funding remain unknown/rejected."),
  "nl:order-confirmation:source:@lib/shipment-mail-outbox.ts": company("Inactive recovery check of original confirmation source", "Reads the EXISTING linked nonce/account/body/session binding STRING via GETRANGE bounded at8192 bytes. It must exactly equal the protected row sourceValue before any DUE membership repair. No source rewrite, separate source, slot or paid-room allocation is created. Original pending no-TTL and terminal exactly-matching400day retention remain unchanged. Digests and source identities are linked personal data, not anonymous. Policy null/lifecycle never_activated; residual retention, copies, bytes and read/failure cost unknown/rejected."),
  "nl:order-confirmation:erased:@lib/shipment-mail-outbox.ts": company("Inactive original confirmation recipient-fence check", "Reads the SAME existing confirmation erased-recipient key, with exact validated original statsId/personHash bytes, before rearming the existing DUE member. This is not another recipient index, new key or permission to erase old privacy state. A present fence remains a known refusal; recovery does not rewrite row/token/timestamps/checks, drop the fence or make dispatch uncertainty repeatable. Existing confirmation erasure owns the bounded request/failure retention. Hashes and linked source identities are not anonymous. Policy null/never_activated; actual private discovery/trigger/storage/retention/copy funding remains unknown/rejected; no zero-cost or new TTL claim."),
  "nl:ship:mail:row:@lib/shipment-mail-outbox.ts": company("Inactive protected shipping-update work", "Company-operated queue, CURRENT_SHIPMENT_MAIL_LIFECYCLE never_activated and production policy null. One STRING per store/session SHA-256: AES-GCM message (recipient/from/reply address/subject/text, possibly shipping address), store/session, tracking source, recipient fingerprint and lifecycle fields. No TTL while pending/refused/acceptance unknown. SHIPMENT_MAIL_MAX_ROW_BYTES bounds a read at 131072 bytes; a validated synthetic policy admits plaintext at most60000 bytes, at most10000 global rows and store caps no larger than global. Enqueue reserves its measured JSON plus twice key-name bytes plus8192 before row/index writes. Overhead is an unverified ceiling, not measured storage coverage; indefinite retention, copies, throughput and closure/reconciliation remain unpriced and rejected. Accepted/canceled drops the row; uncertain budget counters remain held. No room, free quota or zero cost is asserted."),
  "nl:ship:mail:due@lib/shipment-mail-outbox.ts": company("Inactive shipping-update due index", "One EXISTING company ZSET of linked pending row SHA-256 IDs, no TTL. Ordinary polling reads at most25 score>=0 members; a known queued wait at maximumChecks retains a negative=-checks marker instead of losing discovery. Terminal completion/erasure removes membership; uncertain dispatch is never reclaimed. A separately evidenced finite recovery grant can atomically restore score0 after matching original row/source/review/fences and remaining checks, without rewriting the source or resetting its counter. Recovery preserves the legacy omitted maximumOrigins coverage25; only an own expressly reviewed maximumOrigins1–1000 can cover a larger snapshot, and above25 requires the reviewed8192byte checkpoint before IO. Above100 also requires an explicit checkpointTotalBytes (bounded at100000) covering the header, at most10 pages and fixed field names in the SAME POOL/review; legacy25/100 encoding is unchanged. Every retained ACTIVE/CONTINUING/CLEANING snapshot must still fit the presented capacity and bytes; lower coverage stays held without truncating it or resetting counters. These recovery bounds do not cut the reviewed up-to10000 global live-row cap. IDs remain linked personal data. Policy null; repeated trigger/read/guard cost, indefinite marker residency, bytes/copies and reconciliation funding remain unknown/rejected, never zero or paid store-room storage."),
  "nl:ship:mail:all@lib/shipment-mail-outbox.ts": company("Inactive shipping-update live-row index", "One company SET of all pending row SHA-256 IDs, no TTL; row enqueue/drop updates it in the same Lua. At most the validated policy's10000 live rows, with bytes reserved before writes; it is not an expiring generic erasure index. Bounded recovery first checks SCARD against the SAME review coverage: default25 when maximumOrigins is absent, or an own express1–1000; above25 requires checkpoint8192 before IO, and above100 requires an explicit sufficient checkpointTotalBytes<=100000. At most10 pages of100 IDs share the existing POOL. Capture is one atomic complete SSCAN, with no mutation interleaved; multistep cardinality equality cannot certify membership. Pages are globally unique at capture and never silently truncated. One SSCAN MATCH64 must return cursor0 and the exact cardinality, otherwise recovery stays unsupported/unknown without truncating references; COUNT is not a hard limit. This reads the existing index for both families, with no new key, reservation or customer-plan cut. Policy null; indefinite residency, overhead, copies and cleanup cost remain unpriced/rejected."),
  "nl:ship:mail:store:@lib/shipment-mail-outbox.ts": company("Inactive shipping-update rows by store", "One SET per store statsId with its pending row IDs, no TTL, removed member-by-member with terminal row removal and automatically gone when empty. Store cardinality is no larger than the validated global cap; malformed ownership/indexes halt deletion rather than claim completion. Production policy null; retention/copies/reconciliation and post-closure cost unknown/rejected, not room-funded."),
  "nl:ship:mail:person:@lib/shipment-mail-outbox.ts": company("Inactive shipping-update deletion index by person and store", "One SET per store statsId and SHA-256 of the normalized recipient, containing pending row IDs. No TTL: stays reachable for erasure beyond401 days. Row removal deletes its member; Redis removes an empty SET. Per-row policy caps and reserved bytes apply only to validated synthetic enqueue, not lifetime funding. Policy null; fingerprints remain linked personal data; indefinite storage/copies/deletion cost unknown/rejected."),
  "nl:ship:mail:pool@lib/shipment-mail-outbox.ts": company("Inactive shipping-update global reservation pool", "One permanent EXISTING company HASH with items/bytes reservation fields and optional pendingRecovery operational checkpoint, no TTL. Enqueue reserves items/bytes before row/index writes; terminal removal decrements only provable global/local counters, retaining uncertain reserve. Recovery snapshot is at most25 linked origin IDs for legacy grants whose maximumOrigins is omitted, or at most the own expressly reviewed1–1000 coverage in the SAME grant. Above100 requires a new explicit checkpointTotalBytes<=100000, at least8192+ceil(maximumOrigins/100)*8224 logical bytes for header/pages/field names; no implicit budget or second financial ledger. Header and each page remain<=8192, with at most10 fixed pendingRecoveryPage fields in this SAME HASH, sealed together in one HSET. SHA-1 page checksums detect corruption only and never grant economic, identity or send authority; original AEAD sources and fences still control work. Above25 requires checkpointBytes8192 before IO; the retained ACTIVE/CONTINUING/CLEANING snapshot and encoded bytes must fit every presented grant, even a same-revision replay, without truncation, quota reset or implicit coverage. Finite revision/fingerprint/lease/family/cursor and monotonic attempts/commands/read-byte counters share the reviewed4096–8192byte checkpoint bound; logical64command/1MiB read capacity per useful ticket is unchanged, not an invoice or heap/copy/CPU funding proof. IDs are linked personal data, not anonymous. Paid durable cleaning retains the exact page manifest until bounded idempotent HDEL completes, including post-delete lost ACK; no new generation is created before cleanup. New revisions preserve unfinished pages/cursor/refresh and invalidate old tickets. Completed snapshots discard IDs/pages but retain high-water/fingerprint/counters to refuse replay; active/exhausted checkpoints preserve position without TTL. The hash can remain after0/0 cleanup, including this new residual metadata; it is no longer necessarily two fields. Checkpoint bounds do not prove allocator/replica/copy/indefinite-retention coverage. Fixed trigger/function/network/failed-guard costs need separately evidenced funding in the SAME review, never inferred from storage or the Redis counter. Actual review null/lifecycle never_activated; all such real lifetime/copy/reconciliation/infra costs remain unknown/rejected, never zero or a paid store-room charge."),
  "nl:ship:mail:pool:@lib/shipment-mail-outbox.ts": company("Inactive shipping-update reservation pool by store", "One two-field items/bytes HASH per store, no TTL while work or uncertain reservation remains. Confirmed cleanup deletes a proved0/0 local pool; corrupt counters retain uncertain budget instead of obstructing payload erasure. Not a store-data-room slot. Production policy null; unresolved lifetime cardinality, overhead/copies and post-closure reconciliation cost remain unknown/rejected."),
  "nl:ship:mail:closed:@lib/shipment-mail-outbox.ts": company("Shipping-update erasure fence by store", "Company deletion guard, one bounded random-token STRING per statsId. Never_activated returns0 before Redis. Only active/retired cleanup can write it, including null enqueue policy and an empty index. Written without TTL before deletion; only confirmed completion applies SHIPMENT_MAIL_ERASURE_FENCE_MS (600000 ms), requiring exact PEXPIRE ACK1. Failed/unknown deletion can leave it indefinitely. It blocks producers whose maximum age is SHIPMENT_MAIL_PRODUCER_MS (300000 ms). Fences are not bounded by the live-row cap; lifetime cardinality, storage/copies and erasure/reconciliation funding remain unknown/rejected. No paid storage envelope is claimed."),
  "nl:ship:mail:erased:@lib/shipment-mail-outbox.ts": company("Shipping-update erasure fence by recipient and store", "Company deletion guard, one random-token STRING per statsId/normalized-address SHA-256, with no plain email. Never_activated does no Redis. Only active/retired cleanup can write it, even with null enqueue policy and no queued row. No TTL until deletion completes; then600000 ms with exact PEXPIRE ACK1 protects against older300000-ms producers. Failure can retain it indefinitely. This is linked deletion state, not anonymous data or a permanent suppression preference; pending-item caps do not bound all fences. Indefinite cardinality, copies and reconciliation cost remain unknown/rejected."),
  "nl:slink:@lib/short-links.ts": { what: "A short link", parts: [capped(MAX_LINKS * 8 * KB, "MAX_LINKS links.", src("lib/short-link-rules.ts", "MAX_LINKS"))] },
  "nl:slink:store:@lib/short-links.ts": { what: "A store's short links", parts: [capped(MAX_LINKS * 8 * KB, "MAX_LINKS links.", src("lib/short-link-rules.ts", "MAX_LINKS"))] },
  "nl:sold:@lib/sold-count.ts": { what: "Copies sold, by product: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:sold:lock:@lib/sold-count.ts": short("One count at a time", "request", 1, 128, REQ("checkout")),
  "nl:stats:@lib/stats-notes.ts": { what: "Notes on the store's numbers", parts: [capped(MAX_NOTES * (MAX_STATS_NOTE * 3 + ENTRY_BYTES + 64), "MAX_NOTES notes.", src("lib/stats-notes.ts", "MAX_NOTES", "MAX_NOTE_LENGTH"))] },
  "nl:busy:@lib/stats-report.ts": company("A report being made", "The company's report to a creator, a day."),
  "nl:monthly:sent:@lib/stats-report.ts": company("A monthly report sent", "The company's email to a creator."),
  "nl:weekly:off@lib/stats-report.ts": company("Creators who switched the weekly report off", "One set for every store."),
  "nl:weekly:sent:@lib/stats-report.ts": company("A weekly report sent", "The company's email to a creator."),
  "nl:weekly:to:@lib/stats-report.ts": { what: "Who on the team gets the weekly report", parts: [capped((MAX_TEAM + 1) * KEY, "The team.", src("lib/team.ts", "MAX_TEAM"))] },
  "nl:stats:@lib/stats.ts": {
    what: "The store's numbers: every day's counts and visitors, all time, who is on now, cached sales",
    parts: [
      capped((KEPT_DAYS + 1) * ((DAY_FIELDS_MAX + 1) * 96 + KEY), "Each day's counts, at most DAY_FIELDS_MAX fields and \"~\" for the rest, kept KEPT_DAYS.", src("lib/stats.ts", "KEPT_DAYS", "DAY_FIELDS_MAX", "cappedCountCommand")),
      capped((tier) => Math.min((KEPT_DAYS + 1) * 12_432, 14 * 31 * 200 + 15 * VISITS_INCLUDED[tier] * 13), "Each day's visitors, a HyperLogLog of at most 12 KB with its key, and at most 13 bytes a visitor until it is: visits are counted by the calendar month, 15 of them in KEPT_DAYS.", src("lib/stats.ts", "KEPT_DAYS", "PFADD")),
      capped((LIFE_WRITE_MAX + 1) * 96 + 2 * KB, "All time: at most LIFE_WRITE_MAX fields and \"~\".", src("lib/stats.ts", "LIFE_WRITE_MAX", "LIFE_KEEP_PER_KIND")),
      per("request", 1, 96, "Who is on now: a member a view, let go once a day.", undefined),
      capped(ALL_TIME_PAGES * 100 * 512 + 64 * KB, "Sales cached ten minutes, and today's two minutes.", src("lib/stats.ts", "ALL_TIME_PAGES")),
    ],
  },
  "nl:stock:@lib/stock.ts": { what: "Stock left, by product, and a sale's hold: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:stock:lock:@lib/stock.ts": short("One count at a time", "request", 1, 128, REQ("checkout")),
  "nl:storage:pending:@lib/storage-reservations.ts": short("Uploads reserved and not finished", "upload", 1, 512),
  "nl:alert:@lib/store-alerts.ts": { what: "Alerts sent to the creator", parts: [capped(30 * KEY + 14 * 10 * KEY, "One per kind, and the goals' a month.")] },
  "nl:alert:seen:@lib/store-alerts.ts": company("A store's alerts checked a day", "The company's daily job."),
  "nl:allow:@lib/store-allowance.ts": { what: "Each figure taken in the window", parts: [capped((8 * 2 + 13) * KEY, "Eight figures, the window and the one before; and the studio requests held for scheduled emails in each month ahead, at most 13 (a year ahead, lib/store-allowance.ts holdAllowanceAt).")] },
  "nl:blog:body:@lib/store-blog.ts": { what: "Blog posts' words", room: ["lib/store-blog.ts"] },
  "nl:blog:meta:@lib/store-blog.ts": { what: "Blog posts", room: ["lib/store-blog.ts"] },
  "nl:blog:pub:@lib/store-blog.ts": { what: "Published blog posts", room: ["lib/store-blog.ts"] },
  "nl:data:@lib/store-data.ts": { what: "The store's data room itself: a field a slot", room: ["lib/store-data.ts"] },
  "nl:data:@lib/data-recount.ts": { what: "The stores' data rooms, read and set by the one-time count", room: ["lib/data-recount.ts"] },
  "nl:*@lib/data-recount.ts": company("The pattern the one-time count reads the database by", "Not a key: a pattern."),
  "nl:recount:@lib/data-recount.ts": company("The one-time count's own records: where it is, the stores' ids, what each measured", "The company's job, three keys, deleted when it is done."),
  "nl:recount:ids@lib/data-recount.ts": company("The ids each store's keys are named by, while the count runs", "The company's job, deleted when it is done, thirty days at the most."),
  "nl:recount:state@lib/data-recount.ts": company("Where the one-time count is", "One key, the company's job."),
  "nl:recount:sum@lib/data-recount.ts": company("What the count measured of each store, until it is set in its room", "The company's job, deleted when it is done."),
  "nl:join:t:@lib/store-join.ts": short("A link to join the list, sent by email", "access", 7, LINK_BYTES, MAIL("join")),
  "nl:store:photo:@lib/store-photo.ts": { what: "The store's photo", parts: [capped(2 * (MAX_PHOTO_BYTES * 4) / 3 + KB, "One photo, and the one it replaces while it is written.", src("lib/photo-limits.ts", "MAX_PHOTO_BYTES"))] },
  "nl:account:stores:@lib/store.ts": company("An account's other stores", "An account's."),
  "nl:catalog:move:cursor@lib/store.ts": company("Where the catalog move stopped", "One key, the company's job."),
  "nl:store:before-catalog:@lib/store.ts": { what: "A store record kept aside while it moved, thirty days", parts: [capped(MAX_STORE_BYTES + KB, "Once, at most the record.", src("lib/store.ts", "MAX_STORE_BYTES"))] },
  "nl:store:handle:@lib/store.ts": { what: "The store's addresses", parts: [capped(21 * KEY, "Its address and up to twenty before it.")] },
  "nl:store:id:@lib/store.ts": { what: "Where the store is kept", parts: [capped(KEY, "One a store.")] },
  "nl:store:id:@lib/store-exact.ts": { what: "Where the store is kept, read exactly to tell a store that is gone from one that did not answer", parts: [capped(0, "Read only: counted with lib/store.ts.")] },
  "nl:store:lock:@lib/store.ts": short("The store's lock while one change is written", "studio", 1, 128),
  "nl:store:owner:*@lib/store.ts": company("The pattern the daily job reads every store by", "Not a key: a pattern."),
  "nl:store:owner:@lib/store.ts": { what: "The store record", parts: [capped(MAX_STORE_BYTES + KB, "At most MAX_STORE_BYTES, refused past it.", src("lib/store.ts", "MAX_STORE_BYTES"))] },
  "nl:stream:cap:@lib/stream.ts": { what: "A video's caption languages", room: ["app/api/store/stream/route.ts"] },
  "nl:stream:col:@lib/stream.ts": { what: "The store's collection at the video service", parts: [capped(KEY, "One a store.")] },
  "nl:stream:due@lib/stream.ts": company("Videos to ask about", "One sorted set for every store, each a video counted in its store's room."),
  "nl:stream:gone@lib/stream.ts": company("Videos to delete at the service", "One set, members gone when done."),
  "nl:stream:peek:@lib/stream.ts": short("A student's page asked about a video", "request", 1, 128, REQ("page")),
  "nl:stream:v:@lib/stream.ts": { what: "What is known about a video", room: ["app/api/store/stream/route.ts", "lib/stream.ts"] },

  // ---------------------------------------------------------------- lib/ t–z
  "nl:report:@lib/takedown.ts": company("A takedown report", "Reports to the company."),
  "nl:report:t:@lib/takedown.ts": company("A takedown report's token", "Reports to the company."),
  "nl:callteam:@lib/team-booking.ts": { what: "A team event type: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:callteam:rr:@lib/team-booking.ts": { what: "Round-robin counts of a team event type: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:rl:team-invite:@lib/team.ts": short("Invites a day", "studio", 1, 128),
  "nl:team:@lib/api-keys.ts": { what: "The team, only read here (with a key, to refuse one whose maker is no longer on it); kept and bounded by lib/team.ts", parts: [capped((MAX_TEAM + 10) * KB, "The same record as lib/team.ts keeps: MAX_TEAM members and their invites, read, never written.", src("lib/team.ts", "MAX_TEAM"))] },
  "nl:team:@lib/team.ts": { what: "The team and its invites", parts: [capped((MAX_TEAM + 10) * KB, "MAX_TEAM members and their invites.", src("lib/team.ts", "MAX_TEAM"))] },
  "nl:team:invite:@lib/team.ts": short("An invite's link, seven days", "studio", 7, 512),
  "nl:team:lock:@lib/team.ts": short("The team's lock", "studio", 1, 128),
  "nl:team:log:@lib/team.ts": { what: "What the team did", parts: [capped(LOG_LINES * 512, "The newest LOG_LINES.", src("lib/team.ts", "LOG_LINES"))] },
  "nl:team:of:@lib/team.ts": company("The stores a person is on", "A person's, not a store's: at most the stores they are on."),
  "nl:product:note:@lib/thanks-note-store.ts": { what: "Notes after paying", room: ["lib/thanks-note-store.ts"] },
  "nl:tier:@lib/tier-switch.ts": short("A membership's lock while it changes tier", "request", 1, 128, REQ("tier switch")),
  "nl:tier:price:@lib/tier-switch.ts": { what: "A price made for a tier switch, per product and currency: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
  "nl:traffic:day:@lib/traffic.ts": short("Who came that day, each once", "request", 2, 64),
  // One field a connection a day, written SHARE_BATCH requests at a time and kept with the window (MM-SA-01): at most a tenth of the window's requests, 64 bytes each.
  "nl:traffic:c:@lib/traffic.ts": { what: "Each connection's share of the window's requests, by day", parts: [per("request", 33, 7, "A field for every ten requests at the most, kept to the window's end and a day.")] },
  "nl:traffic:folders:@lib/traffic.ts": company("The stores with visits, a month", "One set a month for every store."),
  "nl:traffic:n:@lib/traffic.ts": { what: "Visits in the window", parts: [capped(14 * KEY, "One a window, 400 days.")] },
  "nl:traffic:r:@lib/traffic.ts": { what: "Requests in the window", parts: [capped(2 * KEY, "One a window.")] },
  "nl:traffic:x:@lib/traffic.ts": { what: "The live room in the window", parts: [capped(14 * KEY, "One a window, 400 days.")] },
  "nl:nudge:@lib/trial-nudges.ts": company("A trial's nudges sent", "The company's emails to a creator about their own plan."),
  "nl:2fa:@lib/two-step.ts": company("An account's second step", "An account's."),
  "nl:2fa:hold:@lib/two-step.ts": company("A second step held", "An account's."),
  "nl:2fa:once:@lib/two-step.ts": company("A code used once", "An account's, minutes to a day."),
  "nl:2fa:lock:@lib/two-step.ts": company("An account's two-step record being changed", "An account's, seconds."),
  "nl:2fa:locked:@lib/two-step.ts": company("A session let in without its second step", "An account's."),
  "nl:2fa:lockedset:@lib/two-step.ts": company("An account's locked sessions, and when they could not be logged out", "An account's set, and its \":kept\" time (31 days). One shared list under the name \"any account\": at most KEPT_ANY_MAX (100) account tags of 41 bytes (4,100 bytes) or \"*\" past them, 31 days after the last failed read (lib/two-step.ts KEEP_ANY)."),
  "nl:2fa:keptstar:@lib/two-step.ts": company("Monthly count of the kept accounts' list past its ceiling", "One count a month, no account; at most 14 monthly keys alive for 400 days."),
  "nl:2fa:rescue:@lib/two-step.ts": company("A rescue link", "An account's."),
  "nl:2fa:setup:@lib/two-step.ts": company("A second step being set up", "An account's."),
  "nl:upload-budget:v2:{@lib/upload-budget-policy.ts": company("The company's upload ledger, a month", "The company's ledger."),
  "nl:upload-budget:v2:{YYYY-MM}@lib/upload-budget-policy.ts": company("The ledger's name", "The company's ledger."),
  "nl:upsell-slots:@lib/upsell.ts": short("The offers a checkout took", "order", 8, KEY),
  "nl:upsell:@lib/upsell.ts": short("An offer after paying: one or two an order", "order", 8, 2 * KB),
  "nl:upsell:pending@lib/upsell.ts": company("Offers being charged", "One sorted set, minutes, each an order's."),
  "nl:@lib/usage-billing.ts": { what: "What a meter billed, is adding, told, a month", parts: [capped(3 * 3 * 14 * KEY, "Three meters, three marks, 400 days.")] },
  "nl:watch:monthly:@lib/usage-billing.ts": company("A subscription's monthly watching billed", "The company's billing of its own plan."),
  "nl:vault:up:@lib/vault.ts": short("A vault upload in progress", "upload", 1, 512),
  "nl:verified:@lib/verified-numbers.ts": { what: "The store's verified numbers, cached", parts: [capped(16 * KB, "One a store.")] },
  "nl:verified:cursor@lib/verified-numbers.ts": company("Where the verification job stopped", "One key, the company's job."),
  "nl:wl:@lib/waitlist.ts": { what: "Waitlists: who is waiting, launches", room: ["lib/waitlist.ts", "lib/store.ts"], parts: [per("store", 120, KEY, "A launch's record and each address's place in it.", MAIL("launch"))] },
  "nl:wl:jobs@lib/waitlist.ts": company("Launches still sending", "One set, members gone when done."),
  "nl:wl:t:@lib/waitlist-tokens.ts": { what: "A waitlist's confirm and leave links", room: ["lib/waitlist.ts"], parts: [per("store", 7, LINK_BYTES, "A confirm link, seven days.", MAIL("waitlist"))] },
  "nl:watch:due@lib/watch.ts": company("Stores whose video watching to read", "One sorted set for every store."),
  "nl:watch:folders:@lib/watch.ts": company("Stores that had any watching, a month", "One set a month for every store."),
  "nl:watch:last:@lib/watch.ts": { what: "Each video's total when last read", room: ["app/api/store/stream/route.ts"] },
  "nl:watch:opened:@lib/watch.ts": { what: "When a lesson video last opened", parts: [capped(KEY, "One a store, seven days.")] },
  "nl:watch:sec:@lib/watch.ts": { what: "Seconds watched in the window", parts: [capped(14 * KEY, "One a window, 400 days.")] },
  "nl:hooks:anchor:@lib/webhooks.ts": { what: "The last Stripe event read", parts: [capped(KEY, "One a store.")] },
  "nl:hooks:cfg:@lib/webhooks.ts": { what: "The store's endpoints", parts: [capped(MAX_ENDPOINTS * 2 * KB, "MAX_ENDPOINTS endpoints.", src("lib/webhooks.ts", "MAX_ENDPOINTS"))] },
  "nl:hooks:d:@lib/webhooks.ts": { what: "One delivery and how it went, a week", parts: [
    // Bounded where it is made (lib/webhooks.ts, emitEvent: every text cleaned and cut at MESSAGE_TEXT_MAX, a message past
    // the bound kept as a line that says so). The largest message the code makes, a sale of a full bundle with three full
    // bundles checked at checkout, every text at its longest in quotation marks, is about 45 KB (tests/api-events-measured.test.ts).
    // A message is kept only by a delivery the month counted: made with the month's deliveries used it is a line, and a
    // try refused for them drops it (attempt).
    per("webhook", 7, DELIVERY_MAX_BYTES, "One delivery and how it went, a week, at the most a delivery is kept at (DELIVERY_MAX_BYTES)"),
    // Messages not kept (too large, or the month's deliveries used): SKIPPED_LINES_PER_DAY lines a reason a day (counted in
    // code, nl:hooks:wait:<id>:skip:<reason>:<day>) and one summary line an endpoint, each for every endpoint, a week.
    capped(7 * 2 * (SKIPPED_LINES_PER_DAY + 1) * MAX_ENDPOINTS * 2 * KB, "Lines of messages not kept: SKIPPED_LINES_PER_DAY a reason a day and one summary, one an endpoint, a week.", src("lib/webhooks.ts", "SKIPPED_LINES_PER_DAY", "MAX_ENDPOINTS")),
    // A passed-over Stripe event leaves its line without taking a delivery: per endpoint, GIVEN_UP_LINES_PER_DAY events a day
    // (counted in code) get their own, every later one that day only rewrites the endpoint's summary line; at most MAX_ENDPOINTS
    // endpoints a store a day (counted in code, nl:hooks:wait:<id>:eps:<day>), each line kept a week.
    capped(7 * (GIVEN_UP_LINES_PER_DAY + 1) * MAX_ENDPOINTS * 2 * KB, "Lines of passed-over Stripe events: GIVEN_UP_LINES_PER_DAY a day and one summary, one an endpoint, a week.", src("lib/webhooks.ts", "GIVEN_UP_LINES_PER_DAY", "MAX_ENDPOINTS")),
  ] },
  "nl:hooks:evt:@lib/webhooks.ts": { what: "An event already sent", parts: [
    per("order", 30, MARK, "A sale."), per("webhook", 30, MARK, "Any other."),
    capped(30 * (288 / 3) * MARK, "The mark of a passed-over Stripe event, kept thirty days. Not counted in code: bounded by the five-minute cron's calls, 288 visits a day and at least STRIPE_REFUSED_RUNS failed visits before an event is passed over.", src("lib/webhooks.ts", "STRIPE_REFUSED_RUNS", "STRIPE_WAIT_RUNS")),
  ] },
  "nl:hooks:log:@lib/webhooks.ts": { what: "The store's last deliveries", parts: [capped(HOOK_LOG * 64, "The newest LOG_SIZE.", src("lib/webhooks.ts", "LOG_SIZE"))] },
  "nl:hooks:pos@lib/webhooks.ts": company("Where the webhook job stopped", "One key, the company's job."),
  "nl:hooks:q@lib/webhooks.ts": company("Deliveries waiting for a try", "One sorted set, members gone within a week: each a webhook's."),
  "nl:hooks:stores@lib/webhooks.ts": company("Stores with any endpoint", "One set for every store."),
  "nl:hooks:wait:@lib/webhooks.ts": { what: "The Stripe event the store's reading waits on, and for how many runs", parts: [capped(KEY, "One a store, for thirty days at most."), capped(2 * 2 * KEY, "The day's count of messages not kept, one a reason (too large, the month used), gone at the end of the next UTC day.", src("lib/webhooks.ts", "SKIPPED_LINES_PER_DAY")), capped(2 * (MAX_ENDPOINTS * (288 / 3) * 128 + MAX_ENDPOINTS * 64 + 64), "The day's passed-over events said to each endpoint (a sorted set an endpoint, at most MAX_ENDPOINTS endpoints a store a day in a set of their own, and the day's count that numbers them, all gone at the end of the next UTC day: two days at most). Not counted in code: bounded by the five-minute cron's calls, 288 visits a day and at least STRIPE_REFUSED_RUNS failed visits before an event is passed over.", src("lib/webhooks.ts", "STRIPE_REFUSED_RUNS", "STRIPE_WAIT_RUNS"))] },
  "nl:rl:hooks:test:@lib/webhooks.ts": short("Tests counted", "studio", 1, 128),
  "nl:wo:due@lib/welcome-offer-send.ts": company("Welcome offers due", "One sorted set for every store, each member a sign-up's reminder holding the person's address, gone when sent or dropped, or when that person is erased (forgetWelcomePerson, lib/person-erasure.ts)."),
  "nl:wo:n:@lib/welcome-offer-send.ts": short("Welcome offers counted", "day", 62, 128),
  "nl:wo:r:@lib/welcome-offer-send.ts": short("A welcome offer's reminder set, once per free copy", "order", 430, MARK),
  "nl:wo:start:@lib/welcome-offer-send.ts": short("A welcome offer started: once per free copy, 400 days after it ends", "order", 430, MARK),
  "nl:wb:@lib/winback-send.ts": short("A come-back offer sent to a member by email", "own", 90, MARK, MAIL("come back")),
  "nl:wb:cursor@lib/winback-send.ts": company("Where the come-back job stopped", "One key, the company's job."),
  "nl:wb:link:@lib/winback-send.ts": short("A come-back link", "own", 60, LINK_BYTES, MAIL("come back")),
  "nl:wb:n:@lib/winback-send.ts": short("Come-back offers counted", "day", 62, 128),
  "nl:wb:once:@lib/winback-send.ts": short("An address told of a product", "own", 60, KEY, MAIL("come back")),
  // At most one a link, a day at the most: the checkout address it opened (up to OPEN_URL_MAX), or a claim's value.
  "nl:wb:open:@lib/winback-send.ts": short("The checkout a come-back link opened, handed back to a second press", "own", 1, KEY + 1_000, MAIL("come back")),
  "nl:yearask:@lib/yearly-ask.ts": { what: "A member asked to go yearly", parts: [item(MARK, "One a membership, five years: counted as for good.", "membership")] },
  "nl:yearask:count:@lib/yearly-ask.ts": short("Asks counted a month", "day", 62, 128),
  "nl:yearask:cursor@lib/yearly-ask.ts": company("Where the yearly ask stopped", "One key, the company's job."),
  "nl:firstsale:@lib/yearly-offer.ts": company("A store's first sale", "The company's offer to a creator about their own plan."),
  "nl:yearly-offer:@lib/yearly-offer.ts": company("A yearly offer made", "The company's offer to a creator about their own plan."),
  "nl:tier:@lib/yearly-switch.ts": short("A membership's lock while it goes yearly", "request", 1, 128, REQ("tier switch")),
  "nl:yearly:link:@lib/yearly-switch.ts": short("A link to go yearly", "own", 30, LINK_BYTES, MAIL("yearly")),
  "nl:tier:@lib/yearly-fallback.ts": short("A membership's lock while a failed yearly renewal moves to monthly", "request", 1, 128, REQ("tier switch")),
  "nl:tier:@lib/membership-pause.ts": short("A membership's lock while a member pauses it or resumes it early", "request", 1, 128, REQ("tier switch")),
  "nl:tier:resume:@lib/membership-pause.ts": short("Which try one early resume of one pause is on, and the idempotency key a press of it sent with when it was first sent, until the pause has ended", "request", 128, KEY, REQ("tier switch")),
  "nl:yearly:fallback:try:@lib/yearly-fallback.ts": short("How many times one failed yearly renewal was tried on the monthly price", "request", 2, KEY, REQ("tier switch")),
  "nl:yearly:fallback:void@lib/yearly-fallback.ts": company("Yearly renewals left open after a move to monthly, for the daily job to void", "One set for the company: one entry per failed yearly renewal moved to monthly (account, invoice, invoice), taken out by the daily job (630 [HN6](14) unit 2c)."),
  "nl:yearly:fallback:check@lib/yearly-fallback.ts": company("Moves to monthly whose answer was unknown, for the daily job to check", "One set for the company: one entry per failed yearly renewal whose move came back unknown, taken out by the daily job (630 [HN6](14) unit 2c)."),
  "nl:yearly:fallback:both@lib/yearly-fallback.ts": company("Renewals paid while their month was charged, for the daily job to refund the month", "One set for the company: one entry per failed yearly renewal found paid in the seconds of its move, taken out by the daily job (630 [HN6](14) unit 2c)."),
  "nl:yearly:price:@lib/yearly-switch.ts": { what: "A yearly price made, per product and currency: counted with its product (PRODUCT_SIDE_BYTES)", room: ["lib/store.ts"] },
};

/**
 * What a part keeps on average over a calendar month, in bytes, the way
 * Upstash bills it (the daily average of the data kept,
 * lib/spend-cost-table.ts). A part written by a unit keeps each unit's
 * bytes for `days` (a whole day at the least, however short its expiry);
 * what is kept in a month was written within that month or the `days`
 * before it, a span that touches windowsOver(days + 31) windows, and each
 * unit is kept at most min(days, 31) of the month's at least 28 days. Never
 * above what can be kept at once (partPeak).
 */
export function partAverage(part: Part, tier: Tier): number {
  if ("capped" in part) return part.capped(tier);
  if ("kept" in part || "item" in part) return 0;
  const days = Math.max(1, Math.ceil(part.days));
  const over = UNITS[part.per](tier) * part.bytes;
  return Math.min(over * windowsOver(days), Math.ceil((over * windowsOver(days + 31) * Math.min(days, 31)) / 28));
}

/** The most a part keeps at one time, in bytes: every unit of every window its expiry touches. */
export function partPeak(part: Part, tier: Tier): number {
  if ("capped" in part) return part.capped(tier);
  if ("kept" in part || "item" in part) return 0;
  return UNITS[part.per](tier) * part.bytes * windowsOver(Math.max(1, Math.ceil(part.days)));
}

/**
 * Every per and capped part, each group as its dearest kind: a group named
 * "order kind/gift" is the kind "gift" of the group "order kind", whose
 * parts add up; a group with no kind named has a kind for each part.
 */
function sum(tier: Tier, of: (part: Part, tier: Tier) => number): number {
  let total = 0;
  const groups = new Map<string, Map<string, number>>();
  for (const [name, family] of Object.entries(FAMILIES)) {
    (family.parts ?? []).forEach((part, i) => {
      const bytes = of(part, tier);
      if (!("per" in part) || !part.group) {
        total += bytes;
        return;
      }
      const [group, kind = `${name}#${i}`] = part.group.split("/");
      const kinds = groups.get(`${part.per}|${group}`) ?? new Map<string, number>();
      kinds.set(kind, (kinds.get(kind) ?? 0) + bytes);
      groups.set(`${part.per}|${group}`, kinds);
    });
  }
  for (const kinds of groups.values()) total += Math.max(...kinds.values());
  return total;
}

/** What a store keeps outside its room on average over a month, in bytes. */
export function reserveBytes(tier: Tier): number {
  return sum(tier, partAverage);
}

/** The most a store keeps outside its room at one time, in bytes: what it can still keep after its plan ends, until it drains or its closing day. */
export function reservePeakBytes(tier: Tier): number {
  return sum(tier, partPeak);
}

/**
 * What a store keeps outside its room for the `days` after its plan ends, in
 * byte-months: everything capped for all of them, and what each part holds
 * at the end for as long as it is kept, at most those days. Nothing new is
 * written for a plan that ended (its figures are an ended store's, priced in
 * the share of stores that pay nothing).
 */
export function afterEndByteMonths(tier: Tier, days: number): number {
  return sum(tier, (part, t) => ("capped" in part ? part.capped(t) * days : "per" in part ? partPeak(part, t) * Math.min(days, Math.max(1, Math.ceil(part.days))) : 0)) / 30;
}

/**
 * What a window keeps of a part for the whole life of what it writes, in
 * byte-months: each unit's bytes for its days. A window's share of the
 * database line (partAverage, a month of what is kept on average) is never
 * less than this (tests/closing-cost.test.ts), so what each window writes is
 * paid for to its end, after the plan's end and the store's closing too.
 */
export function lifetimeByteMonths(part: Part, tier: Tier): number {
  if (!("per" in part)) return 0;
  return (UNITS[part.per](tier) * part.bytes * Math.max(1, Math.ceil(part.days))) / 30;
}

/** What everything capped keeps for the `days` after a plan ends, in byte-months: kept until the closing day, with no expiry of its own. */
export function cappedByteMonths(tier: Tier, days: number): number {
  return sum(tier, (part, t) => ("capped" in part ? part.capped(t) * days : 0)) / 30;
}

/**
 * The units of a free trial, the most a store that pays nothing has of each
 * (lib/store-allowance-rules.ts, NON_PAYING_ALLOWANCES: a store whose plan
 * ended has less of every one), over the 32 UTC days a month touches. What
 * a store writes once its plan has ended, until its closing day, is under it.
 */
export const TRIAL_UNITS: Record<Unit, number> = {
  order: TRIAL_ORDERS,
  call: Math.floor(TRIAL_ORDERS / CALL_ORDER_UNITS),
  request: REQUESTS_PER_VISIT * TRIAL_VISITS + TRIAL_EXTRA_REQUESTS,
  studio: NON_PAYING_ALLOWANCES.trial.studio + ESSENTIAL_PER_DAY * 32,
  api: NON_PAYING_ALLOWANCES.trial.api,
  inbox: NON_PAYING_ALLOWANCES.trial.inbox,
  own: NON_PAYING_ALLOWANCES.trial.email,
  access: NON_PAYING_ALLOWANCES.trial.transactional,
  store: NON_PAYING_ALLOWANCES.trial.email + NON_PAYING_ALLOWANCES.trial.transactional,
  monthly: TRIAL_MONTHLY_EMAILS,
  integration: NON_PAYING_ALLOWANCES.trial.integration,
  buyer: NON_PAYING_ALLOWANCES.trial.buyer,
  webhook: NON_PAYING_ALLOWANCES.trial.webhook,
  run: TRIAL_DAILY_RUNS * 32,
  // A store that pays nothing imports and takes quizzes at Store's figures (tests/plan-cost-registry.ts, nonPayingWorst).
  row: IMPORT_ALLOWANCES.creator.rows,
  ai: 0,
  quiz: QUIZ_MONTHLY_SUBMISSIONS,
  upload: 0,
  day: 32,
};

/**
 * The units of a store whose plan has ended, until its closing day: its own
 * figures where it has them (NON_PAYING_ALLOWANCES.ended, and the requests
 * of a store with no plan, lib/traffic-rules.ts, requestLimitFor), and a
 * free trial's where it has none of its own, which are more.
 */
export const ENDED_UNITS: Record<Unit, number> = {
  ...TRIAL_UNITS,
  request: REQUESTS_PER_VISIT * SETUP_VISITS + SETUP_EXTRA_REQUESTS,
  studio: NON_PAYING_ALLOWANCES.ended.studio + ESSENTIAL_PER_DAY * 32,
  api: NON_PAYING_ALLOWANCES.ended.api,
  inbox: NON_PAYING_ALLOWANCES.ended.inbox,
  own: NON_PAYING_ALLOWANCES.ended.email,
  access: NON_PAYING_ALLOWANCES.ended.transactional,
  store: NON_PAYING_ALLOWANCES.ended.email + NON_PAYING_ALLOWANCES.ended.transactional,
  integration: NON_PAYING_ALLOWANCES.ended.integration,
  buyer: NON_PAYING_ALLOWANCES.ended.buyer,
  webhook: NON_PAYING_ALLOWANCES.ended.webhook,
};

/**
 * The units of a free trial's store once its trial is over, until its closing
 * day: the trial's subscription is no longer running, so the store stands as
 * one whose plan ended (lib/plan-standing.ts, standingOf: "ended" while it has
 * a subscription id or an end date, "none" without), at the more of those two
 * standings' figures where they have them, and a free trial's where they
 * have none (ENDED_UNITS keeps a store with no plan's requests; a trial's,
 * which are more, are kept here). So a trial's store keeps no webhook message
 * after its trial: its month has no webhook deliveries, and a message made
 * with none is not kept (lib/webhooks.ts, emitEvent).
 */
export const AFTER_TRIAL_UNITS: Record<Unit, number> = Object.fromEntries(
  (Object.keys(TRIAL_UNITS) as Unit[]).map((unit) => {
    const kind = unit === "own" ? "email" : unit === "access" ? "transactional" : unit;
    const none = kind in NON_PAYING_ALLOWANCES.none ? NON_PAYING_ALLOWANCES.none[kind as keyof typeof NON_PAYING_ALLOWANCES.none] : TRIAL_UNITS[unit];
    const fromNone = unit === "store" ? NON_PAYING_ALLOWANCES.none.email + NON_PAYING_ALLOWANCES.none.transactional : unit === "studio" ? NON_PAYING_ALLOWANCES.none.studio + ESSENTIAL_PER_DAY * 32 : none;
    return [unit, Math.max(ENDED_UNITS[unit], unit === "request" ? TRIAL_UNITS.request : fromNone)];
  }),
) as Record<Unit, number>;

/** The most a part keeps at one time at a free trial's units, or (`units`) another standing's. */
export function trialPartPeak(part: Part, tier: Tier, units: Record<Unit, number> = TRIAL_UNITS): number {
  if ("capped" in part) return part.capped(tier);
  if (!("per" in part)) return 0;
  return units[part.per] * part.bytes * windowsOver(Math.max(1, Math.ceil(part.days)));
}

const prefixOf = (name: string) => name.slice(0, name.lastIndexOf("@"));
/** Each part's family entry, for what becomes of it when a store closes. */
const FAMILY_OF = new Map<Part, string>(Object.entries(FAMILIES).flatMap(([name, family]) => (family.parts ?? []).map((part): [Part, string] => [part, name])));
const deletes = (name: string) => {
  const rule = CLOSING[prefixOf(name)];
  return Boolean(rule && (rule.how === "erase" || rule.how === "token"));
};

/** What a part still keeps on a store's closing day, at least CLOSING_DAYS after its plan ended: what its paid windows wrote of a part kept longer than that (at `tier`, or for a free trial at its units), and whatever it wrote since, at an ended store's units (AFTER_TRIAL_UNITS after a free trial). */
function keptAtClosing(part: Part, tier: Tier, trial: boolean): number {
  if ("capped" in part) return part.capped(tier);
  if (!("per" in part)) return 0;
  const paid = part.days > CLOSING_DAYS ? (trial ? trialPartPeak(part, tier) : partPeak(part, tier)) : 0;
  return paid + trialPartPeak(part, tier, trial ? AFTER_TRIAL_UNITS : ENDED_UNITS);
}

/**
 * What a closing store's walk deletes outside its room at the most, in bytes
 * (lib/closed-store-data.ts): everything capped, and each part of a family
 * it deletes (CLOSING: erase, token) still kept on its closing day.
 */
export function closingBytes(tier: Tier, trial = false): number {
  return sum(tier, (part, t) => (deletes(FAMILY_OF.get(part) ?? "") ? keptAtClosing(part, t, trial) : 0));
}

/** What a closing store's followers read outside its room at the most, in bytes: what the families they read (FOLLOWED_FAMILIES) still keep on its closing day. */
export function followedBytes(tier: Tier, trial = false): number {
  const followed = new Set<string>(FOLLOWED_FAMILIES);
  return sum(tier, (part, t) => (followed.has(prefixOf(FAMILY_OF.get(part) ?? "")) ? keptAtClosing(part, t, trial) : 0));
}

/** The parts an order keeps for good, which ORDER_DATA_BYTES must hold. */
export function keptParts(): { family: string; bytes: number }[] {
  return Object.entries(FAMILIES).flatMap(([family, f]) => (f.parts ?? []).flatMap((part) => ("kept" in part ? [{ family, bytes: part.kept }] : [])));
}

/** What one product an order hands over keeps for good at the most, which ITEM_DATA_BYTES must hold: the parts of no kind, and those of its dearest kind. */
export function itemBytes(): number {
  let common = 0;
  const kinds = new Map<string, number>();
  for (const f of Object.values(FAMILIES)) {
    for (const part of f.parts ?? []) {
      if (!("item" in part)) continue;
      if (part.kind) kinds.set(part.kind, (kinds.get(part.kind) ?? 0) + part.item);
      else common += part.item;
    }
  }
  return common + Math.max(0, ...kinds.values());
}
