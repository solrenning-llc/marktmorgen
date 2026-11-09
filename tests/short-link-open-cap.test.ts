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
import { MAX_STORE_BYTES } from "@/lib/store";
import {
  SHORT_LINK_COUNT_COMMANDS, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_READ_COMMANDS, SHORT_LINK_REFUND_COMMANDS, SHORT_LINK_REST_COMMANDS,
  SHORT_LINK_REST_REFUNDS_PER_MINUTE, SHORT_LINK_UNKNOWN_PAUSE_MS, SHORT_LINK_UNPAID_PER_HOUR, SHORT_LINK_USED_UP_PAUSE_MS,
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

  part("Codes nobody has, from many addresses: at most the hour's figure read, then a 503 that reads nothing");
  commands = [];
  let ended = 0;
  let paused = 0;
  let pausedAnswer: Awaited<ReturnType<typeof open>> | null = null;
  for (let i = 0; i < UNPAID_PER_HOUR + 40; i += 1) {
    const answer = await open(missing(i + 10), fresh());
    if (answer.to?.endsWith("/l/ended")) ended += 1;
    if (answer.status === 503) { paused += 1; pausedAnswer = answer; }
  }
  is("the first ones are told the link ended, as before", ended <= UNPAID_PER_HOUR && ended >= UNPAID_PER_HOUR - 1, true);
  is("no more than the hour's figure are read", linkReads() <= UNPAID_PER_HOUR, true);
  is("the rest are refused", paused >= 40, true);
  is("the refusal sends nobody anywhere and is never kept", [pausedAnswer?.to ?? null, pausedAnswer?.cache.includes("no-store")], [null, true]);
  is("it says when links open again", /UTC/.test(pausedAnswer?.text ?? "") && Number(pausedAnswer?.retry) > 0, true);
  commands = [];
  const quiet = await open(missing(5_000), fresh());
  is("once the instance knows the hour is used, an open sends nothing at all", [quiet.status, commands.length], [503, 0]);
  const live = await open(code, fresh());
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
  is("the heaviest unpaid open was measured", unpaidPipelines >= 3 && unpaidCommands >= SHORT_LINK_COUNT_COMMANDS + SHORT_LINK_READ_COMMANDS, true);
  // Priced with room: two pipelines and four commands more than measured, so a change in what the store's count sends stays inside.
  // Rule 23 (9 November 2026): was "at most 6 pipelines and 8 commands", priced at request(6 + 2, 8 + 4). The store's id is now read
  // with its resting mark and the refund's DECR and EXPIRE in one pipeline, and an open the store does not pay for is counted in the
  // hour again: 7 pipelines and 12 commands measured for this open (a count that could not be made).
  is("the heaviest unpaid open waits on at most 7 pipelines and sends at most 12 commands", [unpaidPipelines <= 7, unpaidCommands <= 12], [true, true]);
  const unpaid = request(7 + 2, 12 + 4, MAX_STORE_BYTES + 4_096);
  const counted = request(1, SHORT_LINK_COUNT_COMMANDS, 64);
  const MONTH_HOURS = 31 * 24;
  const readMonth = SHORT_LINK_UNPAID_PER_HOUR * MONTH_HOURS * unpaid;
  // One instance's counts beyond them: one a minute that finds the hour used, and one a minute after a count it could not read.
  // Rule 23 (9 November 2026): the used hour was counted once an hour ((1 + HOUR / SHORT_LINK_UNKNOWN_PAUSE_MS), under $3); it is now
  // counted again a minute later (SHORT_LINK_USED_UP_PAUSE_MS), so a paid link is not refused for the rest of the hour.
  const instanceMonth = (HOUR / SHORT_LINK_USED_UP_PAUSE_MS + HOUR / SHORT_LINK_UNKNOWN_PAUSE_MS) * MONTH_HOURS * counted;
  // Added 9 November 2026: a store over its own requests is refused off the shared count at most SHORT_LINK_REST_REFUNDS_PER_MINUTE
  // times a minute on each instance, each at most the heaviest unpaid open and the SET of its resting mark.
  const restMonth = SHORT_LINK_REST_REFUNDS_PER_MINUTE * 60 * MONTH_HOURS * (unpaid + request(1, 1, 64));
  console.log(`  cost  heaviest unpaid open $${unpaid.toFixed(6)} (${unpaidPipelines} pipelines, ${unpaidCommands} commands measured), counted-only $${counted.toFixed(6)}; the shared count's unpaid opens $${readMonth.toFixed(2)} a month; per instance (their number unknown, never zero): counts beyond them $${instanceMonth.toFixed(2)} and store refusals off the count $${restMonth.toFixed(2)} a month`);
  // Rule 23 (9 November 2026): was "under $15" ($14.13 measured); the heaviest open is now priced at 9 waits and 16 commands
  // instead of 8 and 12 (an open its store does not pay for is counted in the hour again), $15.80 measured.
  is("the shared count's unpaid opens stay under $16 a month", readMonth < 16, true);
  is("one instance's counts beyond them stay under $6 a month", instanceMonth < 6, true);
  is("one instance's store refusals off the count stay under $20 a month", restMonth < 20, true);
  // Rule 23 (9 November 2026): was 6 (count 2, reads 3, DECR 1); now the resting mark's GET and the refund's EXPIRE are sent too.
  is("a paid open's own commands, held in the store's unit (tests/plan-cost-registry.test.ts)", SHORT_LINK_COUNT_COMMANDS + SHORT_LINK_READ_COMMANDS + SHORT_LINK_REST_COMMANDS + SHORT_LINK_REFUND_COMMANDS, 8);
  // The company's cost is held in the test registry, unreviewed: priced above zero, its ceiling unknown, never zero.
  is("the company's cost is held, priced above zero, its reviewed ceiling unknown and not approved", [
    SHORT_LINK_UNPAID_COMPANY_COST.perHour,
    readMonth > 0 && instanceMonth > 0,
    SHORT_LINK_UNPAID_COMPANY_COST.reviewedMonthlyUsdCents,
    SHORT_LINK_UNPAID_COMPANY_COST.approvedCeiling,
  ], [SHORT_LINK_UNPAID_PER_HOUR, true, null, false]);
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
