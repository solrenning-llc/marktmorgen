import { PATH_GROWTH_READ_UNITS } from "@/lib/path-growth-facts";
import { API_SALES_READ } from "./plan-cost-registry";
import { bundleItemUnits, collectionUnits } from "@/lib/page-read-rules";
import { MAX_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import { MAX_BUMPS } from "@/lib/product-extras";
import { MAX_COLLECTION_PRODUCTS } from "@/lib/store-collections";
import { bundleItemRead, collectionRead } from "./plan-cost-registry";
import { checkUnits, searchUnits, walkUnits } from "@/lib/community-read-rules";
import { SEARCH_CONVERSATIONS } from "@/lib/community-dm";
import { ACCESS_CHECK_READ, searchRead, walkRead } from "./plan-cost-registry";
import { PATH_GROWTH_READ } from "./plan-cost-registry";
import { AGENDA_READ, BUYER_LEDGER, SCHEDULED_READS } from "./plan-cost-registry";
import { TEST_SALES_PAGES } from "@/lib/broadcasts";
import { ALL_TIME_PAGES } from "@/lib/stats";
import { AGENDA_UNITS, MAX_TASK_RECORD_BYTES, agendaReadUnits } from "@/lib/person-agenda";
import { IncludedBytes, PAGE_INCLUDED_BYTES, STUDIO_UNIT_SENT_BYTES, sentUnits } from "@/lib/sent-bytes";
import { BUYER_LEDGER_UNITS, IMPORTED_BUYER_BYTES, LEDGER_BYTES_PER_UNIT, ledgerReadBytes, ledgerUnits } from "@/lib/segments";
import { PAYPAL_LEDGER, PAYPAL_LEDGER_BYTES } from "./plan-cost-registry";
import { LOCKED_UNTIL_STAR_COMMANDS, ROUND_TRIP_SECONDS, TAKE_COMMANDS, apiReadCost } from "./plan-cost-registry";
import {
  API_UNIT_BYTES, API_UNIT_COMMANDS, API_UNIT_ROUND_TRIPS, API_UNIT_SENT_BYTES, API_UNIT_STRIPE_PAGES, BOOKING_PAGES, BOOK_INVOICES, BOOK_MOVES,
  BOOK_PAYPAL_REFUNDS, MORE_TAKE_COMMANDS, type BookSizes, type ReadWork, apiReadUnits, bookWork, bookingsWork, studentsPageWork, withTaking,
  DISPUTE_READ_PAGES, EMAILS_BROADCASTS, MAIL_REVENUE_PAGES, MEMBERSHIPS_COLD_WORK, MEMBERSHIP_PAGES, REFUND_READ_PAGES, RENEWAL_PAGES, SALES_PAGES,
  codesWork, emailsWork, eventsWork, listingsWork, mailRevenueColdWork, membershipsWork, numbersWork, productsPageWork, scannedPageWork,
  API_PAGE_ROWS, EMAILS_PROBE_WORK, NUMBERS_KEEP_WORK, NUMBERS_KEPT_BYTES, NUMBERS_SENT_BYTES, addWork, boughtNextWork, keptNumbersWork, listPageMost, settledUnits,
  EVENTS_PROBE_MOST, LOG_ENTRY_BYTES, codeMakeWork, codeStopWork, eventsSentMost,
} from "@/lib/api-read-rules";
import { DELIVERY_MAX_BYTES, LOG_SIZE, RECENT_MESSAGES_MAX } from "@/lib/webhooks";
import { BOOK_STRIPE_PAGES, STUDIO_UNIT_BYTES, STUDIO_UNIT_COMMANDS, bulkUnits } from "@/lib/affiliates";
import { PATH_BOARD_JOIN_UNITS } from "@/lib/path-board-rules";
import { PATH_REMINDER_UNITS } from "@/lib/path-reminder-rules";
/**
 * The registry of every metered feature's worst month
 * (tests/plan-cost-registry.ts) cannot fall behind the code: a feature that
 * adds a counter or a limit constant fails here until it says where its cost
 * is counted, and a line whose sources moved fails until it points at them
 * again. Added 17 October 2026, when the per-plan model was found to leave
 * out every feature merged that day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PATH_READ_UNITS } from "@/lib/path";
import { TASKS_RECOUNT_BYTES, TASKS_RECOUNT_UNITS, TASK_KEPT_BYTES, tasksRecountUnits } from "@/lib/crm";
import { MAX_PERSON_TASKS, MAX_STORE_TASKS } from "@/lib/person-tasks";
import { ADD_ON_LINES, ASSIST_REMIND_READ, CERTIFICATE_PDF_READ, PATH_REMINDER_PUSH, PATH_BOARD_JOIN, PATH_BOARD_PRIVACY, PATH_PAGE, PATH_STUDIO_PAGE, PATH_READ, COST_LINES, EMAIL_SITES, KIND_LINES, NEXT_OFFER_READ, NOT_A_COST, OPEN, PER_PAYMENT_LINES, PICTURE_READ, SCOPES, UNIT_COST, nonPayingWorst, request } from "./plan-cost-registry";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { CART_OFFER_REQUEST_UNITS } from "@/lib/cart-offers";
import { ASSIST_REMIND_REQUEST_UNITS } from "@/lib/assistant-reminder-rules";
import { DRIP_RUN_UNITS_PER_STORE_EMAIL, dripStartUnits } from "@/lib/drip-start-rules";
import { DOWNLOAD_LOOKUP_READ, ORDERS_BUNDLE_READ, ORDERS_OLDER_READ, ORDERS_OPEN_READ, ORDERS_METERED_COMMAND, ORDERS_METERED_LISTING, ORDERS_METERED_MOVES } from "./plan-cost-registry";
import { DOWNLOAD_LOOKUP_UNITS, ORDERS_BUNDLE_UNITS, ORDERS_CALL_MOVES, ORDERS_MOVES_READ_COMMANDS, ORDERS_OLDER_UNITS, ORDERS_LISTING_COMMANDS, ORDERS_OPEN_UNITS, ORDERS_UNIT_COMMANDS, ordersMovesCommands } from "@/lib/buyer-orders-rules";
import { MOVES_PER_MGET, moveReads } from "@/lib/call-moves-read";

/** What an opening of the orders page, a bundle's products and a batch of older purchases keep above what they cost: a tenth (C3-83, 4 November 2026). */
const ORDERS_SPARE = 1.1;
import { assessCustomerWorstCase } from "@/lib/net-margin-rules";
import { ADD_ON_ROOM_CENTS, assistantMeetsFloor, assistantMonthWorst } from "@/lib/store-assistant-rules";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { laterPageCost } from "./traffic-cost";
import { PICTURE_REQUEST_UNITS } from "@/lib/buyer-actions";
import { LIBRARY_WAITING_UNITS, affiliateLoadUnits, affiliatePageUnits, listingUnits, sitemapUnits } from "@/lib/public-read-rules";
import { MAX_POST_PAGES } from "@/lib/store-sitemap";
import { DAY_WINDOWS, affiliateLoadRead, affiliatePageRead, dripStartRead, libraryCardWait, libraryWaitingRead, publicListingsRead, sitemapRead } from "./plan-cost-registry";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { CERTIFICATE_PDF_UNITS } from "@/lib/certificate-pdf";
import { ALLOWANCE_KINDS, API_SALES_UNITS, API_WRITE_UNITS, NON_PAYING_ALLOWANCES, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { CALL_ORDER_UNITS } from "@/lib/order-rules";
import { SETUP_EXTRA_REQUESTS, SETUP_VISITS, TRIAL_EXTRA_REQUESTS, TRIAL_VISITS } from "@/lib/traffic-rules";
import { TIERS } from "@/lib/plan";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { VIDEO_HOURS_INCLUDED } from "@/lib/watch-rules";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}
const code = ["app", "lib", "components"].flatMap((dir) => walk(dir));

/** Every scope a counter is called with, as tests/plan-cost-registry.ts names them, and the counters it is called with. */
function scopesInCode(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (scope: string, file: string) => found.set(scope, [...(found.get(scope) ?? []), file]);
  for (const file of code) {
    const text = read(file);
    // withinServiceWhy and essentialLimitState expose refusal reasons for the same counters.
    for (const m of text.matchAll(/\b(?:within(EssentialLimit|Limit|Month|Store|Service)(?:Why)?|essentialLimitState)\(([^,]+),/g)) {
      const literals = [...m[2].matchAll(/"([^"]+)"/g)].map((l) => l[1]);
      if (literals.length) for (const l of literals) { add(l, file); counters.set(l, new Set([...(counters.get(l) ?? []), m[1] ?? "EssentialLimit"])); }
      else add(`<dynamic:${m[2].trim()}>`, file);
    }
    for (const m of text.matchAll(/\bcountUse\(([^,]+),/g)) add(`countUse:${m[1].trim().slice(0, 60)}`, file);
  }
  return found;
}
const counters = new Map<string, Set<string>>();

const ids = new Set(COST_LINES.map((line) => line.id));
const openIds = new Set(OPEN.map((item) => item.id));

test("every line has a unique id, a figure for every plan, and sources that hold what it names", () => {
  assert.equal(ids.size, COST_LINES.length);
  for (const line of [...COST_LINES, ...PER_PAYMENT_LINES]) {
    for (const tier of TIERS) {
      const usd = line.monthlyUsd(tier);
      assert.ok(Number.isFinite(usd) && usd >= 0, `${line.id}, ${tier}: ${usd}`);
    }
    assert.ok(line.sources.length > 0, `${line.id} names no source`);
    for (const source of line.sources) {
      assert.ok(existsSync(join(root, source.file)), `${line.id}: ${source.file} is not there`);
      const text = read(source.file);
      for (const name of source.names) assert.ok(text.includes(name), `${line.id}: ${source.file} does not hold ${name}`);
    }
  }
});

test("every counter in the code is classified: counted in a line, an account or provider guard, or an open item", () => {
  const found = scopesInCode();
  const missing = [...found.keys()].filter((scope) => !Object.hasOwn(SCOPES, scope));
  assert.deepEqual(missing.map((scope) => `${scope} (${found.get(scope)!.join(", ")})`), [], "classify each in SCOPES of tests/plan-cost-registry.ts, with the line its cost is in or an OPEN item");
  for (const [scope, kind] of Object.entries(SCOPES)) {
    if ("line" in kind) assert.ok(ids.has(kind.line), `${scope}: no line ${kind.line}`);
    if ("open" in kind) assert.ok(openIds.has(kind.open), `${scope}: no open item ${kind.open}`);
    if ("guard" in kind) assert.ok(kind.guard.length > 10, `${scope}: say why it is a guard`);
  }
  // A scope that left the code leaves the registry too, so it stays a list of what is there.
  const gone = Object.keys(SCOPES).filter((scope) => !found.has(scope));
  assert.deepEqual(gone, [], "remove scopes no longer in the code");
});

test("every exported limit or cost constant in lib/ is cited by a line, an open item or NOT_A_COST", () => {
  const metered = /(_PER_(DAY|HOUR|MINUTE|MONTH|30_DAYS|STORE|SHARE|TEN_MINUTES)|DAILY|MONTHLY|_INCLUDED|^WORST_|WORST_|ALLOWANCES?$|_LIMITS$|_BY_TIER)/;
  const cited = new Set([
    ...[...COST_LINES, ...PER_PAYMENT_LINES, ...ADD_ON_LINES].flatMap((line) => line.sources.flatMap((s) => s.names)),
    ...OPEN.flatMap((item) => item.names ?? []),
    ...Object.keys(NOT_A_COST),
  ]);
  const uncited: string[] = [];
  for (const file of code.filter((f) => f.startsWith("lib/"))) {
    for (const m of read(file).matchAll(/^export const ([A-Z][A-Z0-9_]+)\b/gm)) {
      if (metered.test(m[1]) && !cited.has(m[1])) uncited.push(`${m[1]} (${file})`);
    }
  }
  assert.deepEqual(uncited, [], "cite each in a line's sources, an OPEN item's names, or NOT_A_COST with the reason");
});

test("every add-on is priced against what it collects, retains reviewed positive net or is not on sale, and its sources hold what it names", () => {
  assert.ok(ADD_ON_LINES.some((line) => line.id === "store-assistant"));
  const addOnIds = new Set(ADD_ON_LINES.map((line) => line.id));
  assert.equal(addOnIds.size, ADD_ON_LINES.length);
  for (const line of ADD_ON_LINES) {
    assert.ok(!ids.has(line.id), `${line.id} is also a plan's line`);
    const usd = line.monthlyUsd();
    assert.ok(Number.isFinite(usd) && usd > 0 && line.revenueUsd > 0, line.id);
    // Since 18 October 2026 received in the one model of lib/receiving-costs.ts; an add-on past its allowance may not be on sale (docs/margin-alignment-2026-10-18.md).
    if(line.allowedUsd===null)assert.equal(line.onSale,false,`${line.id}: unknown reviewed tax budget cannot be on sale`);
    else if (usd > line.allowedUsd - ADD_ON_ROOM_CENTS / 100 + 1e-9) assert.equal(line.onSale, false, `${line.id}: $${usd.toFixed(2)} against $${line.allowedUsd.toFixed(2)} allowed, with $${(ADD_ON_ROOM_CENTS / 100).toFixed(2)} kept, and on sale`);
    for (const source of line.sources) {
      assert.ok(existsSync(join(root, source.file)), `${line.id}: ${source.file} is not there`);
      const text = read(source.file);
      for (const name of source.names) assert.ok(text.includes(name), `${line.id}: ${source.file} does not hold ${name}`);
    }
    console.log(`add-on ${line.id}: collects $${line.revenueUsd.toFixed(2)}, costs at most $${usd.toFixed(2)}, $${line.allowedUsd===null?'unknown':line.allowedUsd.toFixed(2)} allowed`);
  }
  // The Store assistant has explicit non-tax costs, but no real scoped tax review.
  const month = assistantMonthWorst();
  const assessed = assessCustomerWorstCase(month.review);
  // Meeting the floor is the review approving it with its room; on sale needs both (lib/opening.ts).
  assert.equal(assistantMeetsFloor(), assessed.approved && month.roomCents!==null && month.roomCents >= ADD_ON_ROOM_CENTS, JSON.stringify(assessed));
  if (ASSISTANT_ON_SALE) assert.ok(assessed.approved && assessed.marginBps !== null && assessed.netCents!==null && assessed.netCents>=1 && month.roomCents!==null && month.roomCents>=ADD_ON_ROOM_CENTS, JSON.stringify(assessed));
});

test("the features merged on October 17, 2026 are each a line of the worst month", () => {
  for (const id of ["workflows", "imports", "clickfunnels", "funnel-share", "collections", "embed", "ai", "team-scheduling", "orders", "visits"]) assert.ok(ids.has(id), id);
});

test("lesson video's legacy invoice line stays out of reach: admission stops at every plan's hours first", () => {
  for (const tier of TIERS) assert.ok(PAID_VIDEO_HOURS[tier] < VIDEO_HOURS_INCLUDED, tier);
});

test("nothing is billed for visits or orders: the daily job settles neither, and their meters owe nothing", () => {
  const job = read("app/api/cron/usage/route.ts");
  assert.doesNotMatch(job, /settleAllVisits|settleAllOrders|visitsOwedCents|ordersOwedCents/);
  for (const file of ["lib/traffic-billing.ts", "lib/orders-billing.ts"]) {
    const text = read(file);
    assert.match(text, /owed: \(\) => 0,/, file);
    assert.doesNotMatch(text, /settleUsage|settleAllUsage/, file);
  }
});

test("a scope priced as a public request or a call out is counted in the store's window, not only per connection", () => {
  scopesInCode();
  for (const [scope, kind] of Object.entries(SCOPES)) {
    if (!("line" in kind)) continue;
    const used = counters.get(scope);
    if (kind.line === "public-requests") assert.deepEqual([...(used ?? [])], ["Store"], `${scope}: count it with withinStore (lib/metered-limits.ts)`);
    if (kind.line === "integrations") assert.deepEqual([...(used ?? [])], ["Service"], `${scope}: count it with withinService (lib/metered-limits.ts)`);
  }
});

test("every store figure taken in the code is a kind a line prices", () => {
  for (const kind of ALLOWANCE_KINDS) assert.ok(ids.has(KIND_LINES[kind]), kind);
  const taken = new Set<string>();
  for (const file of code) for (const m of read(file).matchAll(/\btakeAllowance\([^,]+,\s*"([a-z]+)"/g)) taken.add(m[1]);
  for (const kind of taken) assert.ok((ALLOWANCE_KINDS as readonly string[]).includes(kind), `takeAllowance with "${kind}", which no line prices`);
  for (const kind of ["studio", "api", "inbox", "integration", "buyer", "webhook"]) assert.ok(taken.has(kind) || kind === "integration", `nothing takes ${kind}`);
});

test("every email sent names a meter, and each file only the meters it may use", () => {
  const sending = code.filter((file) => /\bsend(?:Email|Batch)\(/.test(read(file).replace(/export async function send(?:Email|Batch)\(/g, "")));
  const unlisted = sending.filter((file) => !Object.hasOwn(EMAIL_SITES, file));
  assert.deepEqual(unlisted, [], "add each file that sends email to EMAIL_SITES in tests/plan-cost-registry.ts, with the meters it may use");
  for (const [file, allowed] of Object.entries(EMAIL_SITES)) {
    assert.ok(existsSync(join(root, file)), `${file} is not there`);
    const meters = [...read(file).matchAll(/\bby: "(company|order|monthly|store)"/g)].map((m) => m[1]);
    assert.ok(meters.length > 0, `${file} sends no metered email: remove it from EMAIL_SITES`);
    for (const meter of meters) assert.ok(allowed.includes(meter), `${file} counts an email as "${meter}", which EMAIL_SITES does not allow it`);
    for (const m of read(file).matchAll(/by: "store", store[^}]*kind: "(\w+)"/g)) assert.ok(m[1] === "email" || m[1] === "transactional", `${file}: kind ${m[1]}`);
  }
});

test("the units a figure is taken in cost at least what they stand for", () => {
  // A studio page drawn is STUDIO_PAGE_UNITS studio requests: more than a heavy read of eighty commands and 400 KB.
  assert.ok(STUDIO_PAGE_UNITS * UNIT_COST.studio >= request("heavy", 80, 400_000));
  // A contact added or a product given is API_WRITE_UNITS requests: more than a write of sixty commands.
  assert.ok(API_WRITE_UNITS * UNIT_COST.api >= request("write", 60, 20_000));
  // A page of sales read through the API is API_SALES_UNITS requests: more than its wait on Stripe, its reads and its answer cost (lib/api-sales.ts).
  // With room: at least 5% more than that worst page.
  assert.ok(API_SALES_UNITS * UNIT_COST.api >= 1.05 * API_SALES_READ, `${API_SALES_UNITS} x ${UNIT_COST.api} < 1.05 x ${API_SALES_READ}`);
  // A booked call is CALL_ORDER_UNITS orders: its confirmation to buyer and host and its two reminders are four emails.
  assert.ok(CALL_ORDER_UNITS * 2 >= 4);
  // A community picture is PICTURE_REQUEST_UNITS public requests, each priced as a later page: more than its megabyte through us costs.
  assert.ok(PICTURE_REQUEST_UNITS * laterPageCost() >= PICTURE_READ, `${PICTURE_REQUEST_UNITS} x ${laterPageCost()} < ${PICTURE_READ}`);
  // A collection's products (lib/page-read-rules.ts, 4 November 2026): at every size the requests taken cost more than what they read.
  for (let products = 1; products <= MAX_COLLECTION_PRODUCTS; products += 1) assert.ok(collectionUnits(products) * laterPageCost() >= collectionRead(products), `collection of ${products}`);
  // The items its bundles hold (Codex G2 on #2583): every product and every one its checkout boxes offer may be a bundle of MAX_BUNDLE_ITEMS.
  for (let items = 1; items <= MAX_COLLECTION_PRODUCTS * (1 + MAX_BUMPS) * MAX_BUNDLE_ITEMS; items += 1) assert.ok(bundleItemUnits(items) * laterPageCost() >= bundleItemRead(items), `${items} bundle items`);
  console.log(`a collection of 8 products: ${1 + collectionUnits(8)} requests with its page ($${collectionRead(8).toFixed(6)} past it), ${1 + collectionUnits(MAX_COLLECTION_PRODUCTS)} at the largest`);
  // A community search, its access checks and each step of the walk of its archive (lib/community-read-rules.ts,
  // 4 November 2026): at every size the requests taken cost more than what they read.
  for (const room of [false, true]) for (let conversations = 0; conversations <= SEARCH_CONVERSATIONS; conversations += 1) {
    assert.ok(searchUnits({ room, conversations }) * laterPageCost() >= searchRead({ room, conversations }), `search ${room} ${conversations}`);
  }
  for (const checks of [1, 2, 20]) assert.ok(checkUnits(checks) * laterPageCost() >= checks * ACCESS_CHECK_READ, `${checks} checks`);
  for (const commands of [0, 1, 24, 25, 26, 600, 30_000]) for (const bytes of [0, 1, 999_999, 1_000_000, 1_000_001, 51_200_000]) {
    assert.ok(walkUnits(commands, bytes) * laterPageCost() >= walkRead(commands, bytes), `walk step ${commands} commands ${bytes} bytes`);
  }
  console.log(`a community search: ${1 + searchUnits({ room: false, conversations: 0 })} requests with its page, ${1 + searchUnits({ room: true, conversations: 3 })} with the room and three conversations ($${searchRead({ room: true, conversations: 3 }).toFixed(6)})`);
  // A certificate's PDF is CERTIFICATE_PDF_UNITS public requests, all taken before it is drawn: more than its CPU, its time and its bytes cost.
  assert.ok(CERTIFICATE_PDF_UNITS * laterPageCost() >= CERTIFICATE_PDF_READ, `${CERTIFICATE_PDF_UNITS} x ${laterPageCost()} < ${CERTIFICATE_PDF_READ}`);
  console.log(`a certificate's PDF: $${CERTIFICATE_PDF_READ.toFixed(6)} at most, counted as ${CERTIFICATE_PDF_UNITS} requests at $${laterPageCost().toFixed(6)}`);
  // The Store assistant's next product after a purchase is NEXT_OFFER_REQUEST_UNITS public requests: more than its reads and Stripe calls cost.
  assert.ok(NEXT_OFFER_REQUEST_UNITS * laterPageCost() >= NEXT_OFFER_READ, `${NEXT_OFFER_REQUEST_UNITS} x ${laterPageCost()} < ${NEXT_OFFER_READ}`);
  console.log(`next product after a purchase: $${NEXT_OFFER_READ.toFixed(6)} at most, counted as ${NEXT_OFFER_REQUEST_UNITS} requests at $${laterPageCost().toFixed(6)}`);
  // The offers after a cart read what the buyer owns with the same reads and Stripe calls (ownedHere), without the model or the choice's
  // product reads, and count as many requests (lib/cart-offers.ts): the same ceiling holds them.
  assert.equal(CART_OFFER_REQUEST_UNITS, NEXT_OFFER_REQUEST_UNITS);
  // And its checkout reminder is ASSIST_REMIND_REQUEST_UNITS public requests: more than its reads and Stripe calls cost.
  assert.ok(ASSIST_REMIND_REQUEST_UNITS * laterPageCost() >= ASSIST_REMIND_READ, `${ASSIST_REMIND_REQUEST_UNITS} x ${laterPageCost()} < ${ASSIST_REMIND_READ}`);
  console.log(`a Store assistant checkout reminder: $${ASSIST_REMIND_READ.toFixed(6)} at most besides its email and model, counted as ${ASSIST_REMIND_REQUEST_UNITS} requests at $${laterPageCost().toFixed(6)}`);
  // A drip run's read of a student's start takes units of the daily job's own figure sized by the store's courses
  // (lib/drip-start-rules.ts), never the store's public requests: at every size, from a store with no course to one
  // whose every product is a course, the units, each at a later page's cost, cost more than the read.
  for (const courses of [0, 1, 5, 6, 7, 12, 13, 100, 1_000, MAX_PRODUCTS]) {
    assert.ok(dripStartUnits(courses) * laterPageCost() >= dripStartRead(courses), `drip start, ${courses} courses: ${dripStartUnits(courses)} x ${laterPageCost()} < ${dripStartRead(courses)}`);
  }
  // One read of a one-course store for each email of the store's month, in one run (dripRunUnits).
  assert.equal(DRIP_RUN_UNITS_PER_STORE_EMAIL, dripStartUnits(1));
  assert.ok(read("lib/learn.ts").includes("used + units <= dripRunUnits(store, nowSeconds)"), "the drip job takes its reads from its own figure");
  assert.ok(!read("lib/learn.ts").includes("takeBuyerRead"), "the drip job takes nothing from the store's public requests");
  assert.ok(read("vercel.json").includes("\"path\": \"/api/cron/courses\",\n      \"schedule\": \"0 11 * * *\""), "the course job runs once a day");
  console.log(`a drip run's read of one student's start: $${dripStartRead(1).toFixed(6)} at most for a store of one course, taken as ${dripStartUnits(1)} units of the job's own figure at $${laterPageCost().toFixed(6)}`);
  for (const tier of ["creator", "pro", "scale"] as const) {
    const month = DAY_WINDOWS * STORE_ALLOWANCES[tier].email * DRIP_RUN_UNITS_PER_STORE_EMAIL * laterPageCost();
    assert.ok(month > 0, `the drip job's month for ${tier} is never zero`);
    console.log(`the drip job's start reads for one ${tier} store: $${month.toFixed(2)} a month at most (a company cost, NOT_A_COST.DRIP_RUN_UNITS_PER_STORE_EMAIL)`);
  }
  // An affiliate's own page and the store's map take requests sized by what they read (lib/public-read-rules.ts, 4 November 2026):
  // at every size, from an empty program or store to the largest, the requests cost more than the reads.
  const sizes = [0, 1, 15, 16, 17, 31, 32, 33, 149, 150, 151, 500, 1_000, 5_000, 50_000, 1_000_000];
  for (const fields of sizes) for (const rows of [0, 1, 16, 17, 200, 700, 5_000]) for (const listings of [0, 1, 32, 33, 1_000, 2_000]) for (const stripePages of [0, 1, 3, 13, 23, 40]) {
    const size = { fields, rows, listings, stripePages };
    assert.ok(affiliatePageUnits(size) * laterPageCost() >= affiliatePageRead(size), `affiliate book ${JSON.stringify(size)}: ${affiliatePageUnits(size)} x ${laterPageCost()} < ${affiliatePageRead(size)}`);
  }
  for (const sliceBytes of [0, 1, 65_536, 65_537, 131_072, 131_073, 1_000_000, 8_000_000]) for (const listings of [0, 1, 32, 33, 2_000]) for (const codes of [null, 0, 1, 150, 151, 5_000]) {
    const load = { sliceBytes, listings, codes };
    assert.ok(affiliateLoadUnits(load) * laterPageCost() >= affiliateLoadRead(load), `affiliate load ${JSON.stringify(load)}: ${affiliateLoadUnits(load)} x ${laterPageCost()} < ${affiliateLoadRead(load)}`);
  }
  for (const listings of [0, 1, 31, 32, 33, 100, MAX_PRODUCTS]) {
    // Somebody not signed in: the page itself is the request isResting counts, and its listings take listingUnits more.
    assert.ok(listingUnits(listings) * laterPageCost() >= publicListingsRead(listings), `affiliate terms, ${listings} listings`);
    for (const carried of [0, 1, 999, 1_000, 1_001, MAX_PRODUCTS]) for (const postPages of [0, 1, 4, 5, 6, MAX_POST_PAGES]) {
      const size = { listings, carried, postPages };
      assert.ok(sitemapUnits(size) * laterPageCost() >= sitemapRead(size), `store map ${JSON.stringify(size)}: ${sitemapUnits(size)} x ${laterPageCost()} < ${sitemapRead(size)}`);
    }
  }
  // A store's card in the buyer's library pays for what it reads of what waits there, at its largest (Codex J, #1969), and no more than that needs.
  assert.ok(LIBRARY_WAITING_UNITS * laterPageCost() >= libraryWaitingRead(), `library card: ${LIBRARY_WAITING_UNITS} x ${laterPageCost()} < ${libraryWaitingRead()}`);
  // And the card's own wait on Redis, held by a test rather than only a comment (Claude 5 on #1969).
  assert.ok(LIBRARY_WAITING_UNITS * laterPageCost() >= libraryWaitingRead() + libraryCardWait(), `library card with its wait: ${LIBRARY_WAITING_UNITS} x ${laterPageCost()} < ${libraryWaitingRead()} + ${libraryCardWait()}`);
  assert.ok((LIBRARY_WAITING_UNITS - 1) * laterPageCost() < libraryWaitingRead(), `library card: ${LIBRARY_WAITING_UNITS} units, one more than needed`);
  const typicalBook = { fields: 50 + 50 + 1_000 + 40 + 20, rows: 5, listings: 20, stripePages: 23 };
  const typicalLoad = { sliceBytes: 12_000, listings: 3, codes: null };
  console.log(`an affiliate program's book worked out: ${affiliatePageUnits(typicalBook)} requests for 50 affiliates and 1,000 sales ($${affiliatePageRead(typicalBook).toFixed(6)}), at most once a day; each other load ${affiliateLoadUnits(typicalLoad)} ($${affiliateLoadRead(typicalLoad).toFixed(6)}), ${affiliateLoadUnits({ ...typicalLoad, codes: 5 })} with codes; at $${laterPageCost().toFixed(6)} a request`);
  console.log(`a store's map: ${sitemapUnits({ listings: 0, carried: 20, postPages: 1 })} requests for 20 products and 12 posts ($${sitemapRead({ listings: 0, carried: 20, postPages: 1 }).toFixed(6)}), ${sitemapUnits({ listings: MAX_PRODUCTS - 50, carried: 50, postPages: MAX_POST_PAGES })} at the largest ($${sitemapRead({ listings: MAX_PRODUCTS - 50, carried: 50, postPages: MAX_POST_PAGES }).toFixed(6)})`);
  // An opening of a buyer's orders page is ORDERS_OPEN_UNITS public requests before anything is read: more than its time, its fixed reads and
  // its page cost, with ORDERS_SPARE (a tenth) to spare, the page measured as it is sent (C3-80, C3-83); and each request its meter takes
  // pays for ORDERS_UNIT_COMMANDS commands, a listing counted as ORDERS_LISTING_COMMANDS.
  assert.ok(ORDERS_OPEN_UNITS * laterPageCost() >= ORDERS_SPARE * ORDERS_OPEN_READ, `${ORDERS_OPEN_UNITS} x ${laterPageCost()} < ${ORDERS_SPARE} x ${ORDERS_OPEN_READ}`);
  // And no more units than that needs (C3-83: not raised past what is needed).
  assert.ok((ORDERS_OPEN_UNITS - 1) * laterPageCost() < ORDERS_SPARE * ORDERS_OPEN_READ, `${ORDERS_OPEN_UNITS} units, one more than needed`);
  assert.ok(laterPageCost() >= ORDERS_UNIT_COMMANDS * ORDERS_METERED_COMMAND, `${laterPageCost()} < ${ORDERS_UNIT_COMMANDS} x ${ORDERS_METERED_COMMAND}`);
  assert.ok(ORDERS_LISTING_COMMANDS * ORDERS_METERED_COMMAND >= ORDERS_METERED_LISTING, `${ORDERS_LISTING_COMMANDS} x ${ORDERS_METERED_COMMAND} < ${ORDERS_METERED_LISTING}`);
  // A download's lookup of its one purchase is DOWNLOAD_LOOKUP_UNITS public requests, after its grant and before anything else: more than its wait and fixed reads cost.
  assert.ok(DOWNLOAD_LOOKUP_UNITS * laterPageCost() >= DOWNLOAD_LOOKUP_READ, `${DOWNLOAD_LOOKUP_UNITS} x ${laterPageCost()} < ${DOWNLOAD_LOOKUP_READ}`);
  // Showing a bundle's products on that list is ORDERS_BUNDLE_UNITS public requests, after its grant and before anything else: a download's lookup and its answer
  // (the button's, or the page drawn without JavaScript), with the same tenth to spare and no more.
  assert.ok(ORDERS_BUNDLE_UNITS * laterPageCost() >= ORDERS_SPARE * ORDERS_BUNDLE_READ, `${ORDERS_BUNDLE_UNITS} x ${laterPageCost()} < ${ORDERS_SPARE} x ${ORDERS_BUNDLE_READ}`);
  assert.ok((ORDERS_BUNDLE_UNITS - 1) * laterPageCost() < ORDERS_SPARE * ORDERS_BUNDLE_READ, `${ORDERS_BUNDLE_UNITS} units, one more than needed`);
  // Checking a batch of older purchases is ORDERS_OLDER_UNITS public requests, after its grant and before anything else: an opening's time and its answer, the same way.
  assert.ok(ORDERS_OLDER_UNITS * laterPageCost() >= ORDERS_SPARE * ORDERS_OLDER_READ, `${ORDERS_OLDER_UNITS} x ${laterPageCost()} < ${ORDERS_SPARE} x ${ORDERS_OLDER_READ}`);
  assert.ok((ORDERS_OLDER_UNITS - 1) * laterPageCost() < ORDERS_SPARE * ORDERS_OLDER_READ, `${ORDERS_OLDER_UNITS} units, one more than needed`);
  console.log(`a bundle's products: $${ORDERS_BUNDLE_READ.toFixed(6)} at most before its metered reads, counted as ${ORDERS_BUNDLE_UNITS} requests`);
  console.log(`a batch of older purchases: $${ORDERS_OLDER_READ.toFixed(6)} at most before its metered reads, counted as ${ORDERS_OLDER_UNITS} requests`);
  console.log(`a download's lookup of its purchase: $${DOWNLOAD_LOOKUP_READ.toFixed(6)} at most before its metered reads, counted as ${DOWNLOAD_LOOKUP_UNITS} requests at $${laterPageCost().toFixed(6)}`);
  // A read of a hundred bookings' moves, one MGET with its keys and moves (C3-82): counted as ORDERS_MOVES_READ_COMMANDS, above what it
  // costs; a hundred at a command, as readMoves reads them; and the most taken before the bookings are read covers five pages of them.
  assert.ok(ORDERS_MOVES_READ_COMMANDS * ORDERS_METERED_COMMAND >= ORDERS_METERED_MOVES, `${ORDERS_MOVES_READ_COMMANDS} x ${ORDERS_METERED_COMMAND} < ${ORDERS_METERED_MOVES}`);
  assert.ok(read("lib/call-records.ts").includes(`const perRead = ${MOVES_PER_MGET};`), "readMoves reads MOVES_PER_MGET moves at a command");
  assert.deepEqual([moveReads(0), moveReads(1), moveReads(100), moveReads(101), moveReads(500), moveReads(Number.NaN)], [0, 1, 1, 2, 5, Number.POSITIVE_INFINITY]);
  assert.deepEqual([ordersMovesCommands(40), ordersMovesCommands(500), ORDERS_CALL_MOVES], [2, 10, 10]);
  console.log(`an opening of the orders page: $${ORDERS_OPEN_READ.toFixed(6)} at most before its metered reads, counted as ${ORDERS_OPEN_UNITS} requests at $${laterPageCost().toFixed(6)}; ${ORDERS_UNIT_COMMANDS} metered commands a request`);
  // Marktmorgen Path's reading of a store's money and counts is PATH_READ_UNITS studio requests: more than its reads and its Stripe pages cost.
  assert.ok(PATH_READ_UNITS * UNIT_COST.studio >= PATH_READ, `${PATH_READ_UNITS} x ${UNIT_COST.studio} < ${PATH_READ}`);
  // Making a store's count of its tasks again reads every task once, after tasksRecountUnits(people) studio requests are taken:
  // more than four commands and what that many people can keep cost, at a whole studio request's shape (lib/crm.ts).
  for (const people of [1, 3, 49, 50, 51, MAX_STORE_TASKS]) {
    const read = request("studio", 4, Math.min(people * MAX_PERSON_TASKS, MAX_STORE_TASKS) * (TASK_KEPT_BYTES + 64));
    assert.ok(tasksRecountUnits(people) * UNIT_COST.studio >= read, `${people} people: ${tasksRecountUnits(people)} x ${UNIT_COST.studio} < ${read}`);
    assert.ok(tasksRecountUnits(people) <= TASKS_RECOUNT_UNITS);
  }
  assert.ok(TASKS_RECOUNT_UNITS * UNIT_COST.studio >= request("studio", 4, TASKS_RECOUNT_BYTES));
  console.log(`a recount of a store's tasks: ${TASKS_RECOUNT_BYTES} bytes at most, ${TASKS_RECOUNT_UNITS} studio requests at most, once a store`);
  // A buyer action is priced above a webhook's try and a call out: it waits as long, and does more.
  assert.ok(UNIT_COST.buyer >= UNIT_COST.integration && UNIT_COST.buyer >= UNIT_COST.webhook);
});

test("a store that pays nothing has less of everything than a free trial, and the trial's worst window is priced", () => {
  for (const standing of ["none", "ended"] as const) for (const kind of ALLOWANCE_KINDS) assert.ok(NON_PAYING_ALLOWANCES[standing][kind] <= NON_PAYING_ALLOWANCES.trial[kind], `${standing} ${kind}`);
  assert.ok(SETUP_VISITS <= TRIAL_VISITS && SETUP_EXTRA_REQUESTS <= TRIAL_EXTRA_REQUESTS);
  for (const kind of ALLOWANCE_KINDS) assert.ok(NON_PAYING_ALLOWANCES.trial[kind] <= STORE_ALLOWANCES.creator[kind], `a trial has no more ${kind} than Store`);
  const worst = nonPayingWorst();
  assert.ok(Number.isFinite(worst) && worst > 0);
  console.log(`a store that pays nothing, worst window: $${worst.toFixed(4)}`);
});

test("the billing period and every figure the owner named on October 17, 2026 have left the open list", () => {
  const open = new Set(OPEN.map((item) => item.id));
  for (const id of ["billing-period", "public-requests", "studio-requests", "transactional-email", "rest-api", "inbox", "creator-email", "integrations", "calls", "free-and-trial"]) assert.ok(!open.has(id), id);
  for (const id of ["public-requests", "studio", "transactional-email", "store-email", "rest-api", "inbox", "integrations", "free-share"]) assert.ok(ids.has(id), id);
});

test("the uses the owner named on October 18, 2026 have left the open list, the database's bytes too, and it stays empty", () => {
  const open = OPEN.map((item) => item.id);
  for (const id of ["buyer-actions", "group-places", "webhooks", "retained-files", "database-storage"]) assert.ok(!open.includes(id), id);
  for (const id of ["buyer-actions", "webhooks", "task-files", "community-pictures", "database-storage"]) assert.ok(ids.has(id), id);
  assert.ok(PER_PAYMENT_LINES.some((line) => line.id === "retained-files"));
  assert.ok(PER_PAYMENT_LINES.some((line) => line.id === "retained-data"));
  // Nothing may join it: a new per-use cost gets a figure enforced in code and a line here, never an open item.
  assert.deepEqual(open, [], "the open list is empty and stays so");
  // No scope of a counter may point at an open item any more.
  for (const [scope, kind] of Object.entries(SCOPES)) assert.ok(!("open" in kind), `${scope} is still open`);
});

test("Path page and its actual usage count fit its reserved studio page", () => {
 assert.ok(PATH_PAGE <= UNIT_COST.studio * STUDIO_PAGE_UNITS);
});

test("a reading of the buyers from Stripe fits the studio requests counted before it, and no fewer would do", () => {
 assert.ok(BUYER_LEDGER <= UNIT_COST.studio * BUYER_LEDGER_UNITS, `${BUYER_LEDGER} > ${BUYER_LEDGER_UNITS} x ${UNIT_COST.studio}`);
 assert.ok(BUYER_LEDGER > UNIT_COST.studio * (BUYER_LEDGER_UNITS - 1), `${BUYER_LEDGER} <= ${BUYER_LEDGER_UNITS - 1} x ${UNIT_COST.studio}: lower BUYER_LEDGER_UNITS`);
});

test("what the buyers' copy and the imported buyers weigh is counted a studio request a megabyte, and never left out", () => {
 // A megabyte through the database and parsed, at a light request's shape, fits in one studio request.
 assert.ok(request("light", 2, LEDGER_BYTES_PER_UNIT) <= UNIT_COST.studio, `${request("light", 2, LEDGER_BYTES_PER_UNIT)} > ${UNIT_COST.studio}`);
 // The imported buyers are read and written again in the copy: twice their address and date.
 assert.ok(IMPORTED_BUYER_BYTES >= 2 * (254 + 10), "an imported buyer is read and written in the copy: never priced as less");
 // BUYER_LEDGER prices Stripe's pages and rows only; the imported are counted by size, so the source must count them.
 const source = read("lib/segments.ts");
 assert.ok(source.includes('["HLEN", importedWhoKey(store.statsId)]') && source.includes("const paypal = readsSales(store) ? await paypalKept(store.statsId, Boolean(store.paypalSeller)) : { sales: 0, refunds: 0 };") && !source.includes("store.paypalSeller ? await paypalKept") && source.includes("ledgerUnits(moved, included)") && source.indexOf("HLEN") < source.indexOf("await importedBuyers(store.statsId)"), "the imported buyers and PayPal's sales are counted before they are read");
 assert.ok(source.includes('["STRLEN", ledgerKey(store.statsId)]') && source.indexOf("STRLEN") < source.indexOf('["GETRANGE", ledgerKey(store.statsId)'), "the copy is measured and counted before it is read, and read no further");
 // PayPal's reading is counted in full (round 5, H1): what ledgerReadBytes counts for the most PayPal kept covers PAYPAL_LEDGER.
 const paypalUnits = ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: Number.MAX_SAFE_INTEGER, paypalRefunds: Number.MAX_SAFE_INTEGER }));
 assert.ok(PAYPAL_LEDGER <= UNIT_COST.studio * paypalUnits, `${PAYPAL_LEDGER} > ${paypalUnits} x ${UNIT_COST.studio}`);
 assert.ok(ledgerReadBytes({ imported: 0, paypalSales: 3_000, paypalRefunds: 500 }) >= PAYPAL_LEDGER_BYTES, "every PayPal record read is counted");
});

test("an affiliate change in bulk is paid a studio request for each share of its commands and bytes (lib/affiliates.ts bulkUnits)", () => {
 // Each more studio request covers STUDIO_UNIT_COMMANDS commands, or STUDIO_UNIT_BYTES bytes, at a light request's shape.
 assert.ok(request("light", STUDIO_UNIT_COMMANDS, 0) <= UNIT_COST.studio, `${request("light", STUDIO_UNIT_COMMANDS, 0)} > ${UNIT_COST.studio}`);
 assert.ok(request("light", 0, STUDIO_UNIT_BYTES) <= UNIT_COST.studio, `${request("light", 0, STUDIO_UNIT_BYTES)} > ${UNIT_COST.studio}`);
 // Accepting a partnership by its emailed link pays the same units from the store's public requests (lib/affiliates.ts
 // paidPeople, app/api/store/affiliates/open/route.ts), each priced as a later page: each covers as much.
 assert.ok(request("light", STUDIO_UNIT_COMMANDS, 0) <= laterPageCost(), `${request("light", STUDIO_UNIT_COMMANDS, 0)} > ${laterPageCost()}`);
 assert.ok(request("light", 0, STUDIO_UNIT_BYTES) <= laterPageCost(), `${request("light", 0, STUDIO_UNIT_BYTES)} > ${laterPageCost()}`);
 // The shares add up: any mix of commands and bytes is inside what bulkUnits takes for it.
 for (const [commands, bytes] of [[1, 0], [400, 0], [0, 24_000_000], [325, 641_246], [1_107, 45_760_958], [17, 999_999]] as const) {
  assert.ok(request("light", commands, bytes) <= UNIT_COST.studio * bulkUnits(commands, bytes), `${commands} commands, ${bytes} bytes`);
 }
});

test("a scheduled email's readings of the buyers are each paid in studio requests before they are read (scheduled-reads)", () => {
 assert.equal(SCHEDULED_READS.id, "scheduled-reads");
 assert.ok(SCHEDULED_READS.each <= UNIT_COST.studio * BUYER_LEDGER_UNITS, `${SCHEDULED_READS.each} > ${BUYER_LEDGER_UNITS} x ${UNIT_COST.studio}`);
 const source = read("lib/broadcasts.ts").replace(/\s+/g, " ");
 // The only reading of the buyers in the scheduled job goes through the draw, which holds or takes before it says yes.
 assert.deepEqual(source.match(/keepFor\([^)]*\)/g), ["keepFor(store, narrow, count)", "keepFor(store, b.narrow, draw)"], "every reading of the buyers in lib/broadcasts.ts is counted");
 assert.ok(source.includes('const taken = await takeAllowance(current, "studio", rest, now * 1000)') && source.includes("return true;") && !source.includes("over += units"), "what the hold does not cover is taken from the month it is read in, never read over it");
 assert.ok(source.includes('await holdAllowanceAt(await refreshPeriod(store), "studio", units, sendAt * 1000)'), "the hold is taken from the month it goes out");
 // A subject test decided by sales reads TEST_SALES_PAGES pages of sales, paid as a reading of every sale (ALL_TIME_PAGES of them) first.
 assert.ok(TEST_SALES_PAGES <= ALL_TIME_PAGES, `${TEST_SALES_PAGES} > ${ALL_TIME_PAGES}`);
});

test("the tasks agenda at its most fits the studio requests it counts", () => {
 assert.ok(AGENDA_READ <= UNIT_COST.studio * AGENDA_UNITS, `${AGENDA_READ} > ${AGENDA_UNITS} x ${UNIT_COST.studio}`);
 // AGENDA_UNITS is what agendaReadUnits and the rows' size count at the most (lib/person-agenda.ts): never less than the cost.
});

test("the buyers page spends the fifty kilobytes its own request moves once, whatever its parts (C3-112 (2))", () => {
 // UNIT_COST.studio prices one request moving PAGE_INCLUDED_BYTES, no more.
 assert.equal(request("studio", 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, PAGE_INCLUDED_BYTES), UNIT_COST.studio);
 assert.ok(LEDGER_BYTES_PER_UNIT === STUDIO_UNIT_SENT_BYTES && request("light", 2, STUDIO_UNIT_SENT_BYTES) <= UNIT_COST.studio, "a studio request counted past the included bytes covers its megabyte");
 // The page at its worst: a task's person looked up (?who=) and not there, so the agenda is drawn below; every part
 // that reads or sends by size at the most it moved without a request of its own before: the lookup's copy of the
 // buyers and its reading of the imported and PayPal ones, the agenda's tasks (as many people as fit), its own copy
 // and reading, and what it sends on.
 const people = Math.floor(PAGE_INCLUDED_BYTES / (MAX_PERSON_TASKS * MAX_TASK_RECORD_BYTES));
 const taskBytes = people * MAX_PERSON_TASKS * MAX_TASK_RECORD_BYTES;
 const included = new IncludedBytes();
 const parts = [
  ledgerUnits(PAGE_INCLUDED_BYTES, included),
  ledgerUnits(PAGE_INCLUDED_BYTES, included),
  agendaReadUnits(people, included),
  ledgerUnits(PAGE_INCLUDED_BYTES, included),
  ledgerUnits(PAGE_INCLUDED_BYTES, included),
  sentUnits(PAGE_INCLUDED_BYTES, included),
 ];
 const bytes = 5 * PAGE_INCLUDED_BYTES + taskBytes;
 const units = parts.reduce((a, b) => a + b, 0);
 assert.deepEqual(parts, [0, 1, 1, 1, 1, 1], "the first part rides on the page's own request; every later one is counted");
 // Every byte past the request's own fifty kilobytes is covered by a studio request counted for it, and the
 // whole page fits in its own request and those counted.
 assert.ok(bytes - PAGE_INCLUDED_BYTES <= units * LEDGER_BYTES_PER_UNIT, `${bytes} bytes, ${units} counted`);
 assert.ok(request("studio", 20 + TAKE_COMMANDS, bytes) <= UNIT_COST.studio * (1 + units), `${request("studio", 20 + TAKE_COMMANDS, bytes)} > ${1 + units} x ${UNIT_COST.studio}`);
 // Any parts in any order: what rides free never passes PAGE_INCLUDED_BYTES, and no part counts less than alone.
 let seed = 7;
 const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
 for (let round = 0; round < 500; round++) {
  const page = new IncludedBytes();
  let free = 0;
  for (let part = 0; part < 1 + (next() % 7); part++) {
   const size = next() % (next() % 2 ? 60_000 : 2_500_000);
   const shared = page.take(size, LEDGER_BYTES_PER_UNIT);
   const alone = new IncludedBytes().take(size, LEDGER_BYTES_PER_UNIT);
   assert.ok(shared.units >= alone.units && shared.covers >= size, `${size}: ${shared.units} < ${alone.units}`);
   if (shared.units === 0) free += size;
  }
  assert.ok(free <= PAGE_INCLUDED_BYTES && page.left === PAGE_INCLUDED_BYTES - free, `${free} bytes rode free`);
 }
 // An unknown size is never none.
 for (const size of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) assert.throws(() => new IncludedBytes().take(size, LEDGER_BYTES_PER_UNIT), RangeError);
 // The page makes one and hands it to every part; each reading passes it on.
 const page = read("app/studio/people/page.tsx").replace(/\s+/g, " ");
 assert.equal(page.match(/new IncludedBytes\(\)/g)?.length, 1, "one budget for the page");
 assert.ok(page.includes("addressForPerson(store, who, lookupLedger.count, included)") && page.includes("<TasksAgenda store={store} included={included} />") && page.includes("agendaData(store, today, included)"), "the lookup and the agenda draw on the page's budget");
 const agenda = read("lib/person-agenda-read.ts");
 assert.ok(agenda.includes("agendaReadUnits(kept, included)") && agenda.includes("personAddresses(store, persons, ledger.count, included)") && agenda.includes("AGENDA_ROW_MARKUP_BYTES, included)"), "the agenda's tasks, buyers and sending draw on it");
 assert.ok(read("lib/person-agenda.ts").includes("buyerLedger(store, count, included)") && read("lib/person-agenda.ts").includes("personAddresses(store, new Set([person]), count, included)"), "the lookup passes it to the buyers' reading");
 const ledger = read("lib/segments.ts");
 assert.ok(ledger.includes("included.take(bytes, LEDGER_BYTES_PER_UNIT)") && ledger.includes('["GETRANGE", ledgerKey(store.statsId), 0, taken.covers - 1]') && ledger.includes("ledgerUnits(moved, included)"), "the copy and the rest of a reading draw on it, and the copy is read no further than counted");
});

test("Path push fits its reserved studio requests", () => {
 assert.ok(PATH_REMINDER_PUSH <= UNIT_COST.studio * PATH_REMINDER_UNITS);
});

test("studio Path invitation fits the same reserved page with one bounded record read", () => {
 assert.ok(PATH_STUDIO_PAGE <= UNIT_COST.studio * STUDIO_PAGE_UNITS);
});

test("board join and essential privacy fit their pre-reserved requests",()=>{
 assert.ok(PATH_BOARD_JOIN<=UNIT_COST.studio*PATH_BOARD_JOIN_UNITS);
 assert.ok(PATH_BOARD_PRIVACY<=request("heavy",40,200_000));
});

test("bounded post-sale evidence fits its separately reserved studio requests",()=>{
 assert.ok(PATH_GROWTH_READ<=PATH_GROWTH_READ_UNITS*UNIT_COST.studio);
 const source=read("lib/path-growth-facts.ts");
 assert.ok(source.indexOf("await charge(PATH_GROWTH_READ_UNITS)")<source.indexOf("readProductsStrict(store,ids)"));
});

test("an API reading that reads more than a page takes further requests that cover it, at every size, before it reads", () => {
  const work = (w: Partial<ReadWork>): ReadWork => ({ commands: 0, bytes: 0, sent: 0, stripePages: 0, roundTrips: 0, ...w });
  // Each thing one further request pays for, alone, costs no more than a request.
  for (const one of [{ commands: API_UNIT_COMMANDS }, { bytes: API_UNIT_BYTES }, { sent: API_UNIT_SENT_BYTES }, { stripePages: API_UNIT_STRIPE_PAGES }, { roundTrips: API_UNIT_ROUND_TRIPS }]) {
    assert.ok(apiReadCost(work(one)) <= UNIT_COST.api, `${JSON.stringify(one)}: ${apiReadCost(work(one))} > ${UNIT_COST.api}`);
  }
  assert.equal(MORE_TAKE_COMMANDS, TAKE_COMMANDS);
  assert.ok(ROUND_TRIP_SECONDS >= 0.25);
  const covers = (w: ReadWork, what: string) => {
    const units = apiReadUnits(w);
    // Taking them is counted too: its commands, the one that gives them back, and its trips to the database.
    const cost = apiReadCost(units > 0 ? withTaking(w) : w);
    assert.ok(units === 0 || (withTaking(w).commands === w.commands + MORE_TAKE_COMMANDS + 1 && withTaking(w).roundTrips >= w.roundTrips + 2), `${what}: taking is priced`);
    assert.ok(Number.isSafeInteger(units) && units * UNIT_COST.api >= cost, `${what}: ${units} x ${UNIT_COST.api} < ${cost}`);
    if (apiReadCost(w) > 0) assert.ok(units >= 1, `${what} costs something and takes nothing`);
  };
  // A course's page: every count of students a page can hold and more (HSCAN's COUNT is a hint), whatever is blocked.
  for (let rows = 0; rows <= 2_000; rows += 1) for (const blocked of [0, 1, 199, 200, 201, 50_000]) covers(studentsPageWork(rows, blocked), `students ${rows}/${blocked}`);
  // The affiliate program at every size, with and without Stripe, PayPal refunds, leads and products.
  for (const entries of [0, 1, 7, 100, 1_000, 10_000, 100_000, 1_000_000]) {
    for (const share of [0, 0.1, 1]) {
      const people = Math.floor(entries * share);
      for (const leads of [0, 50, 200, 5_000]) for (const paypalRefunds of [0, 3, 500, 20_000]) for (const products of [0, 10, 2_000]) for (const stripe of [false, true]) {
        const sizes: BookSizes = { kept: true, entries, people, leads: Math.min(leads, entries), paypalRefunds, stripe, products };
        covers(bookWork(sizes, BOOK_STRIPE_PAGES), `affiliates ${JSON.stringify(sizes)}`);
      }
    }
  }
  assert.equal(apiReadUnits(bookWork({ kept: false, entries: 0, people: 0, leads: 0, paypalRefunds: 0, stripe: true, products: 9 }, BOOK_STRIPE_PAGES)), 0);
  // Shares that are not whole: just under, at and just over each whole number, in every figure and mixed, and a seeded spread.
  const caps: [keyof ReadWork, number][] = [["commands", API_UNIT_COMMANDS], ["bytes", API_UNIT_BYTES], ["sent", API_UNIT_SENT_BYTES], ["stripePages", API_UNIT_STRIPE_PAGES], ["roundTrips", API_UNIT_ROUND_TRIPS]];
  for (const [field, cap] of caps) for (const whole of [1, 2, 7, 40]) for (const off of [-1e-6, -0.01, -0.3, 0, 1e-9, 0.01, 0.3]) {
    const amount = cap * (whole + off);
    covers(work({ [field]: amount }), `${field} ${whole}${off >= 0 ? "+" : ""}${off}`);
  }
  let seed = 7;
  const next = () => ((seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647);
  for (let i = 0; i < 5_000; i += 1) {
    covers(work({ commands: next() * 3 * API_UNIT_COMMANDS, bytes: next() * 2 * API_UNIT_BYTES, sent: next() * API_UNIT_SENT_BYTES, stripePages: next() * 2 * API_UNIT_STRIPE_PAGES, roundTrips: next() * API_UNIT_ROUND_TRIPS }), `mixed ${i}`);
  }
  // Every other reading past the door, at every size its counts allow (each priced at its most where it cannot be counted first).
  for (const kept of [false, true]) for (const sales of [false, true]) for (const stripe of [false, true])
    for (const paypalSales of [0, 7, 2_000, 50_000]) for (const paypalRefunds of [0, 3, 500, 9_000]) covers(numbersWork({ kept, sales, stripe, paypalSales, paypalRefunds }), `numbers ${kept}/${sales}/${stripe}/${paypalSales}/${paypalRefunds}`);
  for (let read = 0; read <= 2_000; read += 1) covers(listingsWork(read), `listings ${read}`);
  for (let listed = 0; listed <= 210; listed += 1) for (const share of [0, 0.5, 1]) covers(productsPageWork(listed, Math.floor(listed * share)), `products ${listed}`);
  for (const commands of [1, 2]) for (const readBytes of [0, 1, 99_999, 1_000_000, 12_345_678]) for (const sent of [0, 2, 500_001, 9_000_000]) covers(scannedPageWork(commands, readBytes, sent), `page ${commands}/${readBytes}/${sent}`);
  for (const kept of [0, 1, 256_000, 600_000]) covers(membershipsWork(kept), `memberships ${kept}`);
  covers(addWork(membershipsWork(0), MEMBERSHIPS_COLD_WORK), "memberships not kept, in one go");
  covers(MEMBERSHIPS_COLD_WORK, "memberships not kept");
  for (const broadcasts of [0, 1, EMAILS_BROADCASTS]) for (const bytes of [0, 70_000, 2_000_000]) for (const flowBytes of [0, 5_000, 30_000_000]) for (const revenueBytes of [0, 1, 64_000, 172_000, 3_000_000]) {
    const emails = addWork(EMAILS_PROBE_WORK, emailsWork({ broadcasts, broadcastBytes: bytes, flowBytes, revenueBytes }));
    covers(emails, `emails ${broadcasts}/${bytes}/${flowBytes}/${revenueBytes}`);
    for (const paypal of [0, 1_000, 40_000]) covers(addWork(emails, mailRevenueColdWork(paypal, revenueBytes)), `emails and what they sold, in one go ${paypal}/${revenueBytes}`);
  }
  for (const paypal of [0, 9, 1_000, 40_000]) for (const kept of [undefined, 1, 172_000, 3_000_000]) covers(mailRevenueColdWork(paypal, kept), `what the emails sold ${paypal}/${kept}`);
  // The numbers kept an hour: read anew with their keeping, and from the copy at every size it can have.
  for (const paypalSales of [0, 2_000, 50_000]) for (const paypalRefunds of [0, 500, 9_000]) covers(addWork(numbersWork({ kept: true, sales: true, stripe: true, paypalSales, paypalRefunds }), NUMBERS_KEEP_WORK), `numbers kept ${paypalSales}/${paypalRefunds}`);
  for (const bytes of [1, 999, 50_000, 400_000, NUMBERS_KEPT_BYTES + 64]) for (const sent of [0, 2, 30_000, NUMBERS_SENT_BYTES, 3_000_000]) covers(keptNumbersWork(bytes, sent), `numbers from the copy ${bytes}/${sent}`);
  // A page of the list or the members at its most, and what buyers bought next with its cards.
  for (const list of ["leads", "members"] as const) for (let rows = 0; rows <= API_PAGE_ROWS; rows += 25) covers(listPageMost(list, rows), `${list} page at its most ${rows}`);
  for (const paths of [0, 28, 5_000, 262_144]) for (const sent of [0, 1_200, undefined]) covers(boughtNextWork(paths, sent), `bought next ${paths}/${sent}`);
  // Settled: never under what was measured, one more when it passes what was set aside.
  for (const held of [0, 3, 13]) for (const bytes of [0, 4_000_000, 9_000_000]) {
    const w = scannedPageWork(1, bytes, bytes);
    assert.equal(settledUnits(w, held), apiReadUnits(w) > held ? apiReadUnits(w) + 1 : apiReadUnits(w));
  }
  covers(eventsWork(), "events at their most");
  // The recent events at every size they can be measured at: up to LOG_SIZE deliveries, each up to DELIVERY_MAX_BYTES.
  for (const deliveries of [0, 1, 7, LOG_SIZE]) for (const each of [0, 300, 31_267, DELIVERY_MAX_BYTES]) for (const sentShare of [0, 0.2, 1]) {
    const bytes = deliveries * (LOG_ENTRY_BYTES + each);
    covers(eventsWork({ deliveries, bytes, sent: Math.floor(bytes * sentShare) }), `events ${deliveries}/${each}/${sentShare}`);
  }
  assert.equal(eventsSentMost([5, 900, 31_267, 12], 2), 31_267 + 1 + 900 + 1, "what may be sent: the largest deliveries asked for, a comma each");
  assert.ok(apiReadUnits(eventsWork()) >= apiReadUnits(eventsWork({ deliveries: LOG_SIZE, bytes: LOG_SIZE * (LOG_ENTRY_BYTES + DELIVERY_MAX_BYTES), sent: eventsSentMost(Array(LOG_SIZE).fill(DELIVERY_MAX_BYTES), RECENT_MESSAGES_MAX) })), "the most holds every measured reading");
  covers(codesWork(), "codes");
  covers(codeMakeWork(), "making a code");
  covers(codeStopWork(), "switching a code off");
  // The bookings at their most; nothing without Stripe.
  covers(bookingsWork(true), "bookings");
  // Their moves read a hundred at an MGET (C3-82): five commands, not five hundred, so the request and five more, not thirty.
  assert.equal(bookingsWork(true).commands, 5);
  assert.equal(1 + apiReadUnits(bookingsWork(true)), 6);
  assert.equal(apiReadUnits(bookingsWork(false)), 0);
  // A size that could not be read is never priced low.
  assert.equal(apiReadUnits({ commands: Number.NaN }), Number.POSITIVE_INFINITY);
  assert.equal(apiReadUnits({ bytes: -1 }), Number.POSITIVE_INFINITY);

  // The sizes priced are the code's own.
  const calls = read("lib/calls.ts");
  assert.ok(calls.includes(`const MAX_PAGES = ${BOOKING_PAGES};`) && calls.includes("/checkout/sessions?limit=100"), "the bookings' pages");
  const paypal = read("lib/paypal-sales.ts");
  assert.ok(
    (paypal.includes(`"LIMIT", "0", "${BOOK_PAYPAL_REFUNDS + 1}"`) && paypal.includes(`Math.min(flat.length, ${BOOK_PAYPAL_REFUNDS * 2})`))
      || (paypal.includes(`PAYPAL_REFUNDS_READ = ${BOOK_PAYPAL_REFUNDS};`) && paypal.includes('"LIMIT", "0", String(PAYPAL_REFUNDS_READ + 1)') && paypal.includes("Math.min(flat.length, 2 * PAYPAL_REFUNDS_READ)")),
    "PayPal refunds read",
  );
  const book = read("lib/affiliates.ts");
  assert.ok(book.includes(`.slice(0, ${BOOK_MOVES})`) && book.includes(`const INVOICE_PAGES = ${BOOK_INVOICES / 100};`) && book.includes('limit: "100"'), "the book's moves and invoices");
  assert.ok(BOOK_STRIPE_PAGES >= BOOK_INVOICES / 100);
  const stats = read("lib/stats.ts");
  assert.ok(stats.includes(`readPaidSales(store, sinceBefore, ${SALES_PAGES})`) && stats.includes(`readRenewals(store, since, now, ${RENEWAL_PAGES})`) && stats.includes(`readRefunds(store, since, ${REFUND_READ_PAGES})`) && stats.includes(`const DISPUTE_PAGES = ${DISPUTE_READ_PAGES};`), "the numbers' pages");
  assert.equal(stats.match(/= walk\("/g)?.length, 2, "the sales are two lists of pages");
  assert.ok(stats.includes("readPayPalSales(store.statsId, since, pages * 100)"), "PayPal sales a hundred a page");
  assert.ok(read("lib/membership-numbers.ts").includes(`const MAX_PAGES = ${MEMBERSHIP_PAGES / 2};`), "the memberships' pages");
  assert.ok(read("lib/mail-revenue.ts").includes(`const PAGES = ${MAIL_REVENUE_PAGES / 2};`), "what the emails sold, its pages");

  // Each takes them before it reads.
  const before = (file: string, first: string, then: string) => {
    const source = read(file);
    const at = source.indexOf(first);
    assert.ok(at >= 0 && source.indexOf(then, at) > at, `${file}: ${first} before ${then}`);
  };
  before("lib/learn.ts", "if (!(await allow(rows.length, blockedAll))) return null;", '["SMEMBERS", doneKey(course.id, row.e)]');
  before("lib/api-read.ts", "said.refused = await charge(apiReadUnits(studentsPageWork(rows, blocked)));", "data: page.students.map");
  before("lib/api-read.ts", "const refused = await chargeBook(store, charge);", "const book = await readBook(store);");
  before("lib/api-read.ts", "const refused = await charge(apiReadUnits(bookingsWork(Boolean(store.stripeAccountId))));", "const rows = await paidCalls(store);");
  before("lib/mcp-tools.ts", "const refused = await chargeBook(store, charge);", "const book = await readBook(store);");
  before("lib/api-read.ts", "const refused = await charge(apiReadUnits(productsPageWork(", "const slice = await readListings(store, page);");
  before("lib/mcp-tools.ts", "const refused = charge ? await charge(apiReadUnits(listingsWork(", "const listings = await readListings(store, named)");
  before("lib/mcp-tools.ts", "const first = await charge(units);", "membershipNumbersPaid(store");
  before("lib/mcp-tools.ts", "membershipNumbersPaid(store", "await titlesFor(store, n.byProduct");
  before("lib/mcp-tools.ts", "if (charge && (await charge(apiReadUnits(listingsWork(listingsToRead(store, missing))), taken)))", "await readListings(store, missing)");
  before("lib/membership-numbers.ts", 'if (beforeStripe && !(await beforeStripe())) return "refused";', "/subscriptions?");
  before("lib/mcp-tools.ts", "const settle = await meter.hold(held);", "listBroadcasts(store.listId, EMAILS_BROADCASTS)");
  before("lib/mcp-tools.ts", "said.refused = await meter.charge(said.second, held);", "const refused = await settle(due);");
  before("lib/mcp-tools.ts", "const refused = await settle(due);", "currency: store.currency,");
  before("lib/mcp-tools.ts", "const held = await meter.hold(most);", "await readPaths(store.statsId)");
  before("lib/api-read.ts", "const settle = await hold(held);", "const { out, work } = await read();");
  before("lib/api-read.ts", "return scannedPage(hold, listPageMost(\"leads\", API_PAGE)", "await scanLeads(store, cursor, onlyAgreed)");
  before("lib/api-read.ts", "return scannedPage(hold, listPageMost(\"members\", API_PAGE)", "await memberPage(id, start, API_PAGE)");
  before("lib/api-numbers.ts", "const settle = await hold(most);", '["GET", key]');
  before("lib/api-numbers.ts", "const refused = await charge(units, taken);", "await readNumbers(store, now)");
  assert.ok(!read("lib/mcp-tools.ts").includes("readTitles("), "the MCP tools never read every card, nor the listings' fall-back that reads every product");
  assert.ok(read("docs/zapier-app.md").includes(`counts as ${1 + apiReadUnits(eventsWork({ deliveries: 0, bytes: 0, sent: 0 }))} to ${1 + apiReadUnits(eventsWork())} (\`1 + apiReadUnits(eventsWork())\` at the most, for`), "the Zapier notes say what a sample of events counts as");
  before("lib/mail-revenue.ts", 'if (beforeStripe && !(await beforeStripe())) return "refused";', "readPaidSales(store, since, PAGES)");
  before("app/api/v1/stats/route.ts", "const read = await apiNumbers(store,", "summaryOf(read.data");
  before("app/api/v1/stats/route.ts", "const refused = await read.settle(", "apiOk(body)");
  before("app/api/v1/events/route.ts", "await recentEvents(store, type, limit, (most) => holdMoreApi(store, most));", "apiOk({ data: found })");
  // The measuring paid for before it is done, the rest before any delivery is read, all settled before anything is sent (Codex G2, #2192).
  before("lib/api-read.ts", "const settleProbe = await hold(probeHeld);", "const sized = await recentDeliverySizes(store);");
  before("lib/api-read.ts", "const sized = await recentDeliverySizes(store);", "const settleRest = await hold(restHeld);");
  before("lib/api-read.ts", "const settleRest = await hold(restHeld);", "await recentMessagesOf(store, type, sized.ids, bounds, most);");
  before("lib/api-read.ts", "await recentMessagesOf(store, type, sized.ids, bounds, most);", "const refused = await settleRest(");
  assert.ok(apiReadUnits(eventsWork()) >= apiReadUnits(EVENTS_PROBE_MOST), "the most a reading of events takes holds its measuring");
  before("app/api/v1/codes/route.ts", "const refused = await takeMoreApi(store, apiReadUnits(codesWork()));", "listCodes(");
  before("app/api/v1/codes/route.ts", "const refused = await takeMoreApi(store, apiReadUnits(codeMakeWork()));", "createCode(");
  before("app/api/v1/codes/route.ts", "const refused = await takeMoreApi(store, apiReadUnits(codeStopWork()));", "const before = await listCodes(account);");
  before("app/api/mcp/route.ts", "const read = await apiNumbers(store,", "await tool(read.data)");
  before("app/api/mcp/route.ts", "const refused = await read.settle(", "result(id, answer)");
  // Every GET of the API and every MCP tool past the door takes what it reads; only the store's own record fits in its request.
  const v1 = readdirSync(join(root, "app/api/v1")).filter((d) => existsSync(join(root, "app/api/v1", d, "route.ts")));
  for (const dir of v1) {
    const route = read(`app/api/v1/${dir}/route.ts`);
    if (!route.includes("export async function GET") || dir === "store") continue;
    assert.ok(route.includes("takeMoreApi(store") || route.includes("holdMoreApi(store"), `app/api/v1/${dir}: a GET past the door takes what it reads`);
  }
  const mcp = read("app/api/mcp/route.ts");
  for (const call of ["membershipsTool(store, charge)", "emailsTool(store, { charge, hold })", "affiliatesTool(store, charge)", "products(store, cursor, charge)", "productsTool(store, data, days, { hold, charge })", "apiNumbers(store, "]) assert.ok(mcp.includes(call), call);
  const page = apiReadUnits(studentsPageWork(200, 0));
  console.log(`API readings: a page of 200 students takes ${page} more, the bookings ${apiReadUnits(bookingsWork(true))} more, an empty program ${apiReadUnits(bookWork({ kept: true, entries: 0, people: 0, leads: 0, paypalRefunds: 0, stripe: true, products: 0 }, BOOK_STRIPE_PAGES))} more`);
});
