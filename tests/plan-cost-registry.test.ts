import { PATH_GROWTH_READ_UNITS } from "@/lib/path-growth-facts";
import { PATH_GROWTH_READ } from "./plan-cost-registry";
import { ROUND_TRIP_SECONDS, TAKE_COMMANDS, apiReadCost } from "./plan-cost-registry";
import {
  API_UNIT_BYTES, API_UNIT_COMMANDS, API_UNIT_ROUND_TRIPS, API_UNIT_SENT_BYTES, API_UNIT_STRIPE_PAGES, BOOKING_PAGES, BOOK_INVOICES, BOOK_MOVES,
  BOOK_PAYPAL_REFUNDS, MORE_TAKE_COMMANDS, type BookSizes, type ReadWork, apiReadUnits, bookWork, bookingsWork, studentsPageWork, withTaking,
} from "@/lib/api-read-rules";
import { BOOK_STRIPE_PAGES } from "@/lib/affiliates";
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
import { ADD_ON_LINES, ASSIST_REMIND_READ, CERTIFICATE_PDF_READ, PATH_REMINDER_PUSH, PATH_BOARD_JOIN, PATH_BOARD_PRIVACY, PATH_PAGE, PATH_STUDIO_PAGE, PATH_READ, COST_LINES, EMAIL_SITES, KIND_LINES, NEXT_OFFER_READ, NOT_A_COST, OPEN, PER_PAYMENT_LINES, PICTURE_READ, SCOPES, UNIT_COST, nonPayingWorst, request } from "./plan-cost-registry";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { CART_OFFER_REQUEST_UNITS } from "@/lib/cart-offers";
import { ASSIST_REMIND_REQUEST_UNITS } from "@/lib/assistant-reminder-rules";
import { DOWNLOAD_LOOKUP_READ, ORDERS_BUNDLE_READ, ORDERS_OLDER_READ, ORDERS_OPEN_READ, ORDERS_METERED_COMMAND, ORDERS_METERED_LISTING } from "./plan-cost-registry";
import { DOWNLOAD_LOOKUP_UNITS, ORDERS_BUNDLE_UNITS, ORDERS_OLDER_UNITS, ORDERS_LISTING_COMMANDS, ORDERS_OPEN_UNITS, ORDERS_UNIT_COMMANDS } from "@/lib/buyer-orders-rules";

/** What an opening of the orders page, a bundle's products and a batch of older purchases keep above what they cost: a tenth (C3-83, 4 November 2026). */
const ORDERS_SPARE = 1.1;
import { assessCustomerWorstCase } from "@/lib/net-margin-rules";
import { ADD_ON_ROOM_CENTS, assistantMeetsFloor, assistantMonthWorst } from "@/lib/store-assistant-rules";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { laterPageCost } from "./traffic-cost";
import { PICTURE_REQUEST_UNITS } from "@/lib/buyer-actions";
import { CERTIFICATE_PDF_UNITS } from "@/lib/certificate-pdf";
import { ALLOWANCE_KINDS, API_WRITE_UNITS, NON_PAYING_ALLOWANCES, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
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
    // withinServiceWhy is withinService that also says why it refused (lib/metered-limits.ts): the same count.
    for (const m of text.matchAll(/\bwithin(EssentialLimit|Limit|Month|Store|Service)(?:Why)?\(([^,]+),/g)) {
      const literals = [...m[2].matchAll(/"([^"]+)"/g)].map((l) => l[1]);
      if (literals.length) for (const l of literals) { add(l, file); counters.set(l, new Set([...(counters.get(l) ?? []), m[1]])); }
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
  // A booked call is CALL_ORDER_UNITS orders: its confirmation to buyer and host and its two reminders are four emails.
  assert.ok(CALL_ORDER_UNITS * 2 >= 4);
  // A community picture is PICTURE_REQUEST_UNITS public requests, each priced as a later page: more than its megabyte through us costs.
  assert.ok(PICTURE_REQUEST_UNITS * laterPageCost() >= PICTURE_READ, `${PICTURE_REQUEST_UNITS} x ${laterPageCost()} < ${PICTURE_READ}`);
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
  console.log(`an opening of the orders page: $${ORDERS_OPEN_READ.toFixed(6)} at most before its metered reads, counted as ${ORDERS_OPEN_UNITS} requests at $${laterPageCost().toFixed(6)}; ${ORDERS_UNIT_COMMANDS} metered commands a request`);
  // Marktmorgen Path's reading of a store's money and counts is PATH_READ_UNITS studio requests: more than its reads and its Stripe pages cost.
  assert.ok(PATH_READ_UNITS * UNIT_COST.studio >= PATH_READ, `${PATH_READ_UNITS} x ${UNIT_COST.studio} < ${PATH_READ}`);
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
  // The bookings at their most; nothing without Stripe.
  covers(bookingsWork(true), "bookings");
  assert.equal(apiReadUnits(bookingsWork(false)), 0);
  // A size that could not be read is never priced low.
  assert.equal(apiReadUnits({ commands: Number.NaN }), Number.POSITIVE_INFINITY);
  assert.equal(apiReadUnits({ bytes: -1 }), Number.POSITIVE_INFINITY);

  // The sizes priced are the code's own.
  const calls = read("lib/calls.ts");
  assert.ok(calls.includes(`const MAX_PAGES = ${BOOKING_PAGES};`) && calls.includes("/checkout/sessions?limit=100"), "the bookings' pages");
  const paypal = read("lib/paypal-sales.ts");
  assert.ok(paypal.includes(`"LIMIT", "0", "${BOOK_PAYPAL_REFUNDS + 1}"`) && paypal.includes(`Math.min(flat.length, ${BOOK_PAYPAL_REFUNDS * 2})`), "PayPal refunds read");
  const book = read("lib/affiliates.ts");
  assert.ok(book.includes(`.slice(0, ${BOOK_MOVES})`) && book.includes(`const INVOICE_PAGES = ${BOOK_INVOICES / 100};`) && book.includes('limit: "100"'), "the book's moves and invoices");
  assert.ok(BOOK_STRIPE_PAGES >= BOOK_INVOICES / 100);

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
  for (const route of ["app/api/v1/students/route.ts", "app/api/v1/affiliates/route.ts", "app/api/v1/bookings/route.ts", "app/api/mcp/route.ts"]) {
    assert.ok(read(route).includes("(more) => takeMoreApi(store, more)"), `${route} takes them from the store's API requests`);
  }
  const page = apiReadUnits(studentsPageWork(200, 0));
  console.log(`API readings: a page of 200 students takes ${page} more, the bookings ${apiReadUnits(bookingsWork(true))} more, an empty program ${apiReadUnits(bookWork({ kept: true, entries: 0, people: 0, leads: 0, paypalRefunds: 0, stripe: true, products: 0 }, BOOK_STRIPE_PAGES))} more`);
});
