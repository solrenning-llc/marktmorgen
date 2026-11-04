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
import { MAX_STORE_BYTES } from "@/lib/store";
import { KEPT_DAYS, ALL_TIME_PAGES, DAY_FIELDS_MAX, LIFE_WRITE_MAX } from "@/lib/stats";
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
import { MAX_ENDPOINTS, LOG_SIZE as HOOK_LOG } from "@/lib/webhooks";
import { LOG_SIZE as SYNC_LOG } from "@/lib/email-sync";
import { MAX_DEVICES } from "@/lib/phone-alerts";
import { MAX_FEEDS } from "@/lib/calendar-sync";
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
  "nl:backup:ran:@lib/backup-run.ts": company("The mark that a day's backup run started (273 [BK1])", "One key a day holding \"1\", set only if absent and kept 2 days, so at most 3 at once for the company. Built and off: nothing calls the run."),
  "nl:backup:last-ok@lib/backup-run.ts": company("When the last backup copy was verified (273 [BK1])", "One key for the company: a time in ms, kept 8 days. Built and off: nothing calls the run."),
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
  "nl:aff:@lib/affiliate-bond.ts": { what: "Which affiliate a buyer belongs to", parts: [kept(MARK, "A field per buyer, written with a sale, kept for good.")] },
  "nl:aff:@lib/affiliate-codes.ts": { what: "Discount codes given to affiliates", room: ["lib/affiliate-codes.ts"] },
  "nl:affhub:@lib/affiliate-hub.ts": company("The stores an address is an affiliate of", "Per affiliate across stores, in the set of the quarter it was noted in, kept QUARTERS_KEPT quarters at the most: written with an affiliate record (capped by MAX_AFFILIATES per store, below); what a closed store leaves in it is the company's as the hub is, and runs out with its quarter."),
  "nl:affhub:link:@lib/affiliate-hub.ts": company("An emailed link to an affiliate's page, a day", "Per affiliate across stores, behind a per-address limit."),
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
  "nl:course:@lib/assignment.ts": { what: "A course's assignments, the work handed in and what came back", room: ["lib/assignment.ts"], parts: [per("studio", 1, KEY, "The creator told of new work, an hour.")] },
  "nl:tasks:bytes:@lib/assignment.ts": { what: "What a store's students keep handed in, in bytes", parts: [capped(KEY, "One count a store.")] },
  "nl:tasks:doors@lib/assignment.ts": company("Hand-in doors not yet used, swept a day on", "One sorted set for every store, each door a buyer action's (priced in buyer-actions), gone within two days."),
  "nl:auth:devices:@lib/auth.ts": company("Devices an account signed in on", "An account's, not a store's."),
  "nl:auth:fresh:@lib/auth.ts": company("A fresh sign-in", "An account's, minutes."),
  "nl:auth:link:@lib/auth.ts": company("A sign-in link", "An account's, minutes."),
  "nl:auth:move:@lib/auth.ts": company("An address change", "An account's, a day."),
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
  "nl:plan-refund:@lib/plan-refund-write.ts": company("A store's plan refund lock while one is made (305 [SY1])", "One short key a store, the company's money job: a random token, expiring by itself LOCK_SECONDS (345) after it was taken, released at once when the refund is done (lib/plan-refund-write.ts)."),
  "nl:plan-disputes:seen@lib/plan-disputes.ts": company("What each dispute on our own Stripe account turned out to be (232 [CA1] unit 5)", "One hash, the company's job: dispute ids with 'final', 'unmatched:<seconds>' or 'open:<store id>', never an address; 400 days from the last write; a deleted store's id reads as unmatched."),
  "nl:mail:bc:@lib/broadcasts.ts": { what: "Broadcasts and who each goes to", room: ["lib/broadcasts.ts"], parts: [per("studio", 1, KEY, "A broadcast's lock while it sends, minutes.")] },
  "nl:mail:bcs:@lib/broadcasts.ts": { what: "A store's broadcasts, newest first", room: ["lib/broadcasts.ts"] },
  "nl:mail:queue@lib/broadcasts.ts": company("Broadcasts waiting or under way", "One set for every store, each member gone when its broadcast is done; a store's are counted with its broadcasts."),
  "nl:lib:@lib/buyer-library.ts": { what: "The stores an address bought from", parts: [kept(MARK, "A store's id in its buyer's set of the quarter, kept QUARTERS_KEPT quarters at the most (lib/joined-stores.ts): counted as for good, and its whole life priced with its order besides (tests/plan-cost-registry.ts, ORDER_LIBRARY), since it outlives a store that closes.")] },
  "nl:lib:joined:@lib/joined-stores.ts": company("The stores an address joined the list of", "A person's, across stores: one member a store, in the set of the quarter it joined in, kept QUARTERS_KEPT quarters at the most."),
  "nl:lib:link:@lib/buyer-library.ts": short("A library link, a day", "access", 1, LINK_BYTES, MAIL("library")),
  "nl:listed:@lib/buyer-list.ts": short("An order put on the list", "order", 8, MARK),
  "nl:orders:link:@lib/buyer-orders.ts": short("A buyer's purchases link, a day", "access", 1, LINK_BYTES, MAIL("orders")),
  "nl:rl:orders:addr:@lib/buyer-orders.ts": short("Purchase links per address, an hour", "request", 1, KEY, REQ("orders link")),
  "nl:rl:orders:ip:@lib/buyer-orders.ts": short("Purchase links per connection, an hour", "request", 1, KEY, REQ("orders link")),
  "nl:person:@lib/buyer-profile.ts": { what: "Notes about people", room: ["lib/buyer-profile.ts"] },
  "nl:person:find:@lib/buyer-profile.ts": short("A buyer's page found from a search, an hour", "studio", 1, 512),

  // ---------------------------------------------------------------- lib/ c
  "nl:cal:busy:@lib/calendar-sync.ts": { what: "A calendar feed's busy times, ten minutes", parts: [capped(MAX_FEEDS * READING_BYTES, "MAX_FEEDS feeds, each its parsed busy times: at most 2,000 of them.", src("lib/calendar-sync.ts", "MAX_FEEDS"), src("lib/ics-parse.ts", "maxIntervals ?? 2000"))] },
  "nl:cal:cfg:@lib/calendar-sync.ts": { what: "The store's calendar feeds", parts: [capped(MAX_FEEDS * 2 * KB, "MAX_FEEDS addresses.", src("lib/calendar-sync.ts", "MAX_FEEDS"))] },
  "nl:cal:err:@lib/calendar-sync.ts": { what: "A feed's last failure", parts: [capped(MAX_FEEDS * KB, "One per feed, six hours.")] },
  "nl:cal:good:@lib/calendar-sync.ts": { what: "A feed's last good reading", parts: [capped(MAX_FEEDS * READING_BYTES, "One per feed, six hours.", src("lib/calendar-sync.ts", "MAX_FEEDS"))] },
  "nl:cal:lock:@lib/calendar-sync.ts": short("A feed read at a time", "request", 1, 128, REQ("page")),
  "nl:cal:out:@lib/calendar-sync.ts": { what: "The store's calendar file, five minutes", parts: [capped(512 * KB, "One file a store, of what is booked.")] },
  "nl:cal:tok:@lib/calendar-sync.ts": { what: "The store's calendar file's token", parts: [capped(KEY, "One a store.")] },
  "nl:meet:rf:@lib/call-meetings.ts": short("Refunds already handled for meetings", "order", 30, MARK),
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
  "nl:cotrouble:@lib/checkout-trouble.ts": { what: "Checkouts refused by day, and the last reason", parts: [capped(40 * 64 + KB, "A field a day, 35 days, and the last one.")] },
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
  "nl:crm:co:@lib/crm-companies.ts": { what: "Companies and the people linked to them, at what each weighs, at most MAX_COMPANIES", room: ["lib/crm-companies.ts"] },
  "nl:crm:co:lock:@lib/crm-companies.ts": short("One change to a store's companies at a time, ten seconds at the most", "studio", 1, 128),
  "nl:crm:tasks:@lib/crm.ts": { what: "Tasks about a person, at what they weigh, at most MAX_STORE_TASKS", room: ["lib/crm.ts"] },
  "nl:crm:tasklock:@lib/crm.ts": short("One change of a store's tasks at a time, ten seconds at the most", "studio", 1, 128),
  "nl:crm:fields:@lib/crm.ts": { what: "The store's own fields", parts: [capped(MAX_CRM_FIELDS * (MAX_FIELD_OPTIONS + 2) * 160, "MAX_CRM_FIELDS fields and their choices.", src("lib/crm-rules.ts", "MAX_CRM_FIELDS", "MAX_FIELD_OPTIONS"))] },
  "nl:crm:stages:@lib/crm.ts": { what: "The first pipeline's stages, as the board kept them before pipelines", parts: [capped(MAX_STAGES * 256, "MAX_STAGES stages.", src("lib/crm-rules.ts", "MAX_STAGES"))] },
  "nl:crm:pipes:@lib/crm.ts": { what: "The deals' pipelines and their stages (17 October 2026): one slot, at what the record weighs", room: ["lib/crm.ts"] },
  "nl:crm:pacc:@lib/pipeline-access.ts": { what: "What each teammate may do with each pipeline, only where restricted", room: ["lib/pipeline-access.ts"] },
  "nl:crm:v:@lib/crm.ts": { what: "People's values of the store's fields", room: ["lib/crm.ts"] },
  "nl:voice:@lib/customer-voice.ts": { what: "What buyers said, summed up a month", parts: [capped(14 * 16 * KB, "One summary a month, 400 days.")] },
  "nl:voice:lock:@lib/customer-voice.ts": short("One summary at a time", "studio", 1, 128),
  "nl:rsum:@lib/review-ai-summary.ts": short("A product's AI summary of its reviews, kept eight days", "studio", 8, 4 * KB),
  "nl:rsum:lock:@lib/review-ai-summary.ts": short("One review summary at a time", "studio", 1, 128),

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
  "nl:keys:@lib/licence-keys.ts": { what: "License keys: the pool, every key added, who got which", room: ["lib/licence-keys.ts"], parts: [item(512, "A key given: its record and who got it.", "membership"), capped(64 * KB, "The refunds already handled (thirty days) and the marks.")] },
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
  "nl:orders:folders:@lib/orders.ts": company("The stores with orders, a month", "One set a month for every store."),
  "nl:orders:n:@lib/orders.ts": { what: "Orders counted in the window", parts: [capped(0, "Counted with lib/order-admission.ts.")] },
  "nl:orders:seen:@lib/orders.ts": short("An order already counted", "order", 45, MARK),
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
  "nl:pk:reg:@lib/passkeys.ts": company("A passkey being added", "An account's, minutes."),
  "nl:pwyw:@lib/pay-what-you-want.ts": short("A price made for a pay-what-you-want amount: at most one an order, a year", "order", 365, KEY),
  "nl:agree:r:@lib/agreement-store.ts": room("A proposal or agreement: who it is for, each version's fingerprint and signature; counted with room for its signatures and its two index entries before it is written, until it goes by itself (recordRoomBytes)", "lib/agreement-store.ts"),
  "nl:agree:v:@lib/agreement-store.ts": room("One version's exact text, written once: counted before it is written, until its agreement goes by itself (versionRoomBytes)", "lib/agreement-store.ts"),
  "nl:agree:s:@lib/agreement-store.ts": room("The store's agreements, by when made: an entry each, counted with its record", "lib/agreement-store.ts"),
  "nl:agree:p:@lib/agreement-store.ts": room("One person's agreements in a store (at most MAX_PER_PERSON): an entry each, counted with its record", "lib/agreement-store.ts"),
  "nl:agree:lock:@lib/agreement-store.ts": short("An agreement being signed or given a new version, ten seconds", "request", 1, MARK, REQ("agreement-sign")),
  "nl:letters:i:@lib/letters.ts": room("An email published on the store: its subject and words as sent, counted with its entry before it is written, until it goes by itself (letterRoomBytes)", "lib/letters.ts"),
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
  "nl:dun:report:@lib/payment-recovery-report.ts": { what: "Failed renewals, cached", parts: [capped(256 * KB, "One cached view.")] },
  "nl:dun:card:@lib/payment-recovery.ts": { what: "A card already asked about", parts: [per("own", 60, MARK, "Per card asked about by email.", MAIL("card ask"))] },
  "nl:dun:cards:@lib/payment-recovery.ts": { what: "Where the cards were read to", parts: [capped(KEY, "One a store.")] },
  "nl:dun:cursor@lib/payment-recovery.ts": company("Where the recovery job stopped", "One key, the company's job."),
  "nl:pp:@lib/paypal-payouts.ts": { what: "The creator's PayPal app, and its lock", parts: [capped(4 * KB, "One a store.")] },
  "nl:pp:item:@lib/paypal-payouts.ts": short("A PayPal payout item written into the book: up to three partners a sale", "order", 400, 3 * MARK),
  "nl:pp:open:@lib/paypal-payouts.ts": { what: "Payout batches not yet settled", parts: [capped((MAX_AFFILIATES + 1) * 512, "A line per affiliate in an open batch.", src("lib/affiliate-setting.ts", "MAX_AFFILIATES"))] },
  "nl:pp:stores@lib/paypal-payouts.ts": company("Stores with a batch open", "One set for every store."),
  "nl:ppsell:o:@lib/paypal-sales.ts": { what: "A PayPal order opened", parts: [per("order", 30, KB, "Its record, thirty days at most.", KIND("paypal")), per("request", 3, 768, "One opened and never paid, three days.", REQ("paypal checkout"))] },
  "nl:ppsell:own:@lib/paypal-sales.ts": short("The paid orders behind one address's product", "order", 400, MARK, KIND("paypal")),
  "nl:ppsell:paid:@lib/paypal-sales.ts": short("A PayPal order paid", "order", 400, KB, KIND("paypal")),
  "nl:ppsell:pending:@lib/paypal-sales.ts": short("Orders whose payment PayPal holds, until it completes", "order", 30, MARK, KIND("paypal")),
  "nl:ppsell:refunded:@lib/paypal-sales.ts": short("Orders PayPal refunded", "order", 400, MARK, KIND("paypal")),
  "nl:ppsell:sales:@lib/paypal-sales.ts": short("Every paid order", "order", 400, MARK, KIND("paypal")),
  "nl:ppsell:watch:@lib/paypal-sales.ts": short("Paid orders inside PayPal's refund window", "order", 180, MARK, KIND("paypal")),
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
  "nl:rev:refunds:seen:@lib/review-proof.ts": { what: "Refunds already handled for reviews", parts: [capped(64 * KB, "Thirty days.")] },
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
  "nl:allow:@lib/store-allowance.ts": { what: "Each figure taken in the window", parts: [capped(8 * 2 * KEY, "Eight figures, the window and the one before.")] },
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
  "nl:2fa:locked:@lib/two-step.ts": company("A session let in without its second step", "An account's."),
  "nl:2fa:lockedset:@lib/two-step.ts": company("An account's locked sessions", "An account's."),
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
  "nl:hooks:d:@lib/webhooks.ts": short("One delivery and how it went, a week", "webhook", 7, 4 * KB),
  "nl:hooks:evt:@lib/webhooks.ts": { what: "An event already sent", parts: [per("order", 30, MARK, "A sale."), per("webhook", 30, MARK, "Any other.")] },
  "nl:hooks:log:@lib/webhooks.ts": { what: "The store's last deliveries", parts: [capped(HOOK_LOG * 64, "The newest LOG_SIZE.", src("lib/webhooks.ts", "LOG_SIZE"))] },
  "nl:hooks:pos@lib/webhooks.ts": company("Where the webhook job stopped", "One key, the company's job."),
  "nl:hooks:q@lib/webhooks.ts": company("Deliveries waiting for a try", "One sorted set, members gone within a week: each a webhook's."),
  "nl:hooks:stores@lib/webhooks.ts": company("Stores with any endpoint", "One set for every store."),
  "nl:rl:hooks:test:@lib/webhooks.ts": short("Tests counted", "studio", 1, 128),
  "nl:wo:due@lib/welcome-offer-send.ts": company("Welcome offers due", "One sorted set for every store, each a sign-up's."),
  "nl:wo:n:@lib/welcome-offer-send.ts": short("Welcome offers counted", "day", 62, 128),
  "nl:wo:r:@lib/welcome-offer-send.ts": short("A welcome offer's reminder set, once per free copy", "order", 430, MARK),
  "nl:wo:start:@lib/welcome-offer-send.ts": short("A welcome offer started: once per free copy, 400 days after it ends", "order", 430, MARK),
  "nl:wb:@lib/winback-send.ts": short("A come-back offer sent to a member by email", "own", 90, MARK, MAIL("come back")),
  "nl:wb:cursor@lib/winback-send.ts": company("Where the come-back job stopped", "One key, the company's job."),
  "nl:wb:link:@lib/winback-send.ts": short("A come-back link", "own", 60, LINK_BYTES, MAIL("come back")),
  "nl:wb:n:@lib/winback-send.ts": short("Come-back offers counted", "day", 62, 128),
  "nl:wb:once:@lib/winback-send.ts": short("An address told of a product", "own", 60, KEY, MAIL("come back")),
  "nl:yearask:@lib/yearly-ask.ts": { what: "A member asked to go yearly", parts: [item(MARK, "One a membership, five years: counted as for good.", "membership")] },
  "nl:yearask:count:@lib/yearly-ask.ts": short("Asks counted a month", "day", 62, 128),
  "nl:yearask:cursor@lib/yearly-ask.ts": company("Where the yearly ask stopped", "One key, the company's job."),
  "nl:firstsale:@lib/yearly-offer.ts": company("A store's first sale", "The company's offer to a creator about their own plan."),
  "nl:yearly-offer:@lib/yearly-offer.ts": company("A yearly offer made", "The company's offer to a creator about their own plan."),
  "nl:tier:@lib/yearly-switch.ts": short("A membership's lock while it goes yearly", "request", 1, 128, REQ("tier switch")),
  "nl:yearly:link:@lib/yearly-switch.ts": short("A link to go yearly", "own", 30, LINK_BYTES, MAIL("yearly")),
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

/** What a part still keeps on a store's closing day, at least CLOSING_DAYS after its plan ended: what its paid windows wrote of a part kept longer than that (at `tier`, or for a free trial at its units), and whatever it wrote since, at an ended store's units (a free trial's after its trial). */
function keptAtClosing(part: Part, tier: Tier, trial: boolean): number {
  if ("capped" in part) return part.capped(tier);
  if (!("per" in part)) return 0;
  const paid = part.days > CLOSING_DAYS ? (trial ? trialPartPeak(part, tier) : partPeak(part, tier)) : 0;
  return paid + trialPartPeak(part, tier, trial ? TRIAL_UNITS : ENDED_UNITS);
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
