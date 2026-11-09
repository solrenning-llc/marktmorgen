/**
 * The second pre-review of claude5/short-link-open-cap2 (5ea473f3d5, 9 November 2026), brought here as RED.
 *   P1 ALTO   a store over its own limit with TWO links (or two tired stores), each opened once a minute, plus one
 *             mistyped code, still pauses another store's link: past the instance's one refund a minute, the
 *             resting store's opens fill the shared hour.
 *   P2 MÉDIO  the heaviest unpaid open (a free store, the month's places taken, asked the first time this hour,
 *             the minute's refund used) sends more than the 9 waits / 16 commands it is priced at.
 *   P3 MÉDIO  while the hour is used, a link paid here a moment ago is read without a count; when it ends unpaid
 *             (link gone) the read is the company's, beyond the hour's 60 and beyond every per-instance figure of
 *             SHORT_LINK_UNPAID_COMPANY_COST.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { CODE_LETTERS } from "@/lib/short-link-rules";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { SHORT_LINK_KNOWN_UNPAID_PER_HOUR, SHORT_LINK_TIRED_MAX_MS, SHORT_LINK_TIRED_MS, SHORT_LINK_UNPAID_PER_HOUR, SHORT_LINK_UNPAID_READ_UNITS } from "@/lib/short-link-open-rules";
import { SHORT_LINK_UNPAID_COMPANY_COST } from "./plan-cost-registry";
import { calendarWindow } from "@/lib/allowance-window";
import { answering } from "./security/next-headers";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
let inject: ((batch: Command[], values: unknown[]) => unknown[] | null) | null = null;
let pipelines = 0;
let commands: string[][] = [];
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  pipelines += 1;
  commands.push(...batch.map((c) => c.map(String)));
  const values = await real(batch);
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
    return { status: r.status, to: r.headers.get("location"), text: r.status === 302 ? "" : await r.text() };
  } finally {
    answering(null);
  }
};
async function make(email: string, handle: string, name = "reel"): Promise<{ code: string; sid: string }> {
  if (!(await storeForEmail(email))) { await claimHandle(email, handle, handle, ""); await ensureStatsId(email); }
  const s = (await storeForEmail(email))!;
  const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name, place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link");
  return { code: made.link.code, sid: s.sid };
}
const missing = (i: number) => { let s = ""; let k = i + 99_991; for (let j = 0; j < 6; j += 1) { s += CODE_LETTERS[k % CODE_LETTERS.length]; k = Math.floor(k / CODE_LETTERS.length); } return s; };
const topOfHour = () => later(HOUR - (Date.now() % HOUR) + 1_000);
const reset = () => { redis.clear(); forgetShortLinkOpenMemory(); inject = null; };
const overLimit = (batch: Command[]) => (batch.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) ? batch.map((c) => (c[0] === "INCRBY" ? 1_000_000_000 : "OK")) : null);

async function main(): Promise<void> {
  part("P1 a resting store with three links, opened once a minute, and one mistyped code pause another store's link");
  reset();
  topOfHour();
  const one = await make("a@example.com", "alpha", "reel");
  const two = await make("a@example.com", "alpha", "story");
  const three = await make("a@example.com", "alpha", "bio");
  const other = await make("b@example.com", "bravo");
  inject = overLimit;
  for (let i = 0; i < 30; i += 1) { await open(one.code); await open(two.code); await open(three.code); later(60_001); }
  inject = null;
  await open("zzzzzz");
  const live = await open(other.code);
  is("P1: the other store's link still opens", [live.status, live.to?.includes("/@bravo")], [302, true]);

  part("P2 the heaviest unpaid open stays within the 9 waits and 16 commands it is priced at");
  reset();
  topOfHour();
  const free = await make("c@example.com", "charlie");
  const spare = await make("d@example.com", "delta");
  // The month's free places are all taken.
  await redis.pipeline([["SET", `nl:free:n:${calendarWindow(Date.now()).id}`, "1000000000"]]);
  // This instance's refund of the minute is used by another resting store's refusal first.
  inject = overLimit;
  await open(spare.code);
  inject = null;
  pipelines = 0; commands = [];
  const heavy = await open(free.code);
  console.log(`  P2 measured: status ${heavy.status}, ${pipelines} pipelines, ${commands.length} commands: ${commands.map((c) => c[0]).join(" ")}`);
  is("P2: refused 503", heavy.status, 503);
  // Rule 23 (9 November 2026, with the fix): was "at most 9 waits and 16 commands", the figure it was priced at then; the
  // price is now the registry's heaviestUnpaid (11 waits, 21 commands), which holds the heaviest measured with room.
  is("P2: within the waits and commands it is priced at", [pipelines <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits, commands.length <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands], [true, true]);

  part("P3 links paid here a moment ago and gone while the hour is used are read beyond every figure");
  reset();
  topOfHour();
  const codes: string[] = [];
  for (let i = 0; i < 40; i += 1) codes.push((await make("e@example.com", "echo", `l${i}`)).code);
  for (const c of codes) await open(c); // paid: each is now known on this instance
  // Rule 23 (9 November 2026, Claude 2's first cost review): was 61 codes nobody has; the shared hour is now counted in units
  // (SHORT_LINK_UNPAID_READ_UNITS for a store read, one for a lookup) and one address looks up only a few codes nobody has,
  // so the hour is set used directly, one unit past its figure.
  await redis.pipeline([["SET", `nl:slink:open:${Math.floor(Date.now() / HOUR)}`, String(SHORT_LINK_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS + 1)]]);
  await open(missing(0)); // this instance learns the hour is used
  for (const c of codes) await redis.pipeline([["DEL", `nl:slink:${c}`]]); // the creator deletes the links
  commands = [];
  for (const c of codes) await open(c);
  const reads = commands.filter((c) => c[0] === "GET" && /^nl:slink:[a-z0-9]{6}$/i.test(c[1])).length;
  console.log(`  P3 link reads while the hour was used: ${reads}`);
  // Rule 23 (9 November 2026, with the fix): was 0, what the registry held then; such reads are now counted in the shared
  // hour and allowed only up to SHORT_LINK_KNOWN_UNPAID_PER_HOUR past its figure (registered as knownPerHour).
  // Rule 23 (9 November 2026, Claude 2's first cost review): was reads <= SHORT_LINK_KNOWN_UNPAID_PER_HOUR; the allowance is
  // now in units, SHORT_LINK_UNPAID_READ_UNITS for each store read, and a link gone is one lookup, one unit.
  is("P3: links read while the hour is used stay within the registered figure", [reads <= SHORT_LINK_KNOWN_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS, SHORT_LINK_UNPAID_COMPANY_COST.knownPerHour], [true, SHORT_LINK_KNOWN_UNPAID_PER_HOUR]);
  // Added with the fix: every one of them was counted, and the shared count never passed the two figures together.
  const hourCount = Number((await redis.pipeline([["GET", `nl:slink:open:${Math.floor(Date.now() / HOUR)}`]]))[0]);
  // Rule 23 (9 November 2026, Claude 2's first cost review): was hourCount >= SHORT_LINK_UNPAID_PER_HOUR + reads; the hour is in units now.
  is("P3: the reads that ended unpaid are counted, and admitted only within the hour's two figures", reads > 0 && hourCount >= SHORT_LINK_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS + reads, true);

  // Everything below was added with the fix (9 November 2026).
  // Rule 23 (9 November 2026, third pre-review): the title said "asked again on the instance's minute"; it is now asked on its
  // own time, counted in the resting hour.
  part("A resting store's other links are refused from memory, nothing sent; asked again in the resting hour, later each time");
  reset();
  topOfHour();
  const golf = await make("g@example.com", "golf", "reel");
  const golf2 = await make("g@example.com", "golf", "story");
  commands = [];
  inject = overLimit;
  is("the store is found resting", (await open(golf.code)).status, 503);
  is("its other link, read once to learn its store, is refused without the store read again", [(await open(golf2.code)).status, commands.filter((c) => c[0] === "GET" && c[1] === `nl:store:id:${golf.sid}`).length], [503, 1]);
  commands = [];
  const quiet = [await open(golf.code), await open(golf2.code)];
  is("both links again: refused with nothing sent to the database", [quiet.map((r) => r.status), commands.length], [[503, 503], 0]);
  later(SHORT_LINK_TIRED_MS + 1);
  commands = [];
  await open(golf.code);
  // Rule 23 (9 November 2026, third pre-review): the words said "on this instance's minute"; the checks are unchanged.
  is("past its time it is asked again in the resting hour, off the shared one", [commands.some((c) => c[0] === "INCR" && c[1].startsWith("nl:slink:open:")), commands.some((c) => c[0] === "INCRBY")], [false, true]);
  later(SHORT_LINK_TIRED_MS + 1);
  commands = [];
  is("still resting, it is kept twice as long: a minute later nothing is sent", [(await open(golf2.code)).status, commands.length], [503, 0]);
  later(SHORT_LINK_TIRED_MAX_MS);
  inject = null;
  const back = await open(golf.code);
  is("once it can answer again, asked again, it opens", [back.status, back.to?.includes("/@golf")], [302, true]);
  // Rule 23 (9 November 2026, third pre-review): was 1, "only the first open of its second link, read once to learn its
  // store"; that open is now moved to the resting hour once its store is known, so the shared hour holds none.
  is("the hour's shared count holds none of its opens, not even the first of its second link", Number((await redis.pipeline([["GET", `nl:slink:open:${Math.floor(Date.now() / HOUR)}`]]))[0]), 0);

  // Rule 23 (9 November 2026, third pre-review): was "A store due to be asked again past the instance's minute stays resting
  // until the next minute, nothing sent". Each store is now asked on its own time (the third pre-review's B: one waiting store
  // never waits behind another), counted in the resting hour; the resting hour used is held in
  // tests/short-link-open-prerev3.test.ts.
  part("Two stores due to be asked again in the same minute are each asked on their own, off the shared hour");
  reset();
  topOfHour();
  const hotel = await make("h@example.com", "hotel");
  const india = await make("i@example.com", "india");
  inject = overLimit;
  await open(hotel.code);
  await open(india.code);
  later(SHORT_LINK_TIRED_MS + 1);
  const minuteStart = Date.now() - (Date.now() % 60_000);
  if (Date.now() - minuteStart > 50_000) later(60_000 - (Date.now() - minuteStart) + 1);
  await open(hotel.code);
  commands = [];
  // Rule 23 (9 November 2026, third pre-review): was "the other store, due too, is refused with nothing sent" ([503, 0]).
  is("the other store, due too, is asked on its own, in the resting hour", [
    (await open(india.code)).status, commands.some((c) => c[0] === "INCR" && c[1].startsWith("nl:slink:tired:")), commands.some((c) => c[0] === "INCR" && c[1].startsWith("nl:slink:open:")),
  ], [503, true, false]);
  inject = null;
  is("neither went into the shared hour beyond its first open", Number((await redis.pipeline([["GET", `nl:slink:open:${Math.floor(Date.now() / HOUR)}`]]))[0]) <= 1, true);

  part("A code found ended is answered as ended again from memory, nothing sent");
  reset();
  topOfHour();
  is("a code nobody has is told it ended", (await open("yyyyyy")).to?.endsWith("/l/ended"), true);
  commands = [];
  const again = await open("yyyyyy");
  is("asked again, from another network, it is told so with nothing sent", [again.to?.endsWith("/l/ended"), commands.length], [true, 0]);

  part("A connection over its share is refused the store's other links too, until the day ends, and told the hour in UTC");
  reset();
  topOfHour();
  const juliet = await make("j@example.com", "juliet", "reel");
  const juliet2 = await make("j@example.com", "juliet", "story");
  const greedy = fresh();
  inject = (batch) => (batch.some((c) => c[0] === "HINCRBY" && String(c[1]).startsWith("nl:traffic:c:")) ? [1_000_000_000, 1] : null);
  let told = "";
  for (let i = 0; i < 6 && !told; i += 1) { const r = await open(juliet.code, greedy, `?g=${i}`); if (r.status === 429) told = r.text; }
  inject = null;
  await open(juliet2.code, greedy, "?learn");
  commands = [];
  const sameNet = await open(juliet2.code, greedy, "?other");
  is("the store's other link, for that connection: 429 with nothing sent", [sameNet.status, commands.length], [429, 0]);
  is("it says the exact hour to try again, in UTC, in plain words", [/UTC/.test(told), /tomorrow/i.test(told), /Try again after/.test(told)], [true, false, true]);
  is("somebody else still opens it", (await open(juliet2.code)).status, 302);

  part("A paused hour says when to try again, without promising more");
  reset();
  topOfHour();
  // Rule 23 (9 November 2026, Claude 2's first cost review): was SHORT_LINK_UNPAID_PER_HOUR + 1 codes nobody has; the hour is
  // in units now and one address looks up only a few codes nobody has, so the hour is set used directly.
  await redis.pipeline([["SET", `nl:slink:open:${Math.floor(Date.now() / HOUR)}`, String(SHORT_LINK_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS + 1)]]);
  const paused = await open(missing(5_000));
  is("503 with the time to try again, and no promise of when it opens", [paused.status, /Try this link again after .* UTC/.test(paused.text), /opens again by/i.test(paused.text)], [503, true, false]);

  part("A store's record that cannot be read is refused, never called ended");
  for (const [name, reply] of [["an answer of the wrong length", [] as unknown[]], ["a record that does not parse", ["{not json"]]] as const) {
    reset();
    topOfHour();
    const kilo = await make("k@example.com", "kilo");
    let next = false;
    inject = (batch) => {
      if (next && batch.length === 1 && batch[0][0] === "GET") { next = false; return [...reply]; }
      if (batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:slink:rest:"))) next = true;
      return null;
    };
    const unread = await open(kilo.code);
    inject = null;
    is(`${name}: 503, sent nowhere`, [unread.status, unread.to], [503, null]);
  }
  reset();
  topOfHour();
  const lima = await make("l@example.com", "lima");
  await redis.pipeline([["DEL", `nl:store:id:${lima.sid}`]]);
  is("a store whose id answers nothing is gone: the link ended", (await open(lima.code)).to?.endsWith("/l/ended"), true);
  done();
}
main();
