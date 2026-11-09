/**
 * The owner's decision on #3330 (decision 14, 9 November 2026): the US$81.49 a month one resting store could cost the
 * company (its record read once a resting mark's time, plus every open in flight whenever it had no mark) is not
 * approved. Brought here as RED, one part for each point:
 *
 *   1  each store has its own ceiling on the opens of its links that read its record and that it does not pay for,
 *      counted before the read, from the first day, also in a cold burst before the store carries a resting mark;
 *      a store with room (paying) is never refused by it;
 *   2  a store without a paid plan that has rested 30 days has its links turned off: a short static answer (410,
 *      plain US English, kept by the CDN), with nothing of its record read;
 *   3  once it pays again its links work at once, and the studio is told they were turned off.
 */
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { MAX_LINKS } from "@/lib/short-link-rules";
import { answering } from "./security/next-headers";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortLinksOffNotice } from "@/components/short-links-off-notice";
import { shortLinksOffNotice } from "@/lib/short-link-rest";
import { PAYING_INDEX } from "@/lib/free-pool-rules";
import { SHORT_LINK_OFF_AFTER_MS, SHORT_LINK_STORE_READS_PER_HOUR } from "@/lib/short-link-open-rules";
import { SHORT_LINK_UNPAID_COMPANY_COST } from "./plan-cost-registry";

type Command = (string | number)[];
const HOUR = 3_600_000;
const DAY = 86_400_000;
// The owner's figures (decision 14): the ceiling chosen for each store an hour, and the days a store without a paid plan rests before its links turn off.
const STORE_CAP = 20;
const OFF_DAYS = 30;

