/**
 * The third pre-review of claude5/short-link-open-cap2 (4224db357b, 9 November 2026), brought here as RED.
 *   A1 ALTO   a store over its own requests with 93 links, three different ones opened a minute, fills the shared
 *             hour with the first open of each link, and another store's paid link is refused.
 *   A2 ALTO   the same store's three links opened on 31 new instances fill the shared hour the same way.
 *   B  MÉDIO  twelve resting stores share one instance's single minute to be asked again, with no turn: a store that
 *             can answer again stays refused for more than 45 minutes, not the 10 the design gives.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { SHORT_LINK_REST_UNPAID_PER_HOUR, SHORT_LINK_TIRED_MAX_MS, SHORT_LINK_TIRED_MS, SHORT_LINK_UNPAID_PER_HOUR } from "@/lib/short-link-open-rules";
import { answering } from "./security/next-headers";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
let tiredFolders = new Set<string>();
const real = redis.pipeline.bind(redis);
let connectionOver = false;
redis.pipeline = (async (batch: Command[]) => {
  commands.push(...batch.map((c) => c.map(String)));
  const values = await real(batch);
  if (connectionOver && batch.some((c) => c[0] === "HINCRBY" && String(c[1]).startsWith("nl:traffic:c:"))) return [1_000_000_000, 1];
  return batch.map((c, i) => (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:") && [...tiredFolders].some((f) => String(c[1]).includes(f)) ? 1_000_000_000 : values[i]));
}) as typeof redis.pipeline;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = (ms: number) => { shift += ms; advance(ms); };
let n = 0;
const fresh = () => `198.51.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
let commands: string[][] = [];
const open = async (code: string, address = fresh()) => {
  const request = new Request(`https://marktmorgen.com/l/${code}?q=${n}`, { headers: { "x-forwarded-for": address } });
  answering(request);
  try {
    const r = await GET(request as never, { params: Promise.resolve({ code }) });
    return { status: r.status, to: r.headers.get("location"), text: r.status === 302 ? "" : await r.text(), retry: Number(r.headers.get("retry-after")), language: r.headers.get("content-language") };
  } finally { answering(null); }
};
async function store(email: string, handle: string) {
  if (!(await storeForEmail(email))) { await claimHandle(email, handle, handle, ""); await ensureStatsId(email); }
  const s = (await storeForEmail(email))!;
  return { s, folder: await storeFolder(email) };
}
async function link(s: { sid: string; statsId?: string | null }, name: string) {
  const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name, place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link " + name);
  return made.link.code;
}
const startOfHour = () => later(HOUR - (Date.now() % HOUR) + 1_000);
const hourCount = async () => Number((await redis.pipeline([["GET", `nl:slink:open:${Math.floor(Date.now() / HOUR)}`]]))[0] ?? 0);
const restCount = async () => Number((await redis.pipeline([["GET", `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`]]))[0]);

async function main() {
  part("A1 one store over its own requests, 93 links, 3 distinct opens a minute, pauses another store's link");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const t = await store("t@example.com", "tango");
  const codes: string[] = [];
  for (let i = 0; i < 93; i += 1) codes.push(await link(t.s, `l${i}`));
  const o = await store("o@example.com", "oscar");
  const other = await link(o.s, "reel");
  tiredFolders.add(t.folder);
  for (let m = 0; m < 31; m += 1) { for (let k = 0; k < 3; k += 1) await open(codes[m * 3 + k]); later(60_000); }
  console.log(`  A1 shared hour after the tired store's traffic: ${await hourCount()}`);
  const live = await open(other);
  is("A1: another store's link still opens", [live.status, live.to?.includes("/@oscar")], [302, true]);

  part("A2 one store over its own requests, 3 links, on 31 fresh instances, pauses another store's link");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const u = await store("u@example.com", "uniform");
  const ucodes = [await link(u.s, "a"), await link(u.s, "b"), await link(u.s, "c")];
  const p = await store("p@example.com", "papa");
  const pcode = await link(p.s, "reel");
  tiredFolders.add(u.folder);
  for (let i = 0; i < 31; i += 1) { forgetShortLinkOpenMemory(); for (const c of ucodes) await open(c); }
  console.log(`  A2 shared hour after 31 instances: ${await hourCount()}`);
  forgetShortLinkOpenMemory();
  const live2 = await open(pcode);
  is("A2: another store's link still opens", [live2.status, live2.to?.includes("/@papa")], [302, true]);

  part("B a store that can answer again stays refused while other resting stores take the instance's one minute");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const a = await store("a@example.com", "alpha");
  const acode = await link(a.s, "reel");
  is("B: the store opens while it can answer (it holds a free place)", (await open(acode)).status, 302);
  later(61_000);
  const bs: string[] = [];
  for (let i = 0; i < 12; i += 1) { const b = await store(`b${i}@example.com`, `bravo${i}`); bs.push(await link(b.s, "reel")); tiredFolders.add(b.folder); }
  tiredFolders.add(a.folder);
  for (const c of bs) await open(c);
  is("B: found resting", (await open(acode)).status, 503);
  tiredFolders.delete(a.folder); // the store can answer again (a new window, an upgrade)
  let firstOpen = -1;
  for (let m = 1; m <= 45 && firstOpen < 0; m += 1) {
    later(60_000);
    if (Date.now() % HOUR < 120_000) later(120_000); // stay off the hour's edge
    if (!process.env.CONTROL) for (const c of bs) await open(c);
    const r = await open(acode);
    if (process.env.CONTROL && m < 4) console.log("   m", m, r.status, r.text, Date.now() % HOUR);
    if (r.status === 302) firstOpen = m;
  }
  console.log(`  B minutes until the store that can answer again opens: ${firstOpen < 0 ? ">45" : firstOpen}`);
  is("B: it opens within the 10 minutes the design gives (SHORT_LINK_TIRED_MAX_MS)", firstOpen > 0 && firstOpen <= 11, true);

  // Everything below was added with the fix (9 November 2026).
  part("A resting store's opens are counted in the resting hour, within its figure, never in the shared one");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const v = await store("v@example.com", "victor");
  const vcodes: string[] = [];
  for (let i = 0; i < 5; i += 1) vcodes.push(await link(v.s, `v${i}`));
  tiredFolders.add(v.folder);
  for (const c of vcodes) await open(c);
  is("five first opens: the resting hour holds them, the shared hour none", [await restCount(), await hourCount()], [5, 0]);
  is("the figures: the resting hour has its own, larger than the shared one", SHORT_LINK_REST_UNPAID_PER_HOUR > SHORT_LINK_UNPAID_PER_HOUR, true);

  // Rule 23 (9 November 2026, Claude 2's first cost review of #3330, ALTO 2): was "Past the resting hour's figure, a resting
  // store's first opens go back to the shared hour", [503, 1] and [503, 2, false]: that spill let one store that cannot pay
  // fill the hour every other store's links need. Past it the open is now refused and never counted in the shared hour;
  // what the store reads past it is held by its resting mark, kept SHORT_LINK_TIRED_MAX_MS (priced per resting store in
  // tests/short-link-open-cap.test.ts).
  part("Past the resting hour's figure, a resting store's first opens are refused, never counted in the shared hour, and its mark is kept longer");
  await redis.pipeline([["SET", `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`, String(SHORT_LINK_REST_UNPAID_PER_HOUR)]]);
  const w1 = await link(v.s, "w1");
  const w2 = await link(v.s, "w2");
  is("one more first open past it: refused, and nothing in the shared hour", [(await open(w1)).status, await hourCount()], [503, 0]);
  commands = [];
  is("the next, with the resting hour known used here: nothing in the shared hour, nothing sent to the resting one", [
    (await open(w2)).status, await hourCount(), commands.some((c) => c[1]?.startsWith("nl:slink:tired:")),
  ], [503, 0, false]);

  part("The resting hour used, a store due to be asked again rests here until this instance counts again, nothing sent");
  later(SHORT_LINK_TIRED_MS + 1);
  commands = [];
  const usedRest = await open(vcodes[0]);
  const after = commands.length;
  commands = [];
  const quietRest = await open(vcodes[1]);
  is("asked once, refused, the resting hour still used", [usedRest.status, after > 0], [503, true]);
  is("then refused from memory, nothing sent, and told to come back when this instance counts again", [quietRest.status, commands.length, quietRest.retry > 0 && quietRest.retry <= 60], [503, 0, true]);

  // Added 9 November 2026 (Claude 2's first cost review, ALTO 2): what a resting store reads past the resting hour is held by
  // its mark, so the mark found past it is kept the longer time.
  part("A store found resting past the resting hour's figure keeps its mark the longer time, nothing in the shared hour");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const m = await store("m@example.com", "mike");
  const mcode = await link(m.s, "reel");
  tiredFolders.add(m.folder);
  await redis.pipeline([["SET", `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`, String(SHORT_LINK_REST_UNPAID_PER_HOUR)]]);
  is("found resting: refused, nothing in the shared hour", [(await open(mcode)).status, await hourCount()], [503, 0]);
  // Rule 23 (9 November 2026, Claude 2's focal return): the mark's TTL was the longer time itself; the mark now holds the
  // moment the store rests until and lives two hours, so the longer time is that moment, read from its value.
  // Rule 23 (9 November 2026, the owner's decision 14): was Number(mark); the mark of a store without a paid plan is now
  // "<until>:<since>", so the moment is its first part.
  const markUntil = Number(String((await redis.pipeline([["GET", `nl:slink:rest:${m.s.sid}`]]))[0]).split(":")[0]) - Date.now();
  is("its mark is kept the longer time, so its record is read at most once that long", markUntil > SHORT_LINK_TIRED_MS && markUntil <= SHORT_LINK_TIRED_MAX_MS, true);
  forgetShortLinkOpenMemory();
  commands = [];
  is("on a new instance it is refused on its mark, its record not read", [
    (await open(mcode)).status, commands.some((c) => c[0] === "GET" && c[1].startsWith("nl:store:") && !c[1].startsWith("nl:store:id:")),
  ], [503, false]);

  part("A refusal's Retry-After is the time it will really last");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const x = await store("x@example.com", "xray");
  const xcode = await link(x.s, "reel");
  tiredFolders.add(x.folder);
  const firstTired = await open(xcode);
  is("found resting: Retry-After is the minute it is kept", firstTired.retry, SHORT_LINK_TIRED_MS / 1000);
  later(20_000);
  is("20 seconds later, from memory: the 40 seconds left", (await open(xcode)).retry, 40);
  later(41_000);
  await open(xcode); // asked again, still resting: kept twice as long
  is("asked again and still resting: two minutes", (await open(xcode)).retry <= 2 * SHORT_LINK_TIRED_MS / 1000 && (await open(xcode)).retry > SHORT_LINK_TIRED_MS / 1000, true);
  is("never more than the longest it is kept", SHORT_LINK_TIRED_MAX_MS, 600_000);

  part("A refusal names its language, and spells out the time zone (WCAG 3.1.4)");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const yankee = await store("y@example.com", "yankee");
  const ycode = await link(yankee.s, "reel");
  const greedy = fresh();
  connectionOver = true;
  let told: Awaited<ReturnType<typeof open>> | null = null;
  for (let i = 0; i < 6 && !told; i += 1) { const r = await open(ycode, greedy); if (r.status === 429) told = r; }
  connectionOver = false;
  is("the connection's refusal is in US English, says Coordinated Universal Time, and promises nothing about other people", [
    told?.language, /UTC \(Coordinated Universal Time\)/.test(told?.text ?? ""), /other people/i.test(told?.text ?? ""),
  ], ["en-US", true, false]);
  is("the tired refusal names its language too", (tiredFolders.add(yankee.folder), forgetShortLinkOpenMemory(), (await open(ycode)).language), "en-US");

  part("A connection's refusal is forgotten when the store's window renews before the day ends");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  // 01:00 UTC, so the day has 23 hours left; the store's trial window ends in two hours.
  later(86_400_000 - (Date.now() % 86_400_000) + HOUR);
  const z = await store("z@example.com", "zulu");
  await setSubscription("z@example.com", { customerId: "cus_SloZulu00001", subscriptionId: "sub_SloZulu00001", active: true, tier: "pro", cycle: "month", trialEnds: Math.floor(Date.now() / 1000) + 2 * 3600, period: null });
  const zcode = await link((await storeForEmail("z@example.com"))!, "reel");
  const zgreedy = fresh();
  connectionOver = true;
  let zt: Awaited<ReturnType<typeof open>> | null = null;
  for (let i = 0; i < 6 && !zt; i += 1) { const r = await open(zcode, zgreedy); if (r.status === 429) zt = r; }
  connectionOver = false;
  is("told to come back when the window renews, two hours away, not the day's end", zt !== null && zt.retry <= 2 * 3600 && zt.retry > 3600, true);
  later(2 * HOUR + 1_000);
  commands = [];
  await open(zcode, zgreedy);
  is("once it renewed, the connection is asked again, not refused from memory", commands.length > 0, true);
  void z;
  done();
}
main();
