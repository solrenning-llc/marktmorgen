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
    return { status: r.status, to: r.headers.get("location") };
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
  is("P2: at most 9 waits and 16 commands", [pipelines <= 9, commands.length <= 16], [true, true]);

  part("P3 links paid here a moment ago and gone while the hour is used are read beyond every figure");
  reset();
  topOfHour();
  const codes: string[] = [];
  for (let i = 0; i < 40; i += 1) codes.push((await make("e@example.com", "echo", `l${i}`)).code);
  for (const c of codes) await open(c); // paid: each is now known on this instance
  for (let i = 0; i < 61; i += 1) await open(missing(i)); // the hour is used
  for (const c of codes) await redis.pipeline([["DEL", `nl:slink:${c}`]]); // the creator deletes the links
  commands = [];
  for (const c of codes) await open(c);
  const reads = commands.filter((c) => c[0] === "GET" && /^nl:slink:[a-z0-9]{6}$/i.test(c[1])).length;
  console.log(`  P3 link reads while the hour was used: ${reads}`);
  is("P3: no link is read while the hour is used, beyond what the registry holds", reads, 0);
  done();
}
main();
