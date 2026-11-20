/**
 * Claude 2's cost focal re-review on #3330 @125a390e49 (comment 6743192154, 9 November 2026), brought here as RED:
 *   MEDIUM  a paying store with room reserves each open past its 20 in flight in the resting hour every instance
 *           shares, which every refused open of a tired or free store fills too: one such store caps every other
 *           paying store at 20 opens at once for the rest of the hour (his three probes: 20 x 302 and 40 x 503).
 * No store may limit another: a paying store's reads past its opens in flight are reserved in a count of its own.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { SHORT_LINK_REST_UNPAID_PER_HOUR } from "@/lib/short-link-open-rules";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
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
const later = (ms: number) => { shift += ms; };
let n = 0;
const fresh = () => `198.19.${Math.floor(n / 250) % 250}.${(n++ % 250) + 1}`;
const open = async (code: string) => {
  const request = new Request(`https://marktmorgen.com/l/${code}?q=${n++}`, { headers: { "x-forwarded-for": fresh() } });
  answering(request);
  try {
    const r = await GET(request as never, { params: Promise.resolve({ code }) });
    return { status: r.status, to: r.headers.get("location") };
  } finally { answering(null); }
};
async function payingStore(email: string, handle: string, id: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  const at = Math.floor(Date.now() / 1000);
  await setSubscription(email, {
    customerId: `cus_${id}`, subscriptionId: `sub_${id}`, active: true, tier: "pro", cycle: "year",
    period: { start: at - 86_400, end: at + 360 * 86_400, renews: true },
  });
  const s = (await storeForEmail(email))!;
  const codes: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name: `r${i}`, place: "instagram", target: { kind: "store" } }, () => false, 1000);
    if (!made.ok) throw new Error("no link");
    codes.push(made.link.code);
  }
  return { s, folder: await storeFolder(email), codes };
}
const restHourKey = () => `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`;
const restHour = async () => Number((await redis.pipeline([["GET", restHourKey()]]))[0] ?? 0);
const reset = () => { redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set(); later(HOUR - (Date.now() % HOUR) + 1_000); };

async function main() {
  part("MEDIUM (a): the resting hour used, a paying store with room opens 60 at once");
  reset();
  const a = await payingStore("roomone@example.com", "roomone", "RoomOne000001");
  await redis.pipeline([["SET", restHourKey(), String(SHORT_LINK_REST_UNPAID_PER_HOUR)], ["EXPIRE", restHourKey(), 7200]]);
  const ra = await Promise.all(a.codes.slice(0, 60).map((c) => open(c)));
  console.log(`  MEDIUM (a) ${ra.filter((r) => r.status === 302).length} x 302, ${ra.filter((r) => r.status !== 302).length} refused`);
  is("MEDIUM (a): all 60 open", ra.every((r) => r.status === 302), true);

  part("MEDIUM (b): a tired paying store's burst, then another paying store with room, 60 at once");
  reset();
  const tired = await payingStore("tiredpay@example.com", "tiredpay", "TiredPay00001");
  const b = await payingStore("roomtwo@example.com", "roomtwo", "RoomTwo000001");
  tiredFolders.add(tired.folder);
  await Promise.all([...tired.codes, ...tired.codes].map((c) => open(c)));
  later(70_000);
  forgetShortLinkOpenMemory();
  const rb = await Promise.all(b.codes.slice(0, 60).map((c) => open(c)));
  console.log(`  MEDIUM (b) ${rb.filter((r) => r.status === 302).length} x 302, ${rb.filter((r) => r.status !== 302).length} refused`);
  is("MEDIUM (b): all 60 open", rb.every((r) => r.status === 302), true);

  part("MEDIUM (c): a free store's bursts fill the resting hour, then a paying store with room, 60 at once");
  reset();
  await claimHandle("freeburst@example.com", "freeburst", "freeburst", "");
  await ensureStatsId("freeburst@example.com");
  const f = (await storeForEmail("freeburst@example.com"))!;
  const fcodes: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const made = await addLink({ sid: f.sid, statsId: f.statsId! }, { name: `f${i}`, place: "instagram", target: { kind: "store" } }, () => false, 1000);
    if (made.ok) fcodes.push(made.link.code);
  }
  tiredFolders.add(await storeFolder("freeburst@example.com"));
  for (let round = 0; round < 3; round += 1) { forgetShortLinkOpenMemory(); await Promise.all(fcodes.map((c) => open(c))); later(61_000); }
  const c = await payingStore("roomthree@example.com", "roomthree", "RoomThree0001");
  forgetShortLinkOpenMemory();
  const rc = await Promise.all(c.codes.slice(0, 60).map((x) => open(x)));
  console.log(`  MEDIUM (c) resting hour ${await restHour()}; ${rc.filter((r) => r.status === 302).length} x 302, ${rc.filter((r) => r.status !== 302).length} refused`);
  is("MEDIUM (c): all 60 open", rc.every((r) => r.status === 302), true);
  done();
}
main();
