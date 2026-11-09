/**
 * Claude 2's cost focal re-review on #3330 @c6fec684f5 (comment 6742765950, 9 November 2026), brought here as RED:
 *   MEDIUM  a paying store past its opens in flight is let read on its hour's unpaid reads already finished, which a
 *           burst never raises in time: a store in the paying list, out of its own requests, no mark, 200 opens at once
 *           read its record 180 times, against the 20 of its own count; nothing counted those reads before them.
 * Every read past the store's own count must be counted before it, in a count with a ceiling (the resting hour every
 * instance shares, SHORT_LINK_REST_UNPAID_PER_HOUR, priced site-wide), and given back when the store pays for it.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { SHORT_LINK_PAID_FLIGHT_PER_STORE, SHORT_LINK_REST_UNPAID_PER_HOUR, SHORT_LINK_STORE_READS_PER_HOUR } from "@/lib/short-link-open-rules";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
let tiredFolders = new Set<string>();
let recordReads = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  if (batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:"))) recordReads += 1;
  const values = await real(batch);
  return batch.map((c, i) => (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:") && [...tiredFolders].some((f) => String(c[1]).includes(f)) ? 1_000_000_000 : values[i]));
}) as typeof redis.pipeline;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = (ms: number) => { shift += ms; };
let n = 0;
const fresh = () => `198.18.${Math.floor(n / 250) % 250}.${(n++ % 250) + 1}`;
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
  part("MEDIUM: a paying store out of its own requests, no mark, 200 opens at once");
  reset();
  const out = await payingStore("paidburst@example.com", "paidburst", "PaidBurst0001");
  tiredFolders.add(out.folder);
  recordReads = 0;
  const burst = await Promise.all([...out.codes, ...out.codes].map((c) => open(c)));
  const restUsed = await restHour();
  console.log(`  MEDIUM 200 at once: ${recordReads} record reads, resting hour ${restUsed}`);
  is("MEDIUM: every open is refused, sent nowhere", burst.every((r) => r.status === 503 && r.to === null), true);
  // Rule 23 (Claude 2's focal re-review @125a390e49): was "counted in the resting hour first: at most 20 + the resting hour's
  // figure" and "the resting hour holds every read past the store's own count"; that hour is shared, so a paying store's
  // reads past its opens in flight are now counted in a count of its own, SHORT_LINK_PAID_FLIGHT_PER_STORE at once, and the
  // resting hour every instance shares is left to stores that do not pay.
  is("MEDIUM: past its own count, every read was counted first in the store's own counts: at most 20 + SHORT_LINK_PAID_FLIGHT_PER_STORE", recordReads <= SHORT_LINK_STORE_READS_PER_HOUR + SHORT_LINK_PAID_FLIGHT_PER_STORE, true);
  // Added with the fix: the resting hour keeps every read past the store's own count, and a second burst in the hour reads nothing more.
  is("the store's hour holds every read it did not pay for", Number((await redis.pipeline([["GET", `nl:slink:rest:${out.s.sid}:cap:${Math.floor(Date.now() / HOUR)}`]]))[0]) >= recordReads, true);
  is("and the resting hour every instance shares holds no more than its own count's refusals", restUsed <= SHORT_LINK_STORE_READS_PER_HOUR, true);
  forgetShortLinkOpenMemory();
  const before = recordReads;
  await Promise.all(out.codes.map((c) => open(c)));
  is("a second burst in the same hour reads the record no more", recordReads - before, 0);

  part("MEDIUM: the same burst with the resting hour used reads the record at most the store's own counts");
  reset();
  const used = await payingStore("paidburst2@example.com", "paidbursttwo", "PaidBurst0002");
  tiredFolders.add(used.folder);
  await redis.pipeline([["SET", restHourKey(), String(SHORT_LINK_REST_UNPAID_PER_HOUR)], ["EXPIRE", restHourKey(), 7200]]);
  recordReads = 0;
  await Promise.all([...used.codes, ...used.codes].map((c) => open(c)));
  console.log(`  MEDIUM with the resting hour used: ${recordReads} record reads`);
  // Rule 23 (Claude 2's focal re-review @125a390e49): was "at most SHORT_LINK_STORE_READS_PER_HOUR record reads", the shared
  // resting hour holding the rest; the bound is now the store's own, whatever that hour holds.
  is("MEDIUM: at most SHORT_LINK_STORE_READS_PER_HOUR + SHORT_LINK_PAID_FLIGHT_PER_STORE record reads, the resting hour used or not", recordReads <= SHORT_LINK_STORE_READS_PER_HOUR + SHORT_LINK_PAID_FLIGHT_PER_STORE, true);

  part("A paying store with room still opens a burst past its opens in flight");
  reset();
  const busy = await payingStore("paidroom@example.com", "paidroom", "PaidRoom00001");
  const together = await Promise.all(busy.codes.slice(0, 60).map((c) => open(c)));
  is("60 opens at once all open", together.every((r) => r.status === 302), true);
  // Rule 23 (Claude 2's focal re-review @125a390e49): was "and the resting hour is given back what they reserved"; they
  // reserve in the store's own count now, given back the same way.
  is("and the resting hour is never used by them", await restHour(), 0);
  is("and the store's own paid reads in flight are given back", Number((await redis.pipeline([["ZCARD", `nl:slink:rest:${busy.s.sid}:paidflight`]]))[0]), 0);
  done();
}
main();
