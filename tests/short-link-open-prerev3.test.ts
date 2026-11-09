/**
 * The third pre-review of claude5/short-link-open-cap2 (4224db357b, 9 November 2026), brought here as RED.
 *   A1 ALTO   a store over its own requests with 93 links, three different ones opened a minute, fills the shared
 *             hour with the first open of each link, and another store's paid link is refused.
 *   A2 ALTO   the same store's three links opened on 31 new instances fill the shared hour the same way.
 *   B  MÉDIO  twelve resting stores share one instance's single minute to be asked again, with no turn: a store that
 *             can answer again stays refused for more than 45 minutes, not the 10 the design gives.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { answering } from "./security/next-headers";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
let tiredFolders = new Set<string>();
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  return batch.map((c, i) => (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:") && [...tiredFolders].some((f) => String(c[1]).includes(f)) ? 1_000_000_000 : values[i]));
}) as typeof redis.pipeline;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = (ms: number) => { shift += ms; advance(ms); };
let n = 0;
const fresh = () => `198.51.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const open = async (code: string) => {
  const request = new Request(`https://marktmorgen.com/l/${code}?q=${n}`, { headers: { "x-forwarded-for": fresh() } });
  answering(request);
  try { const r = await GET(request as never, { params: Promise.resolve({ code }) }); return { status: r.status, to: r.headers.get("location"), text: r.status === 302 ? "" : await r.text() }; } finally { answering(null); }
};
async function store(email: string, handle: string) {
  if (!(await storeForEmail(email))) { await claimHandle(email, handle, handle, ""); await ensureStatsId(email); }
  const s = (await storeForEmail(email))!;
  return { s, folder: await storeFolder(email) };
}
async function link(s: { sid: string; statsId?: string }, name: string) {
  const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name, place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link " + name);
  return made.link.code;
}
const startOfHour = () => later(HOUR - (Date.now() % HOUR) + 1_000);
const hourCount = async () => Number((await redis.pipeline([["GET", `nl:slink:open:${Math.floor(Date.now() / HOUR)}`]]))[0]);

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
  done();
}
main();
