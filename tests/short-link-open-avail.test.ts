/**
 * The ceiling on opening a short link (lib/short-link-open.ts) must not take
 * every short link of the site down under ordinary traffic (pre-review of
 * claude5/short-link-open-cap, 9 November 2026, ALTO; proofs
 * prerev-short-link-open-cap-proof and -race-proof brought here as RED).
 *
 *   (i)   a store over its own limit, its link opened once a minute, plus one
 *         mistyped code, must not pause another store's paid link;
 *   (ii)  paid opens at once must not leave the instance stopped for the
 *         rest of the hour: a used-up hour is counted again a minute later,
 *         and a link this instance found a moment ago is still answered;
 *   (iii) a connection over its own share of a store's day is refused alone:
 *         the next visitor still opens the link, and the refused one is not
 *         told the page cannot be opened (MÉDIO);
 *   (iv)  the refund off the hour never leaves a count without expiry (LEVE);
 *   (v)   a link that cannot be read is a 503 kept by nobody, never "ended"
 *         (the try/catch of PR #2527);
 *   (vi)  the company's share is said per instance, the number of instances
 *         unknown, never zero (MÉDIO).
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { CODE_LETTERS } from "@/lib/short-link-rules";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { NOT_A_COST, SHORT_LINK_UNPAID_COMPANY_COST } from "./plan-cost-registry";
import { SHORT_LINK_REST_UNPAID_PER_HOUR } from "@/lib/short-link-open-rules";
import { answering } from "./security/next-headers";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
const UNPAID_PER_HOUR = 60;

let inject: ((batch: Command[], values: unknown[]) => unknown[] | null) | null = null;
let before: ((batch: Command[]) => Promise<void> | void) | null = null;
let jitter = false;
const seen: number[] = [];
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  if (jitter) await new Promise((r) => setTimeout(r, Math.random() * 5));
  await before?.(batch);
  const values = await real(batch);
  batch.forEach((c, i) => { if ((c[0] === "INCR" || c[0] === "DECR") && String(c[1]).startsWith("nl:slink:open:")) seen.push(Number(values[i])); });
  return inject?.(batch, values) ?? values;
}) as typeof redis.pipeline;

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = (ms: number) => { shift += ms; advance(ms); };

let n = 0;
const fresh = () => `203.0.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const open = async (code: string, address = fresh(), query = `?q=${n}`) => {
  const request = new Request(`https://marktmorgen.com/l/${code}${query}`, { headers: { "x-forwarded-for": address } });
  answering(request);
  try {
    const r = await GET(request as never, { params: Promise.resolve({ code }) });
    return { status: r.status, to: r.headers.get("location"), cache: r.headers.get("cache-control") ?? "", text: r.status === 302 ? "" : await r.text() };
  } finally {
    answering(null);
  }
};
const missing = (i: number) => { let s = ""; let k = i + 7_919; for (let j = 0; j < 6; j += 1) { s += CODE_LETTERS[k % CODE_LETTERS.length]; k = Math.floor(k / CODE_LETTERS.length); } return s; };

async function make(email: string, handle: string): Promise<string> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  const s = (await storeForEmail(email))!;
  const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name: "reel", place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link");
  return made.link.code;
}
const topOfHour = () => later(HOUR - (Date.now() % HOUR) + 1_000);
const reset = () => { redis.clear(); forgetShortLinkOpenMemory(); inject = null; before = null; jitter = false; seen.length = 0; };

async function main(): Promise<void> {
  part("(i) A store over its own limit and one mistyped code do not pause another store's link");
  reset();
  topOfHour();
  const tiredCode = await make("a@example.com", "alpha");
  const liveCode = await make("b@example.com", "bravo");
  // The store's own count answers far past its limit: a refusal for the store itself, not a count that cannot be made.
  inject = (batch) => (batch.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) ? batch.map((c) => (c[0] === "INCRBY" ? 1_000_000_000 : "OK")) : null);
  for (let i = 0; i < 59; i += 1) { const a = await open(tiredCode); if (i === 0) is("the tired store's link is refused, never called ended", [a.status, a.to], [503, null]); later(60_001); }
  inject = null;
  is("one mistyped code is told it ended", (await open("zzzzzz")).to?.endsWith("/l/ended"), true);
  const live = await open(liveCode);
  is("the other store's link, never opened on this instance before, opens", [live.status, live.to?.includes("/@bravo")], [302, true]);
  // Added with the fix (9 November 2026): only the store's own refusal marks it resting, for a minute.
  const alpha = (await storeForEmail("a@example.com"))!;
  inject = (batch) => (batch.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) ? batch.map((c) => (c[0] === "INCRBY" ? 1_000_000_000 : "OK")) : null);
  // Rule 23 (9 November 2026, second pre-review): this instance now keeps the store resting from memory, longer each time,
  // so its link would be refused with nothing sent; the mark is held on a fresh instance that finds the store itself.
  forgetShortLinkOpenMemory();
  await open(tiredCode);
  inject = null;
  // Rule 23 (9 November 2026, Claude 2's focal return): the mark was "1" for a minute, then gone, so every open in flight
  // read the store again; it now holds the moment the store rests until (a minute on), and lives two hours, so once that
  // moment is past one open alone, site-wide, asks the store again (tests/short-link-open-prerev5.test.ts).
  const markAt = Date.now();
  // Rule 23 (9 November 2026, the owner's decision 14): was Number(mark); a store without a paid plan's mark is now
  // "<until>:<since>" (since when it rests that way, for its links turned off after 30 days), so the moment is its first part.
  const untilOf = (value: unknown) => Number(String(value).split(":")[0]);
  const mark = (await redis.pipeline([["GET", `nl:slink:rest:${alpha.sid}`]]))[0];
  is("the store's own refusal writes its resting mark: the moment it rests until, a minute on", Math.abs(untilOf(mark) - (markAt + 60_000)) <= 2_000, true);
  later(61_000);
  is("after a minute the mark is still there, its moment past, so one open asks the store again", untilOf((await redis.pipeline([["GET", `nl:slink:rest:${alpha.sid}`]]))[0]) <= Date.now(), true);

  part("(ii) Paid opens at once do not stop the instance for the rest of the hour");
  reset();
  topOfHour();
  const busyCode = await make("c@example.com", "charlie");
  jitter = true;
  const statuses = await Promise.all(Array.from({ length: 100 }, () => open(busyCode).then((r) => r.status)));
  jitter = false;
  console.log(`  100 paid opens at once: ${statuses.filter((s) => s === 302).length} sent on, ${statuses.filter((s) => s === 503).length} refused`);
  is("the hour's count never goes below zero", Math.min(...seen) >= 0, true);
  later(120_000);
  is("two minutes later, nothing unpaid this hour, the link opens", (await open(busyCode)).status, 302);

  part("(ii) A used-up hour is counted again a minute later, and a link found a moment ago is still answered");
  reset();
  topOfHour();
  const knownCode = await make("d@example.com", "delta");
  is("a link opens", (await open(knownCode)).status, 302);
  for (let i = 0; i < UNPAID_PER_HOUR + 5; i += 1) await open(missing(i));
  const known = await open(knownCode);
  is("the link this instance found a moment ago is still answered while the hour is used", [known.status, known.to?.includes("/@delta")], [302, true]);
  later(61_000);
  let counted = 0;
  before = (batch) => { if (batch.some((c) => c[0] === "INCR" && String(c[1]).startsWith("nl:slink:open:"))) counted += 1; };
  await open(missing(9_999));
  before = null;
  is("a minute later the instance counts again instead of waiting for the hour to turn", counted, 1);

  part("(iii) A connection over its share is refused alone");
  reset();
  topOfHour();
  const sharedCode = await make("e@example.com", "echo");
  const greedy = fresh();
  // The connection's share of the store's day answers far past it (lib/traffic.ts, overShare): that connection alone is refused.
  inject = (batch) => (batch.some((c) => c[0] === "HINCRBY" && String(c[1]).startsWith("nl:traffic:c:")) ? [1_000_000_000, 1] : null);
  let refusedText = "";
  for (let i = 0; i < 6; i += 1) { const r = await open(sharedCode, greedy, `?g=${i}`); if (r.status !== 302) refusedText = r.text; }
  inject = null;
  is("the greedy connection was refused at least once", refusedText !== "", true);
  is("it is not told the page cannot be opened", /page this link leads to cannot be opened/i.test(refusedText), false);
  const next = await open(sharedCode);
  is("the next visitor, from another connection, opens the link", [next.status, next.to?.includes("/@echo")], [302, true]);
  // Added with the fix (9 November 2026): a connection's refusal never marks the store resting.
  const echo = (await storeForEmail("e@example.com"))!;
  is("no resting mark for the store", (await redis.pipeline([["GET", `nl:slink:rest:${echo.sid}`]]))[0], null);

  part("(iv) The refund off the hour never leaves a count without expiry");
  reset();
  topOfHour();
  const refundCode = await make("f@example.com", "foxtrot");
  // A DECR on a key that expired (or was evicted) between the count and the refund makes a -1 that never expires,
  // unless an EXPIRE of the same key goes in the same pipeline.
  const refunds: Command[][] = [];
  before = (batch) => { if (batch.some((c) => c[0] === "DECR" && String(c[1]).startsWith("nl:slink:open:"))) refunds.push(batch); };
  is("the link opens", (await open(refundCode)).status, 302);
  before = null;
  is("the refund was sent", refunds.length, 1);
  is("every refund goes with an EXPIRE of the same key in its pipeline", refunds.every((b) => b.some((c) => c[0] === "EXPIRE" && c[1] === b.find((d) => d[0] === "DECR")![1])), true);

  part("(v) A link that cannot be read is a 503 nobody keeps, never \"ended\"");
  reset();
  topOfHour();
  const unreadable = await make("g@example.com", "golf");
  before = (batch) => { if (batch.some((c) => c[0] === "GET" && String(c[1]) === `nl:slink:${unreadable}`)) throw new Error("connection reset"); };
  const failed = await open(unreadable);
  before = null;
  is("503, sent nowhere", [failed.status, failed.to], [503, null]);
  is("never kept by the CDN", failed.cache.includes("no-store"), true);

  // Rule 23 (9 November 2026, third pre-review): was "one store refusal a minute per instance stays off the hour; past it,
  // refusals are counted". A refusal of a store over its own requests is now counted in the resting hour every instance
  // shares, never the shared one, within SHORT_LINK_REST_UNPAID_PER_HOUR (tests/short-link-open-prerev3.test.ts).
  part("(vii) Added with the fix: a store over its own requests is refused off the shared hour, in the resting hour");
  reset();
  topOfHour();
  const tiredOne = await make("h@example.com", "hotel");
  const tiredTwo = await make("i@example.com", "india");
  inject = (batch) => (batch.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) ? batch.map((c) => (c[0] === "INCRBY" ? 1_000_000_000 : "OK")) : null);
  const hourKey = `nl:slink:open:${Math.floor(Date.now() / HOUR)}`;
  is("the first store's refusal", (await open(tiredOne)).status, 503);
  is("it is off the hour's count", Number((await redis.pipeline([["GET", hourKey]]))[0]), 0);
  is("a second store's refusal in the same minute", (await open(tiredTwo)).status, 503);
  inject = null;
  // Rule 23 (9 November 2026, third pre-review): was "it is counted in the hour, so the minute's company cost stays one
  // refusal" (1); both refusals are now in the resting hour, so the shared hour holds neither.
  is("it is off the shared hour too, and both are in the resting hour", [
    Number((await redis.pipeline([["GET", hourKey]]))[0]), Number((await redis.pipeline([["GET", `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`]]))[0]),
  ], [0, 2]);
  // Rule 23 (9 November 2026, third pre-review): was perInstance.restRefusalsPerMinute, restRefusalReads, restMarkSets and
  // restMarkMs ([1, 1, 1, 60_000]); the per-minute refusal is gone, and the resting hour is registered site-wide.
  is("the resting hour's ceiling is registered", [
    SHORT_LINK_UNPAID_COMPANY_COST.restPerHour, SHORT_LINK_UNPAID_COMPANY_COST.restRefusalReads, SHORT_LINK_UNPAID_COMPANY_COST.restMarkSets, SHORT_LINK_UNPAID_COMPANY_COST.restMarkMs,
  ], [SHORT_LINK_REST_UNPAID_PER_HOUR, 1, 1, 60_000]);

  part("(vi) The company's share is per instance; the number of instances is unknown, never zero");
  const held = SHORT_LINK_UNPAID_COMPANY_COST as unknown as Record<string, unknown>;
  is("instances held as unknown (null), not a figure", Object.hasOwn(held, "instances") && held.instances === null, true);
  is("not said to be for the whole site", /whole site/i.test(NOT_A_COST.SHORT_LINK_UNPAID_PER_HOUR ?? ""), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