let tiredFolders = new Set<string>();
let recordReads = 0;
let pipelines = 0;
let commandsSent = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  pipelines += 1;
  commandsSent += batch.length;
  if (batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:"))) recordReads += 1;
  const values = await real(batch);
  return batch.map((c, i) => (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:") && [...tiredFolders].some((f) => String(c[1]).includes(f)) ? 1_000_000_000 : values[i]));
}) as typeof redis.pipeline;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = (ms: number) => { shift += ms; advance(ms); };
let n = 0;
const fresh = () => `203.0.${Math.floor(n / 250) % 250}.${(n++ % 250) + 1}`;
const open = async (code: string, address = fresh()) => {
  const request = new Request(`https://marktmorgen.com/l/${code}?q=${n++}`, { headers: { "x-forwarded-for": address } });
  answering(request);
  try {
    const r = await GET(request as never, { params: Promise.resolve({ code }) });
    return {
      status: r.status, to: r.headers.get("location"), type: r.headers.get("content-type") ?? "", cache: r.headers.get("cache-control") ?? "",
      language: r.headers.get("content-language") ?? "", text: r.status === 302 ? "" : await r.text(),
    };
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
const startOfHour = () => later(HOUR - (Date.now() % HOUR) + 1_000);
const reset = () => { redis.clear(); forgetShortLinkOpenMemory(); tiredFolders = new Set(); startOfHour(); };
const sMaxAge = (cache: string) => Number(/s-maxage=(\d+)/.exec(cache)?.[1] ?? 0);

async function main() {
  part("1 (a): a resting store's cold burst reads its record at most its own ceiling's times");
  reset();
  const cold = await store("coldrest@example.com", "coldrest");
  const coldCodes: string[] = [];
  for (let i = 0; i < MAX_LINKS; i += 1) coldCodes.push(await link(cold.s, `c${i}`));
  tiredFolders.add(cold.folder);
  recordReads = 0;
  const burst = await Promise.all(coldCodes.map((c) => open(c)));
  console.log(`  1 (a) ${coldCodes.length} opens at once of a resting store with no mark: ${recordReads} record reads`);
  is("1 (a): every open is refused, sent nowhere", burst.every((r) => r.status === 503 && r.to === null), true);
  is(`1 (a): the record is read at most ${STORE_CAP} times`, recordReads <= STORE_CAP, true);

  part("1 (b): a resting store asked again every minute for most of an hour reads its record at most its ceiling's times");
  reset();
  const slow = await store("slowrest@example.com", "slowrest");
  const slowCode = await link(slow.s, "reel");
  tiredFolders.add(slow.folder);
  recordReads = 0;
  for (let i = 0; i < 55; i += 1) {
    forgetShortLinkOpenMemory();
    await open(slowCode);
    later(61_000);
  }
  console.log(`  1 (b) 55 opens a minute apart in one hour: ${recordReads} record reads`);
  is(`1 (b): the record is read at most ${STORE_CAP} times in the hour`, recordReads <= STORE_CAP, true);

  part("1 (c): a store with room is never refused by its ceiling");
  reset();
  const busy = await store("busypay@example.com", "busypay");
  const busyCodes: string[] = [];
  for (let i = 0; i < STORE_CAP; i += 1) busyCodes.push(await link(busy.s, `b${i}`));
  const together = await Promise.all(busyCodes.map((c) => open(c)));
  is(`1 (c): ${STORE_CAP} opens at once all open`, together.every((r) => r.status === 302), true);
  let opened = 0;
  for (let i = 0; i < 3 * STORE_CAP; i += 1) {
    forgetShortLinkOpenMemory();
    if ((await open(busyCodes[i % busyCodes.length])).status === 302) opened += 1;
  }
  is(`1 (c): ${3 * STORE_CAP} opens one after another in the hour all open`, opened, 3 * STORE_CAP);

  part("2: a store without a paid plan that rested 30 days has its links turned off, answered without its record");
  reset();
  const gone = await store("offrest@example.com", "offrest");
  const goneCode = await link(gone.s, "reel");
  const goneOther = await link(gone.s, "story");
  tiredFolders.add(gone.folder);
  is("2: found resting, refused", (await open(goneCode)).status, 503);
  later((OFF_DAYS - 1) * DAY);
  forgetShortLinkOpenMemory();
  is("2: after 29 days it is still resting, not turned off", (await open(goneCode)).status, 503);
  later(DAY + 60_000);
  forgetShortLinkOpenMemory();
  recordReads = 0;
  pipelines = 0;
  commandsSent = 0;
  const off = await open(goneOther);
  const offPipelines = pipelines;
  const offCommands = commandsSent;
  console.log(`  2 after ${OFF_DAYS} days: ${off.status}, ${off.type}, ${off.cache}, ${recordReads} record reads`);
  is("2: a 410 that sends nobody anywhere", [off.status, off.to], [410, null]);
  is("2: a short page in US English", [off.type.startsWith("text/html"), off.language, off.text.length < 2_000, /lang="en-US"/.test(off.text)], [true, "en-US", true, true]);
  is("2: it says in plain words the link is turned off", /turned off/i.test(off.text), true);
  is("2: kept by the CDN", /public/.test(off.cache) && sMaxAge(off.cache) > 0, true);
  is("2: its record is not read", recordReads, 0);
  // Added with the fix: the open answered as turned off is a resting store's lookup, priced in the registry with room.
  console.log(`  2 the open answered as turned off: ${offPipelines} pipelines and ${offCommands} commands`);
  const lookup = SHORT_LINK_UNPAID_COMPANY_COST.perRestingStore.restingLookup;
  is("2: it stays inside the resting store's lookup the registry prices", [offPipelines <= lookup.waits, offCommands <= lookup.commands], [true, true]);
  forgetShortLinkOpenMemory();
  recordReads = 0;
  for (let i = 0; i < 50; i += 1) await open(goneCode);
  is("2: fifty more opens read nothing of its record", recordReads, 0);

  part("2: a store that pays is never turned off, however long it rests");
  reset();
  const paid = await store("paidrest@example.com", "paidrest");
  const nowSeconds = Math.floor(Date.now() / 1000);
  await setSubscription("paidrest@example.com", {
    customerId: "cus_PaidRest00001", subscriptionId: "sub_PaidRest00001", active: true, tier: "pro", cycle: "year",
    period: { start: nowSeconds - 86_400, end: nowSeconds + 360 * 86_400, renews: true },
  });
  const paidCode = await link(paid.s, "reel");
  tiredFolders.add(paid.folder);
  is("2: a paying store over its own requests is refused", (await open(paidCode)).status, 503);
  later((OFF_DAYS + 1) * DAY);
  forgetShortLinkOpenMemory();
  is("2: 31 days later it is resting, never turned off", (await open(paidCode)).status, 503);

  part("3: once it pays again its links work at once, and the studio is told they were turned off");
  reset();
  const back = await store("backrest@example.com", "backrest");
  const backCode = await link(back.s, "reel");
  tiredFolders.add(back.folder);
  await open(backCode);
  later(OFF_DAYS * DAY + 60_000);
  forgetShortLinkOpenMemory();
  is("3: turned off", (await open(backCode)).status, 410);
  const paysAt = Date.now();
  const at = Math.floor(paysAt / 1000);
  await setSubscription("backrest@example.com", {
    customerId: "cus_BackRest00001", subscriptionId: "sub_BackRest00001", active: true, tier: "pro", cycle: "month",
    period: { start: at - 60, end: at + 30 * 86_400, renews: true },
  });
  tiredFolders = new Set();
  forgetShortLinkOpenMemory();
  const again = await open(backCode);
  is("3: the next open, on a fresh instance, opens the store", [again.status, again.to?.includes("/@backrest")], [302, true]);
  const [note] = await redis.pipeline([["GET", `nl:slink:rest:${back.s.sid}:back`]]);
  console.log(`  3 the studio's notice: ${String(note)}`);
  is("3: the studio's notice is kept, with when the links were turned off and when they came back", typeof note === "string" && /^\d{13,15}:\d{13,15}$/.test(note), true);

  // Added with the fix: the figures are the code's, the studio reads and draws the notice, and a store that pays when its
  // mark could not be taken away (the moment it paid did not reach the database) still opens at its next open.
  part("The figures, the studio's notice, and a store that pays without its mark taken away");
  is("the ceiling and the 30 days are the code's", [SHORT_LINK_STORE_READS_PER_HOUR, SHORT_LINK_OFF_AFTER_MS], [STORE_CAP, OFF_DAYS * DAY]);
  const shown = await shortLinksOffNotice(back.s.sid);
  is("the studio reads when they were turned off and when they came back", shown !== null && shown.backAt >= shown.offAt && Math.abs(shown.backAt - paysAt) < 5_000, true);
  const html = shown ? renderToStaticMarkup(createElement(ShortLinksOffNotice, shown)) : "";
  is("the studio says so in plain words, under a heading, with nothing to do", [/<h2[^>]*>Your short links were turned off for a while<\/h2>/.test(html), /work again/.test(html), /do not need to do anything/.test(html)], [true, true, true]);
  is("a store with no notice is told nothing", await shortLinksOffNotice(busy.s.sid), null);
  reset();
  const heal = await store("healrest@example.com", "healrest");
  const healCode = await link(heal.s, "reel");
  tiredFolders.add(heal.folder);
  await open(healCode);
  later(OFF_DAYS * DAY + 60_000);
  forgetShortLinkOpenMemory();
  is("turned off", (await open(healCode)).status, 410);
  tiredFolders = new Set();
  await redis.pipeline([["SADD", PAYING_INDEX, "healrest@example.com"]]);
  forgetShortLinkOpenMemory();
  const healed = await open(healCode);
  is("in the list of stores that pay, its next open reads it and opens", [healed.status, healed.to?.includes("/@healrest")], [302, true]);
  const [healNote] = await redis.pipeline([["GET", `nl:slink:rest:${heal.s.sid}:back`]]);
  is("and the studio's notice is kept then", typeof healNote === "string", true);
  forgetShortLinkOpenMemory();
  is("its mark is gone: the next open opens too", (await open(healCode)).status, 302);
  done();
}
main();
