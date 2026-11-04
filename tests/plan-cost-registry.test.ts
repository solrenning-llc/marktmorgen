import { PATH_GROWTH_READ_UNITS } from "@/lib/path-growth-facts";
import { PATH_GROWTH_READ } from "./plan-cost-registry";
import { COMPANIES_PAGE_READ, COMPANIES_REQUEST, STUDIO_UNIT_SENT } from "./plan-cost-registry";
import { COMPANIES_READ_UNITS, COMPANIES_REQUEST_UNITS, COMPANY_MARKUP_BYTES, COMPANY_PERSON_MARKUP_BYTES, MAX_COMPANIES, MAX_COMPANIES_BYTES, MAX_COMPANY_PEOPLE, SENT_TIMES, STUDIO_UNIT_SENT_BYTES, sentBytes } from "@/lib/crm-companies-rules";
import { AGENDA_READ, BUYER_LEDGER } from "./plan-cost-registry";
import { AGENDA_UNITS } from "@/lib/person-agenda";
import { BUYER_LEDGER_UNITS, IMPORTED_BUYER_BYTES, LEDGER_BYTES_PER_UNIT, ledgerReadBytes, ledgerUnits } from "@/lib/segments";
import { PAYPAL_LEDGER, PAYPAL_LEDGER_BYTES } from "./plan-cost-registry";
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
import { ADD_ON_LINES, ASSIST_REMIND_READ, PATH_REMINDER_PUSH, PATH_BOARD_JOIN, PATH_BOARD_PRIVACY, PATH_PAGE, PATH_STUDIO_PAGE, PATH_READ, COST_LINES, EMAIL_SITES, KIND_LINES, NEXT_OFFER_READ, NOT_A_COST, OPEN, PER_PAYMENT_LINES, PICTURE_READ, SCOPES, UNIT_COST, nonPayingWorst, request } from "./plan-cost-registry";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { CART_OFFER_REQUEST_UNITS } from "@/lib/cart-offers";
import { ASSIST_REMIND_REQUEST_UNITS } from "@/lib/assistant-reminder-rules";
import { assessCustomerWorstCase } from "@/lib/net-margin-rules";
import { ADD_ON_ROOM_CENTS, assistantMeetsFloor, assistantMonthWorst } from "@/lib/store-assistant-rules";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { laterPageCost } from "./traffic-cost";
import { PICTURE_REQUEST_UNITS } from "@/lib/buyer-actions";
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
  // The Store assistant's next product after a purchase is NEXT_OFFER_REQUEST_UNITS public requests: more than its reads and Stripe calls cost.
  assert.ok(NEXT_OFFER_REQUEST_UNITS * laterPageCost() >= NEXT_OFFER_READ, `${NEXT_OFFER_REQUEST_UNITS} x ${laterPageCost()} < ${NEXT_OFFER_READ}`);
  console.log(`next product after a purchase: $${NEXT_OFFER_READ.toFixed(6)} at most, counted as ${NEXT_OFFER_REQUEST_UNITS} requests at $${laterPageCost().toFixed(6)}`);
  // The offers after a cart read what the buyer owns with the same reads and Stripe calls (ownedHere), without the model or the choice's
  // product reads, and count as many requests (lib/cart-offers.ts): the same ceiling holds them.
  assert.equal(CART_OFFER_REQUEST_UNITS, NEXT_OFFER_REQUEST_UNITS);
  // And its checkout reminder is ASSIST_REMIND_REQUEST_UNITS public requests: more than its reads and Stripe calls cost.
  assert.ok(ASSIST_REMIND_REQUEST_UNITS * laterPageCost() >= ASSIST_REMIND_READ, `${ASSIST_REMIND_REQUEST_UNITS} x ${laterPageCost()} < ${ASSIST_REMIND_READ}`);
  console.log(`a Store assistant checkout reminder: $${ASSIST_REMIND_READ.toFixed(6)} at most besides its email and model, counted as ${ASSIST_REMIND_REQUEST_UNITS} requests at $${laterPageCost().toFixed(6)}`);
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

