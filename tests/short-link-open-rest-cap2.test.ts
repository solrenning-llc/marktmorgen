/**
 * Claude 2's cost focal on #3330 @99ac6f3858 (comment 6742085039, 9 November 2026), brought here as RED:
 *   HIGH 1    past the store's own count with no mark, the store is not remembered resting: every later open repeats
 *             the lookup and the pipeline, and with the resting hour used nothing is counted (2,200 commands, 0 counted).
 *   MEDIUM 2  a store that pays, with room, is refused by its own count (60 at once: 40 refused), and give-backs that
 *             are lost hold the hour.
 *   MEDIUM 3  the 30 days count from the mark's age, not from 30 days of resting: one refusal and 30 days later a 410,
 *             which renews the mark; the page promises the link will work again, which no store can make true today.
 *   LOW 2     a list of paying stores that cannot be read turns a link off with a sentence that may be false.
 *   NIT       `later` moved the database's clock twice as fast as the test's.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const HOUR = 3_600_000;
const DAY = 86_400_000;
const STORE_CAP = 20;

let tiredFolders = new Set<string>();
let commandsSent = 0;
/** Pipelines that give a store's place back, made to fail (a give-back lost to a timeout). */
let loseGiveBacks = false;
let breakPayingList = false;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  commandsSent += batch.length;
  const givesBack = batch.length > 0 && batch.every((c) => ["DECR", "ZREM", "EXPIRE", "DEL"].includes(String(c[0])) && /^nl:slink:rest:[0-9a-f]{32}:/.test(String(c[1])));
  if (loseGiveBacks && givesBack) throw new Error("timeout");
  if (breakPayingList && batch.some((c) => c[0] === "SISMEMBER")) throw new Error("timeout");
  const values = await real(batch);
  return batch.map((c, i) => (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:") && [...tiredFolders].some((f) => String(c[1]).includes(f)) ? 1_000_000_000 : values[i]));
}) as typeof redis.pipeline;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
// The NIT: only the test's clock moves; the in-memory database reads Date.now itself.
const later = (ms: number) => { shift += ms; };
let n = 0;
const fresh = () => `192.0.${Math.floor(n / 250) % 250}.${(n++ % 250) + 1}`;
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
async function pays(email: string, id: string) {
  const at = Math.floor(Date.now() / 1000);
  await setSubscription(email, {
    customerId: `cus_${id}`, subscriptionId: `sub_${id}`, active: true, tier: "pro", cycle: "year",
    period: { start: at - 86_400, end: at + 360 * 86_400, renews: true },
  });
}
async function link(s: { sid: string; statsId?: string | null }, name: string) {
  const made = await addLink({ sid: s.sid, statsId: s.statsId! }, { name, place: "instagram", target: { kind: "store" } }, () => false, 1000);
  if (!made.ok) throw new Error("no link " + name);
  return made.link.code;
}
const startOfHour = () => later(HOUR - (Date.now() % HOUR) + 1_000);
const restHourKey = () => `nl:slink:tired:${Math.floor(Date.now() / HOUR)}`;
const reset = () => {
  redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set(); loseGiveBacks = false; breakPayingList = false; startOfHour();
};

