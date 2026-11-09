/**
 * Claude 2's first cost review of #3330 (10980451d4, 9 November 2026, comment 6732658982), brought here as RED.
 *   ALTO 1  61 codes nobody has, opened from 3 addresses, take every short link of the site down until the hour
 *           ends, with no store involved: a paid link's read waits on the shared unpaid hour, which strangers fill.
 *   ALTO 2  one store over its own requests, its 100 links opened on 2 instances, passes the resting hour, spills
 *           into the shared hour and another store's link is refused: the defect the PR says it fixes.
 *   LEVE    the "hour" refusal says "try again after now + 1 minute" and sends Retry-After 60, but the link stays
 *           refused until the hour ends (VR item 2: nothing untrue told to the visitor).
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { CODE_LETTERS, MAX_LINKS } from "@/lib/short-link-rules";
import { statusTime } from "@/lib/status-page";
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
const fresh = () => `203.0.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const open = async (code: string, address = fresh()) => {
  const request = new Request(`https://marktmorgen.com/l/${code}?q=${n++}`, { headers: { "x-forwarded-for": address } });
  answering(request);
  try {
    const r = await GET(request as never, { params: Promise.resolve({ code }) });
    return { status: r.status, to: r.headers.get("location"), text: r.status === 302 ? "" : await r.text(), retry: Number(r.headers.get("retry-after")) };
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
const hourCount = async () => Number((await redis.pipeline([["GET", hourKey()]]))[0] ?? 0);
const restCount = async () => Number((await redis.pipeline([["GET", `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`]]))[0] ?? 0);

async function main() {
  part("ALTO 1: 61 codes nobody has, from 3 addresses, do not take another store's link down");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const v = await store("victim@example.com", "victim");
  const victim = await link(v.s, "reel");
  is("the victim's link opens", (await open(victim)).status, 302);
  const attackers = [fresh(), fresh(), fresh()];
  for (let i = 0; i < 61; i += 1) await open(codeOf(i + 7), attackers[i % 3]);
  console.log(`  ALTO 1 shared hour after 61 codes nobody has: ${await hourCount()}`);
  later(61_000);
  is("ALTO 1: the victim's link opens on the same instance at +61 s", (await open(victim)).status, 302);
  forgetShortLinkOpenMemory();
  is("ALTO 1: the victim's link opens on a fresh instance", (await open(victim)).status, 302);
  for (const minute of [11, 21, 31, 41, 51]) {
    later(10 * 60_000 - (minute === 11 ? 61_000 : 0));
    forgetShortLinkOpenMemory();
    is(`ALTO 1: the victim's link opens on a fresh instance at +${minute} min`, (await open(victim)).status, 302);
  }

  part("ALTO 2: one store over its own requests, its 100 links opened on 2 instances, does not take another store's link down");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  const t = await store("tired@example.com", "tired");
  const codes: string[] = [];
  for (let i = 0; i < MAX_LINKS; i += 1) codes.push(await link(t.s, `l${i}`));
  const o = await store("other@example.com", "other");
  const other = await link(o.s, "reel");
  tiredFolders.add(t.folder);
  for (let instance = 0; instance < 2; instance += 1) {
    forgetShortLinkOpenMemory();
    for (const c of codes) await open(c);
  }
  const shared = await hourCount();
  console.log(`  ALTO 2 resting hour ${await restCount()}, shared hour ${shared}`);
  is("ALTO 2: the resting store's opens never land in the shared hour", shared, 0);
  forgetShortLinkOpenMemory();
  const live = await open(other);
  is("ALTO 2: another store's never-opened link opens on a fresh instance", [live.status, live.to?.includes("/@other")], [302, true]);

  part("LEVE: the hour's refusal says when it really ends, and Retry-After matches it");
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set();
  startOfHour();
  later(10 * 60_000);
  await redis.pipeline([["SET", hourKey(), "1000000"], ["EXPIRE", hourKey(), 7200]]);
  const end = (Math.floor(Date.now() / HOUR) + 1) * HOUR;
  const refused = await open(codeOf(99_999));
  is("LEVE: refused for the hour", refused.status, 503);
  is("LEVE: Retry-After runs to the hour's end", Math.abs(refused.retry - (end - Date.now()) / 1000) <= 2, true);
  is("LEVE: the text names the hour's end", refused.text.includes(statusTime(end)), true);
  done();
}
main();