test("a companies request fits its studio requests, and each page that reads every company fits what it counts", () => {
 assert.ok(COMPANIES_REQUEST <= UNIT_COST.studio * COMPANIES_REQUEST_UNITS, `${COMPANIES_REQUEST} > ${COMPANIES_REQUEST_UNITS} x ${UNIT_COST.studio}`);
 assert.ok(COMPANIES_PAGE_READ <= UNIT_COST.studio * COMPANIES_READ_UNITS, `${COMPANIES_PAGE_READ} > ${COMPANIES_READ_UNITS} x ${UNIT_COST.studio}`);
 assert.ok(COMPANIES_PAGE_READ > UNIT_COST.studio * (COMPANIES_READ_UNITS - 1), "fewer studio requests would be enough: lower COMPANIES_READ_UNITS");
 // What a page sends on is counted by its size: one studio request for each STUDIO_UNIT_SENT_BYTES.
 assert.ok(STUDIO_UNIT_SENT <= UNIT_COST.studio, `${STUDIO_UNIT_SENT} > ${UNIT_COST.studio}`);
 // The companies page at its most (every company, every person at them with an address of 254 characters): the
 // records written in the page and again for React, and the markup around them.
 const sent = Math.ceil((SENT_TIMES * (MAX_COMPANIES_BYTES + MAX_COMPANIES * MAX_COMPANY_PEOPLE * 320) + MAX_COMPANIES * COMPANY_MARKUP_BYTES + MAX_COMPANIES * MAX_COMPANY_PEOPLE * COMPANY_PERSON_MARKUP_BYTES) / STUDIO_UNIT_SENT_BYTES);
 // One byte of JSON is never sent as more than SENT_TIMES bytes: a name of "&" and "<" signs, measured as Next sends it.
 const amp = JSON.stringify({ name: "&<>\"".repeat(20) });
 assert.ok(sentBytes(amp) <= SENT_TIMES * amp.length && sentBytes(amp) >= 8 * amp.length, `${sentBytes(amp)} for ${amp.length}`);
 assert.ok(sent >= 17, `the fullest companies page sends ${sent} studio requests' worth: never less than the review's 17`);
 console.log(`the fullest companies page: ${STUDIO_PAGE_UNITS} + ${COMPANIES_READ_UNITS} + ${sent} studio requests, and its reading of the buyers when Stripe is read`);
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
 assert.ok(source.includes('["HLEN", importedWhoKey(store.statsId)]') && source.includes("const paypal = await paypalKept(store.statsId, Boolean(store.paypalSeller));") && !source.includes("store.paypalSeller ? await paypalKept") && source.includes("ledgerUnits(moved)") && source.indexOf("HLEN") < source.indexOf("await importedBuyers(store.statsId)"), "the imported buyers and PayPal's sales are counted before they are read");
 assert.ok(source.includes('["STRLEN", ledgerKey(store.statsId)]') && source.indexOf("STRLEN") < source.indexOf('["GETRANGE", ledgerKey(store.statsId)'), "the copy is measured and counted before it is read, and read no further");
 // PayPal's reading is counted in full (round 5, H1): what ledgerReadBytes counts for the most PayPal kept covers PAYPAL_LEDGER.
 const paypalUnits = ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: Number.MAX_SAFE_INTEGER, paypalRefunds: Number.MAX_SAFE_INTEGER }));
 assert.ok(PAYPAL_LEDGER <= UNIT_COST.studio * paypalUnits, `${PAYPAL_LEDGER} > ${paypalUnits} x ${UNIT_COST.studio}`);
 assert.ok(ledgerReadBytes({ imported: 0, paypalSales: 3_000, paypalRefunds: 500 }) >= PAYPAL_LEDGER_BYTES, "every PayPal record read is counted");
});

test("the tasks agenda at its most fits the studio requests it counts", () => {
 assert.ok(AGENDA_READ <= UNIT_COST.studio * AGENDA_UNITS, `${AGENDA_READ} > ${AGENDA_UNITS} x ${UNIT_COST.studio}`);
 // AGENDA_UNITS is what agendaReadUnits and the rows' size count at the most (lib/person-agenda.ts): never less than the cost.
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
