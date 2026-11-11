/**
 * Claude 2's focal on #3330 @f6b792b9c3 (6748493951, MÉDIO, confirmed by Claude 1 in 6787702956), brought here as RED:
 * a paying store with requests left, refused past its paid reads in flight more than SHORT_LINK_PAID_REFUSALS_PER_HOUR
 * times in an hour, was sent down the path built for stores that cannot pay (restRefused): its wait doubled on the
 * instance that carried the burst, each of its links was remembered as resting for a day, and every refusal was counted
 * in the resting hour every resting store shares. So on that instance the store stayed refused while it paid for every
 * read, and its burst filled an hour other stores need. Past the figure it must pause on its own, a minute, counted in
 * no shared hour, and open again on the same instance once the minute is past.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import * as rules from "@/lib/short-link-open-rules";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
// Every paid-burst place taken (ZADD on a store's paid reads in flight), and how many were in flight with it (ZCARD).
let paidPlaces: number[] = [];
let pipelines = 0;
let commands = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  pipelines += 1;
  commands += batch.length;
  const values = await real(batch);
  batch.forEach((c, i) => {
    if (c[0] === "ZCARD" && /^nl:slink:rest:[0-9a-f]{32}:paidflight$/.test(String(c[1]))) paidPlaces.push(Number(values[i]));
  });
  return values;
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
    return { status: r.status };
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
    const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name: `b${i}`, place: "instagram", target: { kind: "store" } }, () => false, 1000);
    if (!made.ok) throw new Error("no link");
    codes.push(made.link.code);
  }
  return { s, codes };
}
/**
 * Every count of an hour the short links keep (a key that ends in its hour's number), their values summed, but the
 * shared hour: a burst of 200 at once holds 20 units there of opens refused before their code is looked up (past its
 * 180 units), which are not these.
 */
async function counted(): Promise<number> {
  const keys = redis.keys().filter((k) => k.startsWith("nl:slink:") && !k.startsWith("nl:slink:open:") && /:[0-9]{6,}$/.test(k));
  let sum = 0;
  for (const k of keys) {
    const v = (await redis.pipeline([["GET", k]]))[0];
    if (typeof v === "string" && /^-?[0-9]+$/.test(v)) sum += Number(v);
  }
  return sum;
}

async function main() {
  redis.clear();
  forgetShortLinkOpenMemory();
  later(HOUR - (Date.now() % HOUR) + 1_000);
  const store = await payingStore("viralpay@example.com", "viralpay", "ViralPay00001");
  const twice = [...store.codes, ...store.codes];
  const restHour = async () => Number((await real([["GET", rules.shortLinkRestHourKey(Date.now())]]))[0] ?? 0);

  part("a paying store with room, two bursts of 200 at once on one instance: refused past its flight, then paused on its own");
  const before = await restHour();
  const first = await Promise.all(twice.map((c) => open(c)));
  later(2_000);
  const second = await Promise.all(twice.map((c) => open(c)));
  const refusedOwn = Number((await real([["GET", rules.shortLinkPaidRefusedKey(store.s.sid, Date.now())]]))[0] ?? 0);
  console.log(`  bursts: ${first.filter((r) => r.status === 302).length} and ${second.filter((r) => r.status === 302).length} x 302; refused past the flight ${refusedOwn}; resting hour ${before} -> ${await restHour()}`);
  is("the test's own premise: more refusals past the paid flight than the hour's figure", refusedOwn > rules.SHORT_LINK_PAID_REFUSALS_PER_HOUR, true);
  is("the burst moves nothing in the resting hour every resting store shares", await restHour(), before);

  part("the same instance, a minute and a second later: the paying store opens again, its wait not doubled");
  later(61_000);
  const asking = await open(store.codes[0]);
  const after = await Promise.all(store.codes.slice(1, 11).map((c) => open(c)));
  console.log(`  +63 s: the open that asks ${asking.status}; then ${after.filter((r) => r.status === 302).length} x 302 of 10`);
  is("+63 s on the same instance: the asking open and all 10 open", [asking.status, after.every((r) => r.status === 302)], [302, true]);
  later(11 * 60_000);
  const much = await Promise.all(store.codes.slice(20, 25).map((c) => open(c)));
  is("+11 min on the same instance: 5 of 5 open", much.every((r) => r.status === 302), true);
  is("and the resting hour is still not moved by it", await restHour(), before);
  done();
}
main();
