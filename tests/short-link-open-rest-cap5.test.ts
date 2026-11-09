/**
 * Claude 2's focal on #3330 @39da7f44db (9 November 2026), LEVE 2, brought here as RED: a paying store's open refused
 * past its paid reads in flight (SHORT_LINK_PAID_FLIGHT_PER_STORE) was counted in no hour: each sent six pipelines and
 * nineteen commands, with no ceiling, so a burst of them was a cost nobody had a figure for. Every such refusal must
 * appear in a count, and past a figure of its own an hour the store's later bursts must stop reaching that path.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { SHORT_LINK_PAID_FLIGHT_PER_STORE, SHORT_LINK_STORE_READS_PER_HOUR } from "@/lib/short-link-open-rules";
import * as rules from "@/lib/short-link-open-rules";
import { SHORT_LINK_UNPAID_COMPANY_COST } from "./plan-cost-registry";
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
  const store = await payingStore("burstpay@example.com", "burstpay", "BurstPay00001");
  const twice = [...store.codes, ...store.codes];

  part("LEVE 2 (a): a paying store with room, 200 opens at once: the refusals past its paid reads in flight are counted");
  paidPlaces = [];
  const first = await Promise.all(twice.map((c) => open(c)));
  const opened = first.filter((r) => r.status === 302).length;
  const refused = first.length - opened;
  const pastFlight = paidPlaces.filter((x) => x > SHORT_LINK_PAID_FLIGHT_PER_STORE).length;
  const seen = await counted();
  console.log(`  LEVE 2 (a) ${opened} x 302, ${refused} refused, ${pastFlight} past the paid flight; counted in the hours ${seen}`);
  is("LEVE 2 (a): the store with room opens its 20 + 40 at once", opened >= SHORT_LINK_STORE_READS_PER_HOUR + SHORT_LINK_PAID_FLIGHT_PER_STORE, true);
  is("LEVE 2 (a): every refusal past the paid flight appears in a count", pastFlight > 0 && seen >= pastFlight, true);

  part("LEVE 2 (b): the same burst again on a new instance, a moment later: it no longer reaches the paid flight past its figure");
  forgetShortLinkOpenMemory();
  later(5_000);
  paidPlaces = [];
  const second = await Promise.all(twice.map((c) => open(c)));
  const pastAgain = paidPlaces.filter((x) => x > SHORT_LINK_PAID_FLIGHT_PER_STORE).length;
  console.log(`  LEVE 2 (b) ${second.filter((r) => r.status === 302).length} x 302, ${pastAgain} past the paid flight again`);
  is("LEVE 2 (b): no open of the second burst is refused past the paid flight (each costs its six pipelines)", pastAgain, 0);

  // Added with the fix (rule 23: the RED checks above keep their words and figures).
  part("LEVE 2 (c): the minute's mark past, the paying store opens its 60 at once again");
  later(61_000);
  forgetShortLinkOpenMemory();
  const check = await open(store.codes[0]);
  const third = await Promise.all(store.codes.slice(0, 60).map((c) => open(c)));
  console.log(`  LEVE 2 (c) the open that asks again ${check.status}; then ${third.filter((r) => r.status === 302).length} x 302 of 60`);
  is("LEVE 2 (c): asked again, it pays and its 60 open", [check.status, third.every((r) => r.status === 302)], [302, true]);

  part("LEVE 2 (d): one refusal past the paid flight, alone and past its hour's figure, measured against the registry");
  const fill = async (refusals: number) => {
    redis.clear();
    forgetShortLinkOpenMemory();
    later(HOUR - (Date.now() % HOUR) + 1_000);
    await payingStore(`measure${refusals}@example.com`, `measure${refusals}`, `Measure${String(refusals).padStart(6, "0")}`);
  };
  const measure = async (refusals: number) => {
    await fill(refusals);
    const s = (await storeForEmail(`measure${refusals}@example.com`))!;
    const codes = redis.keys().filter((k) => /^nl:slink:[a-z0-9]{6,}$/i.test(k)).map((k) => k.slice("nl:slink:".length));
    const t = Date.now();
    const batch: Command[] = [];
    for (let i = 0; i < SHORT_LINK_STORE_READS_PER_HOUR; i += 1) batch.push(["ZADD", rules.shortLinkStoreFlightKey(s.sid), t, `f${i}`]);
    for (let i = 0; i < SHORT_LINK_PAID_FLIGHT_PER_STORE; i += 1) batch.push(["ZADD", rules.shortLinkPaidFlightKey(s.sid), t, `p${i}`]);
    if (refusals > 0) batch.push(["SET", rules.shortLinkPaidRefusedKey(s.sid, t), String(refusals)]);
    await real(batch);
    pipelines = 0;
    commands = 0;
    paidPlaces = [];
    const r = await open(codes[0]);
    const mark = (await real([["GET", rules.shortLinkRestKey(s.sid)]]))[0];
    const own = Number((await real([["GET", rules.shortLinkPaidRefusedKey(s.sid, t)]]))[0] ?? 0);
    return { status: r.status, pipelines, commands, past: paidPlaces.some((x) => x > SHORT_LINK_PAID_FLIGHT_PER_STORE), mark, own };
  };
  const alone = await measure(0);
  const past = await measure(rules.SHORT_LINK_PAID_REFUSALS_PER_HOUR);
  const cost = SHORT_LINK_UNPAID_COMPANY_COST;
  console.log(`  LEVE 2 (d) alone: ${alone.status}, ${alone.pipelines} pipelines, ${alone.commands} commands, counted ${alone.own}; past its figure: ${past.status}, ${past.pipelines} pipelines, ${past.commands} commands, counted ${past.own}, marked ${past.mark !== null}`);
  is("LEVE 2 (d): alone, refused past the paid flight, counted once in its store's count, no mark", [alone.status, alone.past, alone.own, alone.mark], [503, true, 1, null]);
  is("LEVE 2 (d): alone, priced with room in the registry (two pipelines and four commands over the measured)", [
    cost.perRestingStore.paidRefusal.waits >= alone.pipelines + 2, cost.perRestingStore.paidRefusal.commands >= alone.commands + 4,
  ], [true, true]);
  is("LEVE 2 (d): past its figure, counted and the store marked resting a minute", [past.status, past.own, past.mark !== null], [503, rules.SHORT_LINK_PAID_REFUSALS_PER_HOUR + 1, true]);
  is("LEVE 2 (d): past its figure, inside the resting hour's price (the heaviest unpaid open)", [
    past.pipelines <= cost.heaviestUnpaid.waits, past.commands <= cost.heaviestUnpaid.commands,
  ], [true, true]);
  is("LEVE 2 (d): the registry holds the code's figure", cost.perRestingStore.paidRefusalsPerHour, rules.SHORT_LINK_PAID_REFUSALS_PER_HOUR);
  done();
}
main();
