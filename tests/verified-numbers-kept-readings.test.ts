/**
 * The shared numbers are built from the studio's kept readings, never read past them (row 139 of #5010).
 *
 * refreshVerified read ninety days of counts (readStats) and every page of sales (readSales) itself, with no reading of
 * the store's day taken: about sixty studio requests' worth each time, unpriced, from POST /api/store/kit, from
 * POST /api/store/numbers-links and from the daily pass, and nothing bounded how often a failed refresh came back. It
 * now builds the record from lib/store-readings.ts:
 * - from the studio (a kit save that first shows counted numbers, a numbers link made), a fresh copy is reused and
 *   otherwise one of the day's readings is taken first, priced in the store-readings line; with the day's readings
 *   used and no copy, no record is kept and nothing is read;
 * - the daily pass reuses a kept copy and otherwise reads for itself, priced in its own line (verified-numbers,
 *   coordinator 606b): it never takes one of the creator's readings of the day. The record carries the day it was read.
 * The studio's whole request that saves the kit stays inside the studio unit and VERIFIED_RECORD_EXTRA_COMMANDS more,
 * priced in the verified-numbers line with the pass's own readings (coordinators 964c and 606b).
 * Synthetic stores; in-memory Redis; Stripe answers an empty list.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as kitPost } from "@/app/api/store/kit/route";
import { POST as linksPost } from "@/app/api/store/numbers-links/route";
import { makeLink } from "@/lib/numbers-links";
import { addNumbersLink, addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { STORE_READINGS_PER_DAY, keptSales, keptStats } from "@/lib/store-readings";
import { readVerified, recordNumbers, refreshVerified, sendVerified, verifiedFrom } from "@/lib/verified-numbers";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, VERIFIED_RECORD_EXTRA_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_verified_kept_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "verified-kept@example.test";
const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = "2026-11-22";

async function liveStore(): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, "verifiedkept", "Fictional Verified", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_verifiedkept1", subscriptionId: "sub_verifiedkept1", active: true, tier: "creator", period: paidPeriod() });
  const made = makeLink({ label: "Partner", password: "verified-2026", days: 7, money: false }, NOW);
  if (!made.ok) throw new Error("no link");
  await addNumbersLink(OWNER, made.link, NOW);
  return (await storeForEmail(OWNER))!;
}
// The day's readings counted on NOW's day and on the real day the pass and the route run, so a reading taken on either shows.
const readingsTaken = (store: Store) => [DAY, new Date().toISOString().slice(0, 10)].filter((d, i, all) => all.indexOf(d) === i)
  .reduce((sum, d) => sum + Number(redis.run(["GET", `nl:reading:day:${store.statsId}:${d}`]) ?? 0), 0);
const recordKept = (store: Store) => Number(redis.run(["EXISTS", `nl:verified:${store.statsId}`]));

/** Every command a step sends, billed as Upstash bills a script (one, plus each redis.call in its text). */
async function billed<T>(work: () => Promise<T>): Promise<{ result: T; commands: number; counts: number }> {
  const real = redis.pipeline.bind(redis);
  const sent: (string | number)[][] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(...commands);
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    const result = await work();
    const commands = sent.reduce((sum, c) => sum + (c[0] === "EVAL" ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1), 0);
    // The store's own counts (lib/stats.ts readStats reads its days under nl:stats:<statsId>:), not its kept copies.
    const counts = sent.filter((c) => c.slice(1).some((v) => typeof v === "string" && v.startsWith("nl:stats:"))).length;
    return { result, commands, counts };
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  part("From the studio: the first refresh takes one of the day's readings before it reads");
  {
    const store = await liveStore();
    const run = await billed(() => refreshVerified(store, NOW));
    is("a record is kept, from a reading taken first (the day's count went up)", [run.result !== null, recordKept(store), readingsTaken(store) >= 1], [true, 1, true]);
    is("the record carries the day it was read", run.result?.day, DAY);
  }

  part("From the studio again, the copy still fresh: no reading taken, no counts read");
  {
    const store = await liveStore();
    await refreshVerified(store, NOW);
    const taken = readingsTaken(store);
    redis.run(["DEL", `nl:verified:${store.statsId}`]);
    const run = await billed(() => refreshVerified(store, NOW + 60_000));
    is("a record is kept again from the copy", [run.result !== null, recordKept(store)], [true, 1]);
    is("no reading was taken and the counts were not read", [readingsTaken(store) - taken, run.counts], [0, 0]);
  }

  part("The day's readings used and no copy kept: no record, nothing read");
  {
    const store = await liveStore();
    redis.run(["SET", `nl:reading:day:${store.statsId}:${DAY}`, String(STORE_READINGS_PER_DAY)]);
    const run = await billed(() => refreshVerified(store, NOW));
    is("no record is kept (the numbers are 'not counted yet', never 0)", [run.result, recordKept(store)], [null, 0]);
    is("and the store's counts were not read", run.counts, 0);
  }

  part("The daily pass: a kept copy reused, otherwise its own reading, never one of the creator's");
  {
    const store = await liveStore();
    const own = await billed(() => sendVerified(Date.now() + 60_000));
    is("a store with no copy gets its record from the pass's own reading", [own.result.stores, recordKept(store), own.counts > 0], [1, 1, true]);
    is("and the pass took none of the creator's readings of the day", readingsTaken(store), 0);
    redis.run(["DEL", `nl:verified:${store.statsId}`]);
    await keptStats(store, NOW);
    const taken = readingsTaken(store);
    const kept = await billed(() => sendVerified(Date.now() + 60_000));
    is("with a copy kept by the studio, the store's record is made", [kept.result.stores, recordKept(store)], [1, 1]);
    is("from the copy: no reading taken and no counts read", [readingsTaken(store) - taken, kept.counts], [0, 0]);
    is("the record carries the day the copy was read", (await readVerified(store))?.day, DAY);
  }

  part("The studio's whole kit save that first shows counted numbers stays inside the studio unit and its line (964c, 606b)");
  {
    await liveStore();
    // Its worst: a store that sells, so both copies are read. The studio's home read its numbers today, as it does when
    // the creator opens the studio.
    await setStripeAccount(OWNER, "acct_1TestVerKept1", true);
    const store = (await storeForEmail(OWNER))!;
    await keptStats(store);
    await keptSales(store);
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
    const run = await billed(() => kitPost(new NextRequest("https://marktmorgen.com/api/store/kit", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ on: true, pitch: "", audience: [], facts: [], rates: [], brands: [], counted: { visitors: true, sales: true, countries: true } }),
    })));
    const measured = run.commands + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    const envelope = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    console.log("KIT_SAVE_ROUTE", JSON.stringify({ billed: run.commands, counts: run.counts, measured, envelope, line: VERIFIED_RECORD_EXTRA_COMMANDS }));
    is("the kit is saved (200) and its record kept", [run.result.status, recordKept(store)], [200, 1]);
    is("no counts were read past the kept copy", run.counts, 0);
    // Past the studio unit's figure by at most what the verified-numbers line prices on every studio request.
    is(`its billed commands, padded (${measured}), stay within the studio unit's ${envelope} and the line's ${VERIFIED_RECORD_EXTRA_COMMANDS} more`, measured <= envelope + VERIFIED_RECORD_EXTRA_COMMANDS, true);
  }

  part("A numbers link made, the record first built, stays inside the same envelope");
  {
    await liveStore();
    await setStripeAccount(OWNER, "acct_1TestVerKept1", true);
    const store = (await storeForEmail(OWNER))!;
    await keptStats(store);
    await keptSales(store);
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
    const run = await billed(() => linksPost(new NextRequest("https://marktmorgen.com/api/store/numbers-links", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "create", label: "Brand", password: "verified-2027", days: 7, money: false }),
    })));
    const measured = run.commands + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    const envelope = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    console.log("NUMBERS_LINK_ROUTE", JSON.stringify({ billed: run.commands, counts: run.counts, measured, envelope, line: VERIFIED_RECORD_EXTRA_COMMANDS }));
    is("the link is made (200) and the record kept", [run.result.status, recordKept(store)], [200, 1]);
    is("no counts were read past the kept copy", run.counts, 0);
    is(`its billed commands, padded (${measured}), stay within ${envelope} and the line's ${VERIFIED_RECORD_EXTRA_COMMANDS} more`, measured <= envelope + VERIFIED_RECORD_EXTRA_COMMANDS, true);
  }

  part("A product that sold is in the record, from the studio and from the daily pass (review of #5270)");
  {
    // The kept sales copy names one product with sales; the record lists it by its title, with no listing read.
    const sold = async (): Promise<Store> => {
      await liveStore();
      await setStripeAccount(OWNER, "acct_1TestVerKept1", true);
      const made = await addProduct(OWNER, "Fictional Field Guide", "A synthetic guide.", "50");
      if (!made.ok) throw new Error("no product");
      const store = (await storeForEmail(OWNER))!;
      await refreshVerified(store, NOW);
      const copyKey = `nl:reading:sales:${store.statsId}`;
      const copy = JSON.parse(String(redis.run(["GET", copyKey])));
      const one = { sales: 1, cents: 5000 };
      copy.value.byProduct = { [made.product.id]: { d7: one, d30: one, d90: one } };
      copy.value.totals = { d7: one, d30: one, d90: one };
      redis.run(["SET", copyKey, JSON.stringify(copy)]);
      return store;
    };
    const fromStudio = await refreshVerified(await sold(), NOW);
    is("from the studio: the product that sold is listed by its title", fromStudio?.products.map((p) => [p.title, p.sales, p.cents]), [["Fictional Field Guide", 1, 5000]]);
    const store = await sold();
    redis.run(["DEL", `nl:verified:${store.statsId}`, "nl:verified:cursor"]);
    await sendVerified(Date.now() + 60_000);
    is("from the daily pass: the product that sold is listed by its title", (await readVerified(store))?.products.map((p) => [p.title, p.sales, p.cents]), [["Fictional Field Guide", 1, 5000]]);

    // Claude 1's NIT on #5270 @d2fcd82600 (7093617970): when the store's titles cannot be read, a product that sold
    // was kept with the title "" and shown as "A product no longer listed", which is not true. With the titles
    // unknown (null), the record keeps no product list at all, never a false name.
    const stats = (await keptStats(store, NOW))?.value;
    const sales = (await keptSales(store, NOW))?.value;
    if (!stats || !sales) throw new Error("no kept readings");
    const unknownTitles = verifiedFrom(recordNumbers(store, { stats, sales, state: "ok", at: NOW }, null), new Map(), NOW);
    is("titles unknown: no product is named, and none as no longer listed", unknownTitles.products, []);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
