/**
 * Opening a short link (app/l/[code]/route.ts) has a ceiling on what it can
 * cost (Claude 5, 7 November 2026). Before this, every open that reached the
 * function read the database (the link, then the store's record), charged
 * nothing to any store and was never refused: a visitor asking for codes
 * nobody has, or the same link with a different query each time (the CDN
 * keeps only an exact address), made the company pay without any bound.
 *
 * What is held here, with a synthetic store and the in-memory database:
 *
 *   - a link that opens is one of its store's public requests (lib/traffic.ts,
 *     takePublicRequest), so the store's plan pays for it, and it does not
 *     use the site's hour of opens nobody pays for;
 *   - one address may make one server instance open at most
 *     SHORT_LINK_OPENS_PER_ADDRESS links in SHORT_LINK_ADDRESS_WINDOW_MS
 *     (lib/local-limit.ts), refused with a 429 and nothing read;
 *   - opens nobody pays for (a code nobody has, a store gone) are counted in
 *     the hour, in one count every instance shares, before anything is read,
 *     and at most SHORT_LINK_UNPAID_PER_HOUR of them read: past it the
 *     instance refuses with a 503 that says when to try again, and sends
 *     nothing to the database for a minute (since 9 November 2026; until
 *     then, until the hour turned); a store over its own requests is held in
 *     tests/short-link-open-avail.test.ts;
 *   - a count that cannot be read is not room to read: 503, nothing read;
 *   - a refusal never sends the visitor anywhere (no Location) and is never
 *     kept by the CDN (no-store): it is never shown as "this link ended".
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { CODE_LETTERS } from "@/lib/short-link-rules";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { calendarWindow } from "@/lib/allowance-window";
import { MAX_STORE_BYTES } from "@/lib/store";
import {
  SHORT_LINK_UNPAID_READ_UNITS, SHORT_LINK_COUNT_COMMANDS, SHORT_LINK_KNOWN_UNPAID_PER_HOUR, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_READ_COMMANDS, SHORT_LINK_REFUND_COMMANDS, SHORT_LINK_REST_COMMANDS,
  SHORT_LINK_REST_UNPAID_PER_HOUR, SHORT_LINK_UNKNOWN_PAUSE_MS, SHORT_LINK_UNPAID_PER_HOUR, SHORT_LINK_USED_UP_PAUSE_MS,
  SHORT_LINK_STORE_COUNT_COMMANDS, SHORT_LINK_STORE_REFUND_COMMANDS, SHORT_LINK_FLIGHT_MS, SHORT_LINK_PAID_BURST_COMMANDS,
} from "@/lib/short-link-open-rules";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_IDS } from "@/lib/llc-fixed-costs";
import { CURRENT_COMMERCIAL_TERMS } from "@/lib/commercial-margin";
import { SHORT_LINK_UNPAID_COMPANY_COST } from "./plan-cost-registry";
import {
  UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";
import { REDIS_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { CDN_PER_REQUEST, ORIGIN_PER_BYTE } from "./traffic-cost";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
// The figures the route is held to (lib/short-link-open-rules.ts).
const PER_ADDRESS = 30;
const UNPAID_PER_HOUR = 60;
// Added 9 November 2026 (Claude 2's first cost review of #3330): the shared hour is counted in units, an unpaid store read
// three and a code nobody has one, so it holds 180 lookups of codes nobody has.
const READ_UNITS = 3;
const LOOKUPS_PER_HOUR = UNPAID_PER_HOUR * READ_UNITS;
const HOUR = 3_600_000;

let commands: string[][] = [];
let pipelines = 0;
let inject: ((batch: Command[], values: unknown[]) => unknown[] | null) | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  commands.push(...batch.map((c) => c.map(String)));
  pipelines += 1;
  const values = await real(batch);
  return inject?.(batch, values) ?? values;
}) as typeof redis.pipeline;

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = (ms: number) => { shift += ms; advance(ms); };

const open = async (code: string, address: string, query = "") => {
  const request = new Request(`https://marktmorgen.com/l/${code}${query}`, { headers: { "x-forwarded-for": address } });
  const answer = await GET(request as never, { params: Promise.resolve({ code }) });
  return {
    status: answer.status,
    to: answer.headers.get("location"),
    cache: answer.headers.get("cache-control") ?? "",
    retry: answer.headers.get("retry-after"),
    text: answer.status === 302 ? "" : await answer.text(),
  };
};

const codeOf = (i: number) => {
  let code = "";
  let n = i;
  for (let k = 0; k < 6; k += 1) { code += CODE_LETTERS[n % CODE_LETTERS.length]; n = Math.floor(n / CODE_LETTERS.length); }
  return code;
};
async function addStoreLink(email: string, handle: string): Promise<string> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  const owner = (await storeForEmail(email))!;
  const made = await addLink({ sid: owner.sid, statsId: owner.statsId! }, { name: "reel", place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link");
  return made.link.code;
}
const linkReads = () => commands.filter((c) => c[0] === "GET" && c[1].startsWith("nl:slink:")).length;
const storeCharges = () => commands.filter((c) => c[0] === "INCRBY" && c[1].startsWith("nl:traffic:r:")).length;
let addresses = 0;
const fresh = () => `198.51.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

async function main(): Promise<void> {
  redis.clear();
  // Start at the top of an hour, so no part below runs across one by accident.
  later(HOUR - (Date.now() % HOUR) + 1_000);
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  const made = await addLink({ sid: store.sid, statsId: store.statsId! }, { name: "reel", place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link");
  const code = made.link.code;
  const missing = (i: number) => { const c = codeOf(i); return c === code ? codeOf(i + 1_000_000) : c; };

  part("A link that opens is paid by its store, and does not use the site's hour");
  commands = [];
  const paid = 2 * UNPAID_PER_HOUR + 20;
  let sent = 0;
  for (let i = 0; i < paid; i += 1) if ((await open(code, fresh(), `?fbclid=${i}`)).to?.includes("/@harbor")) sent += 1;
  is("every open from a new address is sent to the store's page", sent, paid);
  is("each open is one of the store's public requests", storeCharges(), paid);

  part("One address, one instance: a few dozen opens in ten minutes, then a 429 that reads nothing");
  const busy = fresh();
  for (let i = 0; i < PER_ADDRESS; i += 1) await open(code, busy, `?i=${i}`);
  commands = [];
  const refused = await open(code, busy, "?one-more");
  is("the next open from that address is refused with 429", refused.status, 429);
  is("it sends the visitor nowhere", refused.to, null);
  is("it is never kept by the CDN", refused.cache.includes("no-store"), true);
  is("it says when to try again", refused.retry !== null && Number(refused.retry) > 0, true);
  is("it says so in words", /try/i.test(refused.text), true);
  is("nothing is sent to the database for it", commands.length, 0);
  is("another address still opens the link", (await open(code, fresh(), "?other")).to?.includes("/@harbor"), true);

  part("A count of the hour that cannot be read is not room to read");
  inject = (batch) => (batch.some((c) => String(c[1]).startsWith("nl:slink:open:")) ? ["OK"] : null);
  commands = [];
  const unknown = await open(missing(1), fresh());
  inject = null;
  is("503, never the page that says the link ended", [unknown.status, unknown.to], [503, null]);
  is("never kept by the CDN", unknown.cache.includes("no-store"), true);
  is("the link is not read", linkReads(), 0);
  later(61_000);

  // Rule 23 (9 November 2026, Claude 2's first cost review): every UNPAID_PER_HOUR in this part was the hour's figure in opens;
  // it is now LOOKUPS_PER_HOUR, the same hour in units, a code nobody has one unit.
  part("Codes nobody has, from many addresses: at most the hour's figure read, then a 503 that reads nothing");
  commands = [];
  pipelines = 0;
  await open(missing(3), fresh());
  // Added 9 November 2026 (Claude 2's first cost review): what one code nobody has costs, counted and looked up.
  const missPipelines = pipelines;
  const missCommands = commands.length;
  let ended = 1;
  let paused = 0;
  let pausedAnswer: Awaited<ReturnType<typeof open>> | null = null;
  for (let i = 1; i < LOOKUPS_PER_HOUR + 40; i += 1) {
    const answer = await open(missing(i + 10), fresh());
    if (answer.to?.endsWith("/l/ended")) ended += 1;
    if (answer.status === 503) { paused += 1; pausedAnswer = answer; }
  }
  is("the first ones are told the link ended, as before", ended <= LOOKUPS_PER_HOUR && ended >= LOOKUPS_PER_HOUR - 1, true);
  is("no more than the hour's figure are read", linkReads() <= LOOKUPS_PER_HOUR, true);
  is("the rest are refused", paused >= 40, true);
  is("the refusal sends nobody anywhere and is never kept", [pausedAnswer?.to ?? null, pausedAnswer?.cache.includes("no-store")], [null, true]);
  is("it says when links open again", /UTC/.test(pausedAnswer?.text ?? "") && Number(pausedAnswer?.retry) > 0, true);
  commands = [];
  const quiet = await open(missing(5_000), fresh());
  is("once the instance knows the hour is used, an open sends nothing at all", [quiet.status, commands.length], [503, 0]);
  const live = await open(code, fresh());
  // Kept on 9 November 2026 (Claude 2's first cost review, ALTO 1): a link this instance has not paid for a moment ago is
  // still refused once the hour is used, because a code cannot be told from one nobody has before it is read; the hour
  // now takes 180 codes nobody has and one address only SHORT_LINK_MISSES_PER_ADDRESS of them, the residual risk.
  is("a live link is refused too, honestly, without being called ended", [live.status, live.to], [503, null]);

  part("The next hour opens again");
  later(HOUR);
  is("the live link opens", (await open(code, fresh())).to?.includes("/@harbor"), true);
  is("a code nobody has is told it ended", (await open(missing(9_000), fresh())).to?.endsWith("/l/ended"), true);

  part("A store that cannot take one more request: nobody is sent on, and the link is not read again at once");
  inject = (batch) => (batch.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) ? ["not a count"] : null);
  commands = [];
  pipelines = 0;
  const tired = await open(code, fresh(), "?tired");
  inject = null;
  // The heaviest open no store pays for: counted, the link and the store read, the store's count tried and refused.
  const unpaidPipelines = pipelines;
  const unpaidCommands = commands.length;
  is("503, never sent to the store nor told the link ended", [tired.status, tired.to], [503, null]);
  is("never kept by the CDN", tired.cache.includes("no-store"), true);
  commands = [];
  const again = await open(code, fresh(), "?again");
  is("the same link a moment later is answered from memory, nothing read", [again.status, commands.length], [503, 0]);
  later(61_000);
  is("a minute later it is read again, and opens", (await open(code, fresh(), "?minute")).to?.includes("/@harbor"), true);

  // Added 9 November 2026 (second pre-review, MÉDIO): the heaviest open no store pays for is a free store, the
  // month's free places taken, found the first time this hour, after this instance's minute off the hour was used by
  // another resting store: counted, read, refused by the free pool, its mark written and counted in the hour again.
  part("The heaviest open no store pays for is measured, and is within what it is priced at");
  forgetShortLinkOpenMemory();
  later(HOUR - (Date.now() % HOUR) + 1_000);
  const spare = await addStoreLink("spare@example.com", "spare");
  const free = await addStoreLink("free@example.com", "freeone");
  await redis.pipeline([["SET", `nl:free:n:${calendarWindow(Date.now()).id}`, "1000000000"]]);
  // Rule 23 (9 November 2026, third pre-review): was "another resting store takes this instance's minute"; there is no
  // such minute now. Another resting store is refused first, then the resting hour is used, so this open is counted
  // in the resting hour, found past it, and counted in the shared hour again: the heaviest path.
  is("another resting store is refused first", (await open(spare, fresh())).status, 503);
  await redis.pipeline([["SET", `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`, String(SHORT_LINK_REST_UNPAID_PER_HOUR)]]);
  commands = [];
  pipelines = 0;
  const heaviest = await open(free, fresh());
  const heaviestPipelines = pipelines;
  const heaviestCommands = commands.length;
  is("the free store without a place is refused, never sent on nor called ended", [heaviest.status, heaviest.to], [503, null]);
  // Rule 23 (9 November 2026, Claude 2's first cost review, ALTO 2): was 2, the lookup and the spill past the resting hour;
  // a resting store's open never lands in the shared hour now: only its lookup, given back.
  is("it was counted in the shared hour only for its lookup", commands.filter((c) => (c[0] === "INCR" || c[0] === "INCRBY") && c[1].startsWith("nl:slink:open:")).length, 1);
  is("it waits on no more pipelines and sends no more commands than the registry prices", [
    heaviestPipelines <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits, heaviestCommands <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands,
    unpaidPipelines <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits, unpaidCommands <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands,
  ], [true, true, true, true]);
  // Added 9 November 2026 (Claude 2's first cost review): the same store's link on a new instance, its mark now written: the
  // lookup, the store's id and mark, refused on the mark and counted in the resting hour, its record never read.
  forgetShortLinkOpenMemory();
  commands = [];
  pipelines = 0;
  const marked = await open(free, fresh());
  const markPipelines = pipelines;
  const markCommands = commands.length;
  is("a resting store's link on a new instance is refused on its mark, nothing in the shared hour kept", [
    marked.status, commands.some((c) => c[0] === "GET" && c[1].startsWith("nl:store:") && !c[1].startsWith("nl:store:id:")),
  ], [503, false]);
  is("priced with room: two pipelines and four commands over the heaviest measured", [
    SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits >= heaviestPipelines + 2, SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands >= heaviestCommands + 4,
  ], [true, true]);

  part("The figures the route is held to are the code's");
  // Added with the fix (rule 23: the RED checks above keep their literals; these hold them to lib/short-link-open-rules.ts).
  is("opens per address", SHORT_LINK_OPENS_PER_ADDRESS, PER_ADDRESS);
  is("unpaid opens an hour", SHORT_LINK_UNPAID_PER_HOUR, UNPAID_PER_HOUR);

  part("What the opens no store pays for cost the company at most, a month (MR item 2; tests/plan-cost-registry.ts)");
  const micro = (n: number) => n / 1_000_000;
  const COMMAND = micro(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6;
  const CALL = micro(VERCEL_CALL_MICRO_USD_PER_MILLION) / 1e6;
  const CPU_SECOND = micro(VERCEL_CPU_MICRO_USD_PER_HOUR) / 3600;
  const MEMORY_SECOND = VERCEL_FUNCTION_GB * micro(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) / 3600;
  const DB_BYTE = micro(UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e9;
  // A request at its worst: the CDN's request, two calls (the proxy and the route), half a second of CPU (a redirect
  // draws nothing), memory held through every Redis wait at its timeout plus a second, a whole store record and a
  // link read, and a refusal's few hundred bytes sent.
  const request = (waits: number, sentCommands: number, dbBytes: number) =>
    CDN_PER_REQUEST + 2 * CALL + 0.5 * CPU_SECOND + (waits * REDIS_TIMEOUT_MS / 1000 + 1) * MEMORY_SECOND
    + sentCommands * COMMAND + dbBytes * DB_BYTE + 1_000 * ORIGIN_PER_BYTE;
  is("the heaviest unpaid open was measured", unpaidPipelines >= 3 && unpaidCommands >= SHORT_LINK_COUNT_COMMANDS + SHORT_LINK_READ_COMMANDS && heaviestPipelines >= 3, true);
  // Priced with room: two pipelines and four commands more than measured, so a change in what the store's count sends stays inside.
  // Rule 23 (9 November 2026): was "at most 6 pipelines and 8 commands", priced at request(6 + 2, 8 + 4). The store's id is now read
  // with its resting mark and the refund's DECR and EXPIRE in one pipeline, and an open the store does not pay for is counted in the
  // hour again: 7 pipelines and 12 commands measured for this open (a count that could not be made).
  // Rule 23 (9 November 2026, the owner's decision 14): was "at most 12 commands"; the store's own count adds its INCR and
  // EXPIRE to the pipeline that reads the store's id, and this open, which did not read the record unpaid, gives it back: 16.
  // Rule 23 (Claude 2's focal on #3330 @99ac6f3858): was "at most 16 commands"; the store's own counts are five commands
  // in the pipeline that reads its id (was two), and its place is given back with one ZREM (was DECR and EXPIRE): 18.
  is("the heaviest unpaid open waits on at most 7 pipelines and sends at most 18 commands", [unpaidPipelines <= 7, unpaidCommands <= 18], [true, true]);
  // Rule 23 (9 November 2026, second pre-review): was request(7 + 2, 12 + 4), the open whose store count could not be
  // made; the heaviest is the free store without a place measured above (9 pipelines and 17 commands), priced at the
  // registry's heaviestUnpaid, which holds that room. Since the third pre-review it is that open found past the resting
  // hour and counted in the shared hour again: 10 pipelines and 19 commands, priced at 12 and 23.
  const unpaid = request(SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits, SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands, MAX_STORE_BYTES + 4_096);
  const counted = request(1, SHORT_LINK_COUNT_COMMANDS, 64);
  const MONTH_HOURS = 31 * 24;
  // Rule 23 (9 November 2026, second pre-review): was SHORT_LINK_UNPAID_PER_HOUR alone; a link paid on an instance a moment
  // ago is now read while the hour is used only inside SHORT_LINK_KNOWN_UNPAID_PER_HOUR more in the same count.
  const readMonth = (SHORT_LINK_UNPAID_PER_HOUR + SHORT_LINK_KNOWN_UNPAID_PER_HOUR) * MONTH_HOURS * unpaid;
  // One instance's counts beyond them: one a minute that finds the hour used, and one a minute after a count it could not read.
  // Rule 23 (9 November 2026): the used hour was counted once an hour ((1 + HOUR / SHORT_LINK_UNKNOWN_PAUSE_MS), under $3); it is now
  // counted again a minute later (SHORT_LINK_USED_UP_PAUSE_MS), so a paid link is not refused for the rest of the hour.
  // Rule 23 (9 November 2026, third pre-review): was the used hour and an unreadable count, two a minute; the resting hour,
  // once used, is counted again a minute later too (SHORT_LINK_USED_UP_PAUSE_MS), three a minute.
  const instanceMonth = (2 * HOUR / SHORT_LINK_USED_UP_PAUSE_MS + HOUR / SHORT_LINK_UNKNOWN_PAUSE_MS) * MONTH_HOURS * counted;
  // Rule 23 (9 November 2026, third pre-review): was SHORT_LINK_REST_REFUNDS_PER_MINUTE * 60 an hour on each instance (one a
  // minute off the shared count, their number unknown), each the heaviest unpaid open and a SET. Opens of resting stores are now
  // counted in the resting hour every instance shares, SHORT_LINK_REST_UNPAID_PER_HOUR an hour site-wide, each at the heaviest
  // unpaid open, which holds the SET of the resting mark.
  const restMonth = SHORT_LINK_REST_UNPAID_PER_HOUR * MONTH_HOURS * unpaid;
  console.log(`  cost  heaviest unpaid open $${unpaid.toFixed(6)} (priced at ${SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits} pipelines and ${SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands} commands; ${heaviestPipelines} and ${heaviestCommands} measured at the heaviest), counted-only $${counted.toFixed(6)}; the shared count's unpaid opens $${readMonth.toFixed(4)} a month; the resting hour's opens $${restMonth.toFixed(4)} a month; per instance (their number unknown, never zero): counts beyond them $${instanceMonth.toFixed(2)} a month`);
  // Rule 23 (9 November 2026): was "under $15" ($14.13 measured); the heaviest open is now priced at 9 waits and 16 commands
  // instead of 8 and 12 (an open its store does not pay for is counted in the hour again), $15.80 measured.
  // Rule 23 (9 November 2026, second pre-review): was "under $16" ($15.80, 60 an hour at 9 waits and 16 commands); now 60 + 20
  // an hour at the heaviest measured with its room, 11 waits and 21 commands: $25.17 measured.
  // Rule 23 (9 November 2026, third pre-review): was "under $26" ($25.17 at 11 waits and 21 commands); a resting store's first
  // open past the resting hour is counted in the shared hour again, so the heaviest is measured at 10 pipelines and 19 commands,
  // priced with its room at 12 and 23: $27.16 measured.
  // Added 9 November 2026 (Claude 2's first cost review): a unit of the shared hour is priced at the dearer of a code nobody
  // has (measured above, with room) and a third of the heaviest unpaid open, so the hour in units costs no less than in opens
  // (three units, not more, keep this hour about where it was in opens: $28.34 against $27.16).
  const miss = request(missPipelines + 2, missCommands + 4, 64);
  const unit = Math.max(miss, unpaid / READ_UNITS);
  const unitsMonth = (SHORT_LINK_UNPAID_PER_HOUR + SHORT_LINK_KNOWN_UNPAID_PER_HOUR) * READ_UNITS * MONTH_HOURS * unit;
  console.log(`  cost  a code nobody has $${miss.toFixed(6)} (${missPipelines} pipelines and ${missCommands} commands measured), a unit of the shared hour $${unit.toFixed(6)}; the shared hour in units $${unitsMonth.toFixed(2)} a month`);
  is("a code nobody has was measured: counted and looked up, two pipelines and three commands", [missPipelines, missCommands], [2, 3]);
  is("the figures are the code's: three units a store read, the registry holds them", [SHORT_LINK_UNPAID_READ_UNITS, SHORT_LINK_UNPAID_COMPANY_COST.readUnits], [READ_UNITS, READ_UNITS]);
  is("the shared count's unpaid opens stay under $28 a month", readMonth < 28, true);
  is("the shared hour in units, every unit at its dearer price, stays under $29 a month", unitsMonth < 29, true);
  // Rule 23 (9 November 2026, third pre-review): was "under $6" (two counts a minute); three a minute now: $8.09 measured.
  is("one instance's counts beyond them stay under $9 a month", instanceMonth < 9, true);
  // Rule 23 (9 November 2026, third pre-review): was "one instance's store opens off the count stay under $22 a month" ($21.49,
  // per instance, their number unknown). They are now the resting hour every instance shares, a site-wide figure,
  // SHORT_LINK_REST_UNPAID_PER_HOUR an hour at 12 waits and 23 commands: $40.75 measured, for every instance together.
  is("the resting hour's opens, for every instance together, stay under $42 a month", restMonth < 42, true);
  // Rule 23 (9 November 2026): was 6 (count 2, reads 3, DECR 1); now the resting mark's GET and the refund's EXPIRE are sent too.
  is("a paid open's own commands, held in the store's unit (tests/plan-cost-registry.test.ts)", SHORT_LINK_COUNT_COMMANDS + SHORT_LINK_READ_COMMANDS + SHORT_LINK_REST_COMMANDS + SHORT_LINK_REFUND_COMMANDS, 8);
  // Added with Claude 2's focal on #3330: a place among a store's opens in flight outlasts the heaviest open, every wait at its timeout.
  is("a place in flight lasts longer than the heaviest open can take", SHORT_LINK_FLIGHT_MS > SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits * REDIS_TIMEOUT_MS, true);
  // Added with Claude 2's focal on #3330: with the store's own counts (five) and its place given back (one), a paid open sends 14.
  is("a paid open's own commands with its store's counts, held in SHORT_LINK_OPEN_READ", SHORT_LINK_COUNT_COMMANDS + SHORT_LINK_READ_COMMANDS + SHORT_LINK_REST_COMMANDS + SHORT_LINK_REFUND_COMMANDS + SHORT_LINK_STORE_COUNT_COMMANDS + SHORT_LINK_STORE_REFUND_COMMANDS, 14);
  // Added with Claude 2's NIT on @125a390e49: a paying store's open past its opens in flight sends the paid burst's too.
  is("a paid open's worst, past its opens in flight, held in SHORT_LINK_OPEN_READ", SHORT_LINK_COUNT_COMMANDS + SHORT_LINK_READ_COMMANDS + SHORT_LINK_REST_COMMANDS + SHORT_LINK_REFUND_COMMANDS + SHORT_LINK_STORE_COUNT_COMMANDS + SHORT_LINK_STORE_REFUND_COMMANDS + SHORT_LINK_PAID_BURST_COMMANDS, 20);
  // The company's cost is held in the test registry, unreviewed: priced above zero, its ceiling unknown, never zero.
  is("the company's cost is held, priced above zero, its reviewed ceiling unknown and not approved", [
    SHORT_LINK_UNPAID_COMPANY_COST.perHour,
    readMonth > 0 && instanceMonth > 0,
    SHORT_LINK_UNPAID_COMPANY_COST.reviewedMonthlyUsdCents,
    SHORT_LINK_UNPAID_COMPANY_COST.approvedCeiling,
  ], [SHORT_LINK_UNPAID_PER_HOUR, true, null, false]);
  // Added 9 November 2026 (third pre-review): the resting hour is held beside it, priced above zero, site-wide, the number of instances unknown.
  is("the resting hour is held in the registry, priced above zero, its instances unknown", [
    SHORT_LINK_UNPAID_COMPANY_COST.restPerHour, restMonth > 0, SHORT_LINK_UNPAID_COMPANY_COST.instances,
  ], [SHORT_LINK_REST_UNPAID_PER_HOUR, true, null]);
  // Added 9 November 2026 (Claude 2's first cost review, ALTO 2): past the resting hour a resting store's opens are refused and
  // never counted in the shared hour, so what they read is held per resting store, their number unknown, never zero: its
  // record at most once a resting mark's time, and on each instance each of its links looked up once while remembered.
  // Rule 23 (9 November 2026, the owner's decision 14): was request(markPipelines + 2, markCommands + 4, 4_096); a resting
  // store's lookup is now priced at the registry's restingLookup, which holds that room over the open refused on its mark
  // (measured here) and over the open answered as turned off (measured in tests/short-link-open-rest-cap.test.ts).
  const resting = SHORT_LINK_UNPAID_COMPANY_COST.perRestingStore;
  const markOpen = request(resting.restingLookup.waits, resting.restingLookup.commands, 4_096);
  is("a resting store's lookup is priced with room over the open refused on its mark", [resting.restingLookup.waits >= markPipelines + 2, resting.restingLookup.commands >= markCommands + 4], [true, true]);
  // Rule 23 (9 November 2026, Claude 2's focal return): was storeReadsPerHour alone ($20.37), a figure the code did not hold:
  // the opens in flight when a mark expired all read the record (600 in an hour, tests/short-link-open-prerev5.test.ts). The
  // check now holds storeReadsPerHour site-wide, and a store with no mark at all is read by at most the opens the two hours
  // hold at once, once a mark's life.
  // Rule 23 (9 November 2026, the owner's decision 14): was storeReadsPerHour (60) a month plus coldReadsPerLapse (360) once a
  // lapseEveryMs, US$81.49, not approved; now the store's own count, SHORT_LINK_STORE_READS_PER_HOUR reads an hour at most,
  // counted before each read, cold burst included (tests/short-link-open-rest-cap.test.ts), each at the heaviest unpaid open.
  const restingStoreMonth = resting.storeReadsPerHour * MONTH_HOURS * unpaid;
  const restingStoreInstanceMonth = SHORT_LINK_UNPAID_COMPANY_COST.perRestingStore.lookupsPerInstancePerHour * MONTH_HOURS * markOpen;
  console.log(`  cost  past the resting hour, per resting store: its record $${restingStoreMonth.toFixed(4)} a month; per instance, its links looked up $${restingStoreInstanceMonth.toFixed(4)} a month (an open refused on its mark $${markOpen.toFixed(6)}: ${markPipelines} pipelines and ${markCommands} commands measured)`);
  // Rule 23 (9 November 2026, the owner's decision 14): was "at most 4 pipelines and 9 commands"; the store's own count's
  // INCR and EXPIRE ride in the pipeline that reads its id, and are given back with the count in the resting hour: 13.
  // Rule 23 (Claude 2's focal): was "at most 13 commands"; the store's counts are five commands, its place given back with one: 15.
  is("a resting store's open refused on its mark was measured: at most 4 pipelines and 15 commands", [markPipelines <= 4, markCommands <= 15], [true, true]);
  // Rule 23 (9 November 2026, Claude 2's focal return): was "under $21 a month" ($20.37, the 60 an hour the code did not hold);
  // the claims a mark's time plus a store with no mark read by every open the two hours hold at once, every two hours: $81.49.
  // Rule 23 (9 November 2026, the owner's decision 14): was "under $82 a month" ($81.49) and, for the lookups on one instance,
  // "under $18 a month" ($17.09, MAX_LINKS an hour); not approved. Now SHORT_LINK_STORE_READS_PER_HOUR reads an hour, and each
  // link looked up once a SHORT_LINK_RESTING_OWNER_MS on an instance: held under the registry's figures, awaiting the owner.
  is("one resting store's record reads stay under the registry's month (cents)", Math.ceil(restingStoreMonth * 100) <= resting.monthCeilingUsdCents, true);
  // Added with Claude 2's focal re-review on #3330 @125a390e49: a paying store out of its own requests, its own counts.
  const paidRestingStoreMonth = resting.paidStoreReadsPerHour * MONTH_HOURS * unpaid;
  console.log(`  cost  per paying store out of its own requests: its record $${paidRestingStoreMonth.toFixed(4)} a month at most`);
  is("a paying store out of its own requests: its record reads stay under the registry's month (cents)", Math.ceil(paidRestingStoreMonth * 100) <= resting.paidMonthCeilingUsdCents, true);
  // Added with Claude 2's focal on #3330 @39da7f44db (LEVE 2): a paying store's opens refused past its paid reads in flight,
  // counted in a count of its own, at most paidRefusalsPerHour an hour one by one, each at paidRefusal's waits and
  // commands (measured with room in tests/short-link-open-rest-cap5.test.ts), a store's links and ids read, no record.
  const paidRefusalMonth = resting.paidRefusalsPerHour * MONTH_HOURS * request(resting.paidRefusal.waits, resting.paidRefusal.commands, 4_096);
  console.log(`  cost  per paying store, its opens refused past its paid reads in flight: $${paidRefusalMonth.toFixed(4)} a month at most`);
  is("a paying store's refusals past its paid reads in flight stay under the registry's month (cents)", Math.ceil(paidRefusalMonth * 100) <= resting.paidRefusalMonthCeilingUsdCents, true);
  is("one resting store's lookups on one instance stay under the registry's month (cents)", Math.ceil(restingStoreInstanceMonth * 100) <= resting.instanceMonthCeilingUsdCents, true);
  is("those figures wait for the owner's approval", resting.approvedByOwner, false);
  is("their number is held unknown, never zero", [SHORT_LINK_UNPAID_COMPANY_COST.restingStores, SHORT_LINK_UNPAID_COMPANY_COST.instances, restingStoreMonth > 0, restingStoreInstanceMonth > 0], [null, null, true, true]);
  // It is not a line of lib/llc-fixed-costs.ts: those lines enter CURRENT_COMMERCIAL_TERMS, which only the owner changes.
  const ids = (list: readonly { id: string }[] | readonly string[]) => list.map((x) => (typeof x === "string" ? x : x.id));
  is("nothing that feeds the commercial terms names it", [
    (LLC_FIXED_COST_IDS as readonly string[]).includes("short-link-unpaid-opens"),
    ids(CURRENT_LLC_FIXED_COST_CEILINGS).includes("short-link-unpaid-opens"),
    ids(CURRENT_COMMERCIAL_TERMS.llcFixedCosts.required).includes("short-link-unpaid-opens"),
    ids(CURRENT_COMMERCIAL_TERMS.llcFixedCosts.ceilings).includes("short-link-unpaid-opens"),
    JSON.stringify(CURRENT_COMMERCIAL_TERMS).includes("short-link") || JSON.stringify(CURRENT_COMMERCIAL_TERMS).includes("shortLink"),
  ], [false, false, false, false, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
