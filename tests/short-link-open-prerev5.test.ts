/**
 * Claude 2's focal cost return on #3330 (b9692c8b74, 9 November 2026, comment 6733188785), brought here as RED.
 *   ALTO 1  the per-address cap on codes nobody has is checked before the count's await and raised only after the
 *           lookup, so a concurrent burst from one address passes it (40 at once: 30 looked up, not 10), and 6
 *           addresses take another store's cold link down; and a code refused for a connection over its share keeps
 *           its lookup unit without counting toward the cap, so 7 such addresses do the same.
 *   MEDIO   past the resting hour, a resting store's record is read by every open in flight when its mark has
 *           just expired, in no count: 100 concurrent opens read it 100 times, six bursts in the hour 600 times,
 *           against the 60 an hour the registry prices.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { CODE_LETTERS, MAX_LINKS } from "@/lib/short-link-rules";
import { SHORT_LINK_MISSES_PER_ADDRESS, SHORT_LINK_UNPAID_READ_UNITS } from "@/lib/short-link-open-rules";
import { SHORT_LINK_UNPAID_COMPANY_COST } from "./plan-cost-registry";
import { answering } from "./security/next-headers";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
let tiredFolders = new Set<string>();
let overShare = false;
let recordReads = 0;
let pipelines = 0;
let commandsSent = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  pipelines += 1;
  commandsSent += batch.length;
  if (batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:"))) recordReads += 1;
  const values = await real(batch);
  if (overShare && batch.some((c) => c[0] === "HINCRBY" && String(c[1]).startsWith("nl:traffic:c:"))) return [1_000_000_000, 1];
  return batch.map((c, i) => (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:") && [...tiredFolders].some((f) => String(c[1]).includes(f)) ? 1_000_000_000 : values[i]));
}) as typeof redis.pipeline;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = (ms: number) => { shift += ms; advance(ms); };
let n = 0;
const fresh = () => `198.51.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const open = async (code: string, address = fresh()) => {
  const request = new Request(`https://marktmorgen.com/l/${code}?q=${n++}`, { headers: { "x-forwarded-for": address } });
  answering(request);
  try {
    const r = await GET(request as never, { params: Promise.resolve({ code }) });
    return { status: r.status, to: r.headers.get("location"), text: r.status === 302 ? "" : await r.text() };
  } finally { answering(null); }
};
async function store(email: string, handle: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  const s = (await storeForEmail(email))!;
  return { s, folder: await storeFolder(email) };
}
async function link(s: { sid: string; statsId?: string | null }, name: string) {
  const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name, place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link " + name);
  return made.link.code;
}
const codeOf = (i: number) => {
  let code = "";
  let k = i;
  for (let j = 0; j < 6; j += 1) { code += CODE_LETTERS[k % CODE_LETTERS.length]; k = Math.floor(k / CODE_LETTERS.length); }
  return code;
};
const startOfHour = () => later(HOUR - (Date.now() % HOUR) + 1_000);
const hourKey = () => `nl:slink:open:${Math.floor(Date.now() / HOUR)}`;
const restHourKey = () => `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`;
const hourCount = async () => Number((await redis.pipeline([["GET", hourKey()]]))[0] ?? 0);
const reset = () => { redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set(); overShare = false; startOfHour(); };

async function main() {
  part("ALTO 1 (a): a burst from one address looks up no more codes nobody has than its cap");
  reset();
  const prober = fresh();
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => open(codeOf(1_000 + i), prober)));
  const lookedUp = await hourCount();
  console.log(`  ALTO 1 (a) 40 at once from one address: ${burst.filter((r) => r.status === 302).length} answered as ended, shared hour ${lookedUp}`);
  is("ALTO 1 (a): one address's burst of 40 is looked up at most SHORT_LINK_MISSES_PER_ADDRESS times", lookedUp <= SHORT_LINK_MISSES_PER_ADDRESS, true);
  is("ALTO 1 (a): the rest are refused, sent nowhere", burst.filter((r) => r.status !== 302).every((r) => r.to === null), true);

  part("ALTO 1 (b): 6 addresses, one burst each, do not take another store's cold link down");
  reset();
  const v = await store("victim5@example.com", "victimfive");
  const victim = await link(v.s, "reel");
  for (let a = 0; a < 6; a += 1) {
    const address = fresh();
    await Promise.all(Array.from({ length: 40 }, (_, i) => open(codeOf(2_000 + a * 40 + i), address)));
  }
  console.log(`  ALTO 1 (b) shared hour after 6 bursts: ${await hourCount()}`);
  forgetShortLinkOpenMemory();
  is("ALTO 1 (b): the victim's never-opened link opens on a fresh instance", (await open(victim)).status, 302);

  part("ALTO 1 (c): links refused for a connection over its share count toward that address's cap");
  reset();
  const g = await store("greedy5@example.com", "greedyfive");
  const gcodes: string[] = [];
  for (let i = 0; i < 30; i += 1) gcodes.push(await link(g.s, `g${i}`));
  overShare = true;
  const greedy = fresh();
  let counted = 0;
  let misses = 0;
  for (const c of gcodes) {
    const before = await hourCount();
    const r = await open(c, greedy);
    if ((await hourCount()) > before) counted += 1;
    if (r.status === 429 && /do not exist/.test(r.text)) misses += 1;
  }
  console.log(`  ALTO 1 (c) opens that left units in the shared hour: ${counted}, refused as too many: ${misses}, shared hour ${await hourCount()}`);
  is("ALTO 1 (c): at most SHORT_LINK_MISSES_PER_ADDRESS of that address's opens leave units in the shared hour", counted <= SHORT_LINK_MISSES_PER_ADDRESS, true);
  is("ALTO 1 (c): past them the address is told so, nothing counted", misses > 0, true);
  is("ALTO 1 (c): the shared hour holds at most the cap's units for that address", (await hourCount()) <= SHORT_LINK_MISSES_PER_ADDRESS * (1 + SHORT_LINK_UNPAID_READ_UNITS), true);

  part("MEDIO: past the resting hour, a resting store's record is read once a mark's time, not by every open in flight");
  reset();
  const t = await store("resting5@example.com", "restingfive");
  const codes: string[] = [];
  for (let i = 0; i < MAX_LINKS; i += 1) codes.push(await link(t.s, `r${i}`));
  tiredFolders.add(t.folder);
  await redis.pipeline([["SET", restHourKey(), "1000000"], ["EXPIRE", restHourKey(), 7200]]);
  recordReads = 0;
  const reads: number[] = [];
  for (let b = 0; b < 6; b += 1) {
    forgetShortLinkOpenMemory();
    const before = recordReads;
    const answers = await Promise.all(codes.map((c) => open(c)));
    reads.push(recordReads - before);
    if (b === 0) is("MEDIO: every open of the resting store is refused, sent nowhere", answers.every((r) => r.status === 503 && r.to === null), true);
    later(601_000);
  }
  console.log(`  MEDIO record reads per burst: ${reads.join(", ")} (total ${recordReads}); shared hour ${await hourCount()}`);
  is("MEDIO: each burst after the first reads the record at most once", reads.slice(1).every((r) => r <= 1), true);
  const priced = SHORT_LINK_UNPAID_COMPANY_COST.perRestingStore as unknown as Record<string, number>;
  const bound = (priced.storeReadsPerHour ?? 0) + (priced.coldReadsPerLapse ?? 0);
  is("MEDIO: what the hour read stays inside what the registry prices for one resting store", recordReads <= bound && Number.isFinite(bound), true);
  is("MEDIO: the shared hour is left as it was", await hourCount(), 0);

  // Added with the fix: the one open that takes the check and finds the store still resting stays inside the heaviest priced.
  pipelines = 0; commandsSent = 0;
  const still = await open(codes[0]);
  is("the due open that takes the check and finds the store still resting: refused, inside the heaviest unpaid open priced", [still.status, pipelines <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits, commandsSent <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands], [503, true, true]);
  console.log(`  MEDIO the check that finds the store resting: ${pipelines} pipelines and ${commandsSent} commands`);

  part("MEDIO: a store that pays again opens at once once one open finds it so");
  later(601_000);
  tiredFolders = new Set();
  forgetShortLinkOpenMemory();
  pipelines = 0; commandsSent = 0;
  const back = await open(codes[1]);
  is("the open that is due reads the store, finds it paying and opens", [back.status, back.to?.includes("/@restingfive")], [302, true]);
  console.log(`  MEDIO the check that finds the store paying: ${pipelines} pipelines and ${commandsSent} commands`);
  is("that open stays inside the heaviest unpaid open priced", [pipelines <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.waits, commandsSent <= SHORT_LINK_UNPAID_COMPANY_COST.heaviestUnpaid.commands], [true, true]);
  forgetShortLinkOpenMemory();
  const readsBefore = recordReads;
  const also = await Promise.all(codes.slice(2, 12).map((c) => open(c)));
  is("its other links open on a fresh instance, all at once", also.every((r) => r.status === 302), true);
  is("each of them read the store (paid by the store)", recordReads - readsBefore, 10);
  done();
}
main();