async function main() {
  part("HIGH 1: past its own count with no mark, a store is refused from memory, nothing sent again, the resting hour used");
  reset();
  const lost = await store("lostplaces@example.com", "lostplaces");
  const lostCodes: string[] = [];
  for (let i = 0; i < STORE_CAP; i += 1) lostCodes.push(await link(lost.s, `l${i}`));
  loseGiveBacks = true;
  for (const c of lostCodes) await open(c);
  loseGiveBacks = false;
  await redis.pipeline([["SET", restHourKey(), "1000000"], ["EXPIRE", restHourKey(), 7200]]);
  forgetShortLinkOpenMemory();
  const first = await open(lostCodes[0]);
  commandsSent = 0;
  for (let i = 0; i < 200; i += 1) await open(lostCodes[i % lostCodes.length]);
  const firstRound = commandsSent;
  commandsSent = 0;
  for (let i = 0; i < 200; i += 1) await open(lostCodes[i % lostCodes.length]);
  console.log(`  HIGH 1 first open ${first.status}; the next 200 on the same instance: ${firstRound} commands, then 200 more: ${commandsSent}`);
  // Rule 23 (with the fix): was "200 opens send at most 20 commands"; each of the store's other links is looked up once on
  // this instance (its count in the shared hour, its GET, its refund: 5 commands), the priced lookup, and then never again.
  is("HIGH 1: past the first, each other link of that store is looked up once on the instance, at most 5 commands each", firstRound <= (STORE_CAP - 1) * 5, true);
  is("HIGH 1: and then the instance answers that store from memory: 200 more opens send nothing", commandsSent, 0);

  part("MEDIUM 2: a store that pays, with room, is never refused by its own count");
  reset();
  const paying = await store("payingbusy@example.com", "payingbusy");
  await pays("payingbusy@example.com", "PayingBusy0001");
  const payingCodes: string[] = [];
  for (let i = 0; i < 60; i += 1) payingCodes.push(await link(paying.s, `p${i}`));
  const together = await Promise.all(payingCodes.map((c) => open(c)));
  console.log(`  MEDIUM 2 60 at once: ${together.filter((r) => r.status === 302).length} opened, ${together.filter((r) => r.status !== 302).length} refused`);
  is("MEDIUM 2: 60 opens at once of a paying store all open", together.every((r) => r.status === 302), true);
  loseGiveBacks = true;
  for (let i = 0; i < 30; i += 1) { forgetShortLinkOpenMemory(); await open(payingCodes[i]); }
  loseGiveBacks = false;
  forgetShortLinkOpenMemory();
  const afterLost = await Promise.all(payingCodes.slice(0, 30).map((c) => open(c)));
  is("MEDIUM 2: after 30 give-backs lost, the paying store still opens", afterLost.every((r) => r.status === 302), true);

  part("MEDIUM 2: give-backs lost do not hold a store's hour");
  reset();
  const free = await store("freelost@example.com", "freelost");
  const freeCode = await link(free.s, "reel");
  loseGiveBacks = true;
  for (let i = 0; i < 2 * STORE_CAP; i += 1) { forgetShortLinkOpenMemory(); await open(freeCode); }
  loseGiveBacks = false;
  later(5 * 60_000);
  forgetShortLinkOpenMemory();
  is("MEDIUM 2: five minutes later, in the same hour, the store's link opens", (await open(freeCode)).status, 302);

  part("MEDIUM 3: one refusal, then 30 days with room, is not 30 days of resting");
  reset();
  const once = await store("oncerest@example.com", "oncerest");
  const onceCode = await link(once.s, "reel");
  tiredFolders.add(once.folder);
  is("refused once", (await open(onceCode)).status, 503);
  tiredFolders = new Set();
  later(30 * DAY + 60_000);
  forgetShortLinkOpenMemory();
  is("MEDIUM 3: 30 days later, with room, the link opens", (await open(onceCode)).status, 302);

  part("MEDIUM 3: 30 days of resting, opened twice a day, turn the links off; the page promises nothing it cannot keep");
  reset();
  const long = await store("longrest@example.com", "longrest");
  const longCode = await link(long.s, "reel");
  tiredFolders.add(long.folder);
  let last = await open(longCode);
  for (let h = 0; h < 31 * 2; h += 1) {
    later(12 * HOUR);
    forgetShortLinkOpenMemory();
    last = await open(longCode);
  }
  is("MEDIUM 3: after 31 days of resting it is turned off", last.status, 410);
  is("MEDIUM 3: the page does not promise the link will work again", /as soon as|will work again/i.test(last.text), false);

  part("MEDIUM 3: a 410 does not keep the store turned off once it has room");
  tiredFolders = new Set();
  const answers: number[] = [];
  for (let h = 0; h < 30; h += 1) {
    later(2 * HOUR);
    forgetShortLinkOpenMemory();
    answers.push((await open(longCode)).status);
  }
  console.log(`  MEDIUM 3 with room again, every two hours: ${answers.join(" ")}`);
  is("MEDIUM 3: within a day and a half the link opens again", answers.at(-1), 302);

  part("LOW 2: a list of paying stores that cannot be read never turns a link off");
  reset();
  const blind = await store("blindrest@example.com", "blindrest");
  const blindCode = await link(blind.s, "reel");
  tiredFolders.add(blind.folder);
  await open(blindCode);
  for (let h = 0; h < 31 * 2; h += 1) { later(12 * HOUR); forgetShortLinkOpenMemory(); await open(blindCode); }
  forgetShortLinkOpenMemory();
  breakPayingList = true;
  const blindAnswer = await open(blindCode);
  breakPayingList = false;
  is("LOW 2: refused as unknown, not as turned off", blindAnswer.status, 503);
  done();
}
main();
