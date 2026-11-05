/**
 * Every studio request that reads the store's buyers or all its sales from
 * Stripe again counts that reading in the studio's requests before it reads
 * (MR: a ceiling before every spend), not only the tasks agenda:
 *
 *   - the email composer's count and a narrowed email written down (the
 *     buyers, lib/segments.ts buyerLedger, through createBroadcast's count);
 *     its send started in the same request takes that narrowing as read and
 *     counted; whatever the scheduled job reads for it is paid first, from
 *     what it held in the month it goes out when it was accepted (refused at
 *     once, nothing written, without room in that month) or from the month
 *     it is read in, and it waits for a month with room, never read unpaid;
 *     a plan not paid and running when it is due cancels it, nothing read;
 *   - telling a product's buyers of an update (every paid sale,
 *     lib/product-updates.ts updateReadUnits);
 *   - asking the store's numbers (read as the studio's home page reads them,
 *     STUDIO_PAGE_UNITS);
 *
 * and, when it is not counted, nothing is read or written and the studio
 * says how many this needs and how many are left.
 */
import { readFileSync } from "node:fs";
import { type Broadcast, EXTRA_READS, LIST_RETRY_SECONDS, NOTE_ROOM, NO_BUYERS_NOTE, PLAN_OFF_NARROWED_NOTE, PLAN_OFF_NOTE, READS_HELD, READ_FAILED_NOTE, READ_GAVE_UP_NOTE, READ_MISSES_ALLOWED, READ_RETRY_SECONDS, advanceBroadcast, planOffPartNote, cancelBroadcast, countTest, createBroadcast, readsSpentNote, studioWaitNote } from "@/lib/broadcasts";
import { giveAllowanceIn } from "@/lib/store-allowance";
import { allowanceWindow, opensAgainWords, windowAt, windowId } from "@/lib/allowance-window";
import { StoreFullError } from "@/lib/store-full";
import { dataKey } from "@/lib/store-data";
import { upsertContact } from "@/lib/contacts";
import { ROOM } from "./data-room";
import { broadcastAnswer } from "@/lib/broadcast-response";
import { startUpdate, updateReadUnits } from "@/lib/product-updates";
import { BUYER_LEDGER_UNITS, LedgerNotCounted, ledgerReadBytes, ledgerReadingUnits, ledgerUnits } from "@/lib/segments";
import { countLedger } from "@/lib/person-agenda-read";
import { readListing } from "@/lib/catalog";
import { redisPipeline } from "@/lib/redis";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { type Store, addProduct, claimHandle, clearStripeAccount, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "ledger-owner@example.com";
let stripeCalls = 0;
// Stripe not answering, for a reading that fails there.
let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  if (url.hostname === "api.stripe.com" && stripeDown) throw new TypeError("fetch failed");
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const studioKey = () => redis.keys().find((key) => key.startsWith("nl:allow:studio:"));
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_ledger_only_a_stand_in";
  await claimHandle(OWNER, "ledgershop", "Ledger Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLedger0001", true);
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Lee at Ledger", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Ledger Guide", "", "27", null);
  if (!made.ok) throw new Error("no product");
  const load = async () => (await storeForEmail(OWNER))!;

  part("A narrowed email written down counts its reading of the buyers first");
  const store = await load();
  const counting = countLedger(store);
  // Room for the page's own request only: reading Stripe again needs BUYER_LEDGER_UNITS.
  const { countStudio } = await import("@/lib/studio-route");
  await countStudio(store, null, 1);
  await redisPipeline([["SET", studioKey()!, String(allowanceFor(store, "studio") - 3)]]);
  const written = () => redis.keys().filter((key) => key.startsWith("nl:mail:")).sort();
  stripeCalls = 0;
  const refused = await createBroadcast(store, { subject: "Hello", body: "News for our best buyers.", productId: "", notProductId: "", sendAt: undefined, who: "all", narrow: { minSpent: 5000 } }, counting.count).then(
    (r) => (r.ok ? "written" : r.reason),
    (error: unknown) => (error instanceof LedgerNotCounted ? "not counted" : String(error)),
  );
  is("with fewer studio requests left than reading Stripe again needs, nothing is read from Stripe or written", [refused, stripeCalls, written()], ["not counted", 0, []]);
  is("and the refusal says how many this needs and how many are left", counting.said.message.startsWith(`This needs ${BUYER_LEDGER_UNITS} of your studio requests, and only 3 are left.`), true);
  is("the composer is told so, not that the write is unknown", broadcastAnswer(false, { ok: false, error: "studio_used", message: counting.said.message }, {}), { ok: false, error: "studio_used", message: counting.said.message });

  part("Telling a product's buyers of an update counts every paid sale it reads first");
  const product = (await readListing(await load(), made.product.id))!;
  const product0 = await load();
  stripeCalls = 0;
  const spent = await startUpdate(await load(), product, "");
  is("with fewer left than it needs, it is refused with the sentence, and Stripe is not read", [spent.ok ? "started" : spent.reason, !spent.ok && spent.reason === "studio_used" && spent.message.startsWith(`This needs ${updateReadUnits(product0, 0)} of your studio requests, and only 3 are left.`), stripeCalls], ["studio_used", true, 0]);
  const paypalWeight = ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: 300, paypalRefunds: 0 }));
  is("a reading of the buyers' worth, with the PayPal sales kept by their weight", [updateReadUnits(product0, 0), updateReadUnits(product0, 300)], [BUYER_LEDGER_UNITS, BUYER_LEDGER_UNITS + paypalWeight]);
  const noStripe = { stripeAccountId: undefined, paypalSeller: "SELLER1" } as unknown as Store;
  is("the Stripe part only when Stripe is read; nothing when no sales are read", [updateReadUnits(noStripe, 300), updateReadUnits({ stripeAccountId: undefined, paypalSeller: undefined } as unknown as Store, 300)], [paypalWeight, 0]);
  await redisPipeline([["SET", studioKey()!, "0"]]);
  const read = await startUpdate(await load(), product, "");
  is("with room, it counts them and then reads Stripe", [read.ok ? "started" : read.reason, Number((await redisPipeline([["GET", studioKey()!]]))[0]), stripeCalls > 0], ["none", updateReadUnits(product0, 0), true]);

  part("A narrowed email's send reads the buyers once, counted (review M1)");
  const shop = await load();
  await upsertContact(shop.listId as string, "ann@example.com", { agreed: true, explicit: true, source: "import" }, ROOM);
  const ledgerKey = `nl:stats:${shop.statsId}:ledger`;
  const copy = () => redisPipeline([["SET", ledgerKey, JSON.stringify({ c: shop.currency, p: false, r: [["ann@example.com", 9000, Date.now(), "direct", 2]], v: 6 })]]);
  // The studio's counter of the month running now (a scheduled email may hold in later months' counters too).
  const nowKey = () => redis.keys().find((key) => key.startsWith("nl:allow:studio:") && key.endsWith(`:${windowId(shop)}`))!;
  const keyAt = (ms: number) => nowKey().replace(/:[^:]+$/, `:${windowAt(shop, ms)!.id}`);
  const used = async (key = nowKey()) => Number((await redisPipeline([["GET", key]]))[0] ?? 0);
  const setUsed = (n: number) => redisPipeline([["SET", nowKey(), String(n)]]);
  const figure = allowanceFor(shop, "studio");
  const narrowed = { subject: "Hello", body: "News for our best buyers.", productId: "", notProductId: "", who: "all", narrow: { minSpent: 5000 } };
  const recordOf = async (id: string) => JSON.parse(String((await redisPipeline([["GET", `nl:mail:bc:${id}`]]))[0]));
  const setRecord = async (id: string, change: Record<string, unknown>) => redisPipeline([["SET", `nl:mail:bc:${id}`, JSON.stringify({ ...(await recordOf(id)), ...change })]]);
  const dueNow = (id: string) => setRecord(id, { sendAt: Math.floor(Date.now() / 1000) - 5 });
  const run = (id: string) => advanceBroadcast(id, storeForHandle, Date.now() + 5_000);
  const write = async (input: Record<string, unknown>, counted = true) => {
    const r = await createBroadcast(shop, { ...narrowed, ...input } as Parameters<typeof createBroadcast>[1], counted ? countLedger(shop).count : undefined);
    if (!r.ok) throw new Error(`not written: ${r.reason}`);
    return r;
  };
  await copy();
  const worst = await ledgerReadingUnits(shop);
  is("a reading's worst case, as kept now: the copy by size, and Stripe's pages should the copy be gone", worst, ledgerUnits(Buffer.byteLength(String((await redisPipeline([["GET", ledgerKey]]))[0]))) + BUYER_LEDGER_UNITS);
  await setUsed(0);
  const now = await write({ sendAt: undefined });
  is("sent now: due now, it holds EXTRA_READS readings in this month, should another run make its list", [now.startsNow, now.broadcast.hold?.units, await used()], [true, EXTRA_READS * worst, EXTRA_READS * worst]);
  // Its copy gone: a reading now would go to Stripe and count BUYER_LEDGER_UNITS.
  await redisPipeline([["DEL", ledgerKey]]);
  stripeCalls = 0;
  const listed = await advanceBroadcast(now.broadcast.id, storeForHandle, Date.now() - 1, { keep: now.keep });
  is("it lists from the narrowing just read and counted: Stripe not read, nothing counted again, the hold given back", [listed?.listed, listed?.total, stripeCalls, await used(), (await recordOf(now.broadcast.id)).hold?.units], [true, 1, 0, 0, 0]);

  part("ALTO: every way the scheduled job makes a narrowed email's list is paid before it reads: one set for the next minute, one due now that it takes first");
  await copy();
  await setUsed(0);
  const soon = await write({ sendAt: Date.now() + 30_000 });
  is("set for the next minute, it is the scheduled job's to start: scheduled, holding READS_HELD readings in this month", [soon.startsNow, soon.broadcast.status, soon.broadcast.hold?.units, soon.broadcast.hold?.window, await used()], [false, "scheduled", READS_HELD * worst, windowId(shop), READS_HELD * worst]);
  const early = await advanceBroadcast(soon.broadcast.id, storeForHandle, Date.now() + 5_000, { keep: soon.keep });
  is("a run before it is due does nothing with it", [early?.status, early?.listed], ["scheduled", false]);
  await dueNow(soon.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  await setUsed(figure);
  stripeCalls = 0;
  const went = await run(soon.broadcast.id);
  is("due, its copy gone and this month's requests used up by the rest, the scheduled job reads drawing from its hold, and lists it", [went?.listed, stripeCalls > 0, went?.reads], [true, true, 1]);
  is("what the reading drew stays taken; the rest of the hold is given back once its list is made", [await used(), (await recordOf(soon.broadcast.id)).hold], [figure - (READS_HELD * worst - BUYER_LEDGER_UNITS), { window: windowId(shop), units: 0 }]);
  await copy();
  await setUsed(0);
  const first = await write({ sendAt: undefined });
  await redisPipeline([["DEL", ledgerKey]]);
  await setUsed(figure);
  stripeCalls = 0;
  // The scheduled job took the lock before the request's own run: no narrowing handed over.
  const taken = await run(first.broadcast.id);
  is("due now and taken first by the scheduled job, it reads drawing from the EXTRA_READS it held: Stripe read, nothing taken over the month", [taken?.listed, stripeCalls > 0, await used(), (await recordOf(first.broadcast.id)).hold?.units], [true, true, figure, 0]);

  part("Decision (1): what a reading needs beyond the hold is taken from the month it is read in; with none left there, it waits for the next month, saying when, never read unpaid");
  await copy();
  await setUsed(0);
  const grew = await write({ sendAt: Date.now() + 3_600_000 });
  await dueNow(grew.broadcast.id);
  // Held 3 only (the kept buyers grew since): the rest of the reading comes from this month.
  await setRecord(grew.broadcast.id, { hold: { window: windowId(shop), units: 3 } });
  await redisPipeline([["DEL", ledgerKey]]);
  await setUsed(0);
  stripeCalls = 0;
  const grown = await run(grew.broadcast.id);
  is("the excess taken from this month, the hold drawn to nothing, then read and listed", [grown?.listed, stripeCalls > 0, await used(), (await recordOf(grew.broadcast.id)).hold?.units], [true, true, BUYER_LEDGER_UNITS - 3, 0]);
  await copy();
  const older = await write({ sendAt: Date.now() + 3_600_000 }, false);
  is("an email written down with nothing to count it holds nothing", older.broadcast.hold, undefined);
  await dueNow(older.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  await setUsed(figure);
  stripeCalls = 0;
  const waits = await run(older.broadcast.id);
  const month = allowanceWindow(shop)!;
  is("with no studio request left this month it is not read: it waits, saying why and when they open again, until then", [waits?.status, waits?.note, waits?.retryAt, stripeCalls, await used(), waits?.listed], ["waiting", studioWaitNote(opensAgainWords(month)), Math.ceil(month.end / 1000), 0, figure, false]);
  is("a note that fits the room it was given", (waits?.note.length ?? 999) <= NOTE_ROOM, true);
  await setUsed(0);
  const before = await run(older.broadcast.id);
  is("before that day nothing is tried, even with room again", [before?.status, before?.listed, stripeCalls, await used()], ["waiting", false, 0, 0]);
  await setRecord(older.broadcast.id, { retryAt: Math.floor(Date.now() / 1000) - 1 });
  const opened = await run(older.broadcast.id);
  is("that day, it is read, paid from that month, and goes on", [opened?.listed, stripeCalls > 0, await used(), opened?.retryAt], [true, true, BUYER_LEDGER_UNITS, undefined]);
  await copy();
  await setUsed(0);
  const moved = await write({ sendAt: Date.now() + 3_600_000 });
  await dueNow(moved.broadcast.id);
  await setRecord(moved.broadcast.id, { hold: { window: "2026-01-05", units: 40 } });
  await redisPipeline([["DEL", ledgerKey]]);
  await setUsed(0);
  const elsewhere = await run(moved.broadcast.id);
  is("held for another month than the one it goes out in: that hold is let go, and the month it is read in pays for the reading", [elsewhere?.listed, await used(), (await recordOf(moved.broadcast.id)).hold, redis.keys().some((key) => key.endsWith(":2026-01-05"))], [true, BUYER_LEDGER_UNITS, { window: windowId(shop), units: 0 }, false]);

  part("Decision (2): a scheduled email holds in the month it goes out; scheduling past that month's figure, or past the plan's end, is refused at once");
  await copy();
  await setUsed(0);
  const ahead = Date.now() + 60 * 86_400_000;
  const held = await write({ sendAt: ahead });
  is("two months ahead: held in that month's own figure, nothing in this one's but the count just read", [held.broadcast.hold, await used(keyAt(ahead)), await used()], [{ window: windowAt(shop, ahead)!.id, units: READS_HELD * worst }, READS_HELD * worst, 0]);
  await redisPipeline([["SET", keyAt(ahead), String(figure - 5)]]);
  const beforeRefused = written();
  const over = await createBroadcast(shop, { ...narrowed, sendAt: ahead }, countLedger(shop).count);
  is("all held for a month never passes that month's figure: refused, with how many it needs and how many that month has left, nothing written or held", [over.ok ? "written" : over.reason, !over.ok && "message" in over ? over.message : "", written(), await used(keyAt(ahead))], ["studio_used", `This needs ${READS_HELD * worst} of your studio requests in the month it is set for (from ${opensAgainWords({ ...windowAt(shop, ahead)!, end: windowAt(shop, ahead)!.start })}, UTC), and only 5 are left for that month after what is already set aside in it. Choose another day.`, beforeRefused, figure - 5]);
  is("the composer is told that sentence", broadcastAnswer(false, { ok: false, error: "studio_used", message: "x" }, {}), { ok: false, error: "studio_used", message: "x" });
  const ending = paidPeriod(Date.now(), { behind: 10, ahead: 20 });
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: { ...ending, renews: false } });
  const endingShop = await load();
  const pastEnd = await createBroadcast(endingShop, { ...narrowed, sendAt: Date.now() + 40 * 86_400_000 }, countLedger(endingShop).count);
  is("set to end in 20 days, an email for day 40 is refused, saying the plan's end", [pastEnd.ok ? "written" : pastEnd.reason, !pastEnd.ok && "message" in pastEnd && pastEnd.message.startsWith("Your plan ends on "), written()], ["studio_used", true, beforeRefused]);
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: paidPeriod() });

  const threeMonths = Date.now() + 90 * 86_400_000;
  await setUsed(0);
  const far = await write({ sendAt: threeMonths });
  const farKey = keyAt(threeMonths);
  is("three months ahead: held in that month only", [await used(farKey), await used()], [READS_HELD * worst, 0]);
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: false, tier: "pro", period: null });
  await dueNow(far.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  stripeCalls = 0;
  const off = await run(far.broadcast.id);
  is("the plan ended before it was due: canceled, saying so; nothing read, sent or taken; its hold given back; out of the queue", [off?.status, off?.note, off?.sent, off?.listed, stripeCalls, await used(), await used(farKey), (await redisPipeline([["SISMEMBER", "nl:mail:queue", far.broadcast.id]]))[0]], ["cancelled", PLAN_OFF_NARROWED_NOTE, 0, false, 0, 0, 0, 0]);
  // Counting its buyers when it was written used studio requests: a narrowed email never says none were (C3-112).
  is("a narrowed email canceled with the plan does not say none of the studio requests were used; one to the whole list may", [PLAN_OFF_NARROWED_NOTE.includes("none of your studio requests"), PLAN_OFF_NOTE.includes("none of your studio requests")], [false, true]);
  // Owner, C3-108: an email to the whole list follows the same rule.
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: paidPeriod() });
  const whole = await createBroadcast(await load(), { ...narrowed, narrow: undefined, sendAt: threeMonths } as Parameters<typeof createBroadcast>[1]);
  if (!whole.ok) throw new Error("not written");
  const part3 = await createBroadcast(await load(), { ...narrowed, narrow: undefined, sendAt: Date.now() + 3_600_000 } as Parameters<typeof createBroadcast>[1]);
  if (!part3.ok) throw new Error("not written");
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: false, tier: "pro", period: null });
  await dueNow(whole.broadcast.id);
  // One already going out, one email of three sent, when the plan stops.
  await setRecord(part3.broadcast.id, { sendAt: Math.floor(Date.now() / 1000) - 5, status: "sending", listed: true, sent: 1, total: 3 });
  const wholeOff = await run(whole.broadcast.id);
  const partOff = await run(part3.broadcast.id);
  is("the plan ended: an email to the whole list is canceled too, saying so, nothing sent, out of the queue (never waiting for Pro)", [wholeOff?.status, wholeOff?.note, wholeOff?.sent, wholeOff?.listed, (await redisPipeline([["SISMEMBER", "nl:mail:queue", whole.broadcast.id]]))[0]], ["cancelled", PLAN_OFF_NOTE, 0, false, 0]);
  is("one going out stops where it was, saying how many went", [partOff?.status, partOff?.sent, partOff?.note, (await redisPipeline([["EXISTS", `nl:mail:bc:${part3.broadcast.id}:to`]]))[0]], ["cancelled", 1, planOffPartNote(1, 3), 0]);
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: paidPeriod() });
  const revived = await run(whole.broadcast.id);
  is("the plan on again later does not bring it back", [revived?.status, revived?.sent, revived?.listed], ["cancelled", 0, false]);

  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: paidPeriod() });

  part("The month a moment ahead falls in, as the plan stands now (windowAt)");
  const base = { subscriptionActive: true, subscriptionId: "sub_x", trialEnds: 0, planEndedAt: "" };
  const start = Date.UTC(2026, 0, 31) / 1000;
  const monthly = { ...base, cycle: "month" as const, period: { start, end: Date.UTC(2026, 1, 28) / 1000, renews: true } };
  is("a monthly plan anchored on the 31st: the period running, then the periods Stripe makes from that anchor (cut to a short month, back to the 31st after)", [windowAt(monthly, Date.UTC(2026, 1, 10))?.id, windowAt(monthly, Date.UTC(2026, 2, 5))?.id, windowAt(monthly, Date.UTC(2026, 2, 30))?.id, windowAt(monthly, Date.UTC(2026, 3, 1))?.id, windowAt(monthly, Date.UTC(2026, 4, 1))?.id], ["2026-01-31", "2026-02-28", "2026-02-28", "2026-03-31", "2026-04-30"]);
  const fromShort = { ...monthly, period: { start: Date.UTC(2026, 1, 28) / 1000, end: Date.UTC(2026, 2, 31) / 1000, renews: true } };
  is("the same anchor read from a period that began cut short (28 February to 31 March)", [windowAt(fromShort, Date.UTC(2026, 4, 30))?.id, windowAt(fromShort, Date.UTC(2026, 5, 1))?.id], ["2026-04-30", "2026-05-31"]);
  const on30 = { ...monthly, period: { start: Date.UTC(2026, 0, 30) / 1000, end: Date.UTC(2026, 1, 28) / 1000, renews: true } };
  is("anchored on the 30th", [windowAt(on30, Date.UTC(2026, 2, 29))?.id, windowAt(on30, Date.UTC(2026, 2, 30))?.id], ["2026-02-28", "2026-03-30"]);
  const yearly = { ...base, cycle: "year" as const, period: { start: Date.UTC(2026, 0, 15) / 1000, end: Date.UTC(2027, 0, 15) / 1000, renews: true } };
  is("a yearly plan: its months on its own day, into the next year", [windowAt(yearly, Date.UTC(2026, 5, 20))?.id, windowAt(yearly, Date.UTC(2027, 1, 20))?.id], ["2026-06-15", "2027-02-15"]);
  is("a plan set to end has no month after its end; an ended one counts the calendar month, where holdAllowanceAt holds nothing; an unknown moment has none", [windowAt({ ...monthly, period: { ...monthly.period, renews: false } }, Date.UTC(2026, 2, 5)), windowAt({ ...monthly, subscriptionActive: false }, Date.UTC(2026, 2, 5))?.billing, windowAt(monthly, Number.NaN)], [null, false, null]);

  part("MÉDIO 3: a reading that fails at Stripe never fails the email at once: what it drew stays spent, it waits, saying so, and stops after READ_MISSES_ALLOWED in a row");
  await copy();
  await setUsed(0);
  const flaky = await write({ sendAt: Date.now() + 3_600_000 });
  await dueNow(flaky.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  stripeDown = true;
  const usedFlaky = await used();
  const missed = await run(flaky.broadcast.id);
  const missedAt = Math.floor(Date.now() / 1000);
  is("waiting with the note; what the try drew from its hold stays spent; no reading counted; this month's figure untouched", [missed?.status, missed?.note, (await recordOf(flaky.broadcast.id)).hold?.units, missed?.reads, missed?.misses, await used()], ["waiting", READ_FAILED_NOTE, READS_HELD * worst - BUYER_LEDGER_UNITS, undefined, 1, usedFlaky]);
  is("tried again after an hour, and not before", [Math.abs((missed?.retryAt ?? 0) - (missedAt + READ_RETRY_SECONDS)) <= 2, (await run(flaky.broadcast.id))?.misses], [true, 1]);
  const tries: string[] = [];
  for (let i = 1; i < READ_MISSES_ALLOWED; i += 1) {
    await setRecord(flaky.broadcast.id, { retryAt: 0 });
    tries.push((await run(flaky.broadcast.id))?.status ?? "none");
  }
  const gaveUp = await recordOf(flaky.broadcast.id);
  is(`failing ${READ_MISSES_ALLOWED} times in a row: waiting until then, then failed, saying so, out of the queue`, [tries, gaveUp.status, gaveUp.note, gaveUp.misses, (await redisPipeline([["SISMEMBER", "nl:mail:queue", flaky.broadcast.id]]))[0]], [[...Array(READ_MISSES_ALLOWED - 2).fill("waiting"), "failed"], "failed", READ_GAVE_UP_NOTE, READ_MISSES_ALLOWED, 0]);
  is("every try paid before it asked Stripe: the hold first, then this month", await used(), usedFlaky + (READ_MISSES_ALLOWED * BUYER_LEDGER_UNITS - READS_HELD * worst));
  await copy();
  const recovers = await write({ sendAt: Date.now() + 3_600_000 });
  await dueNow(recovers.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  await run(recovers.broadcast.id);
  stripeDown = false;
  await setRecord(recovers.broadcast.id, { retryAt: 0 });
  const back = await run(recovers.broadcast.id);
  is("Stripe answering again, it is read and listed, with no wait or miss left on it", [back?.listed, back?.reads, back?.misses, back?.retryAt], [true, 1, undefined, undefined]);
  is("its notes fit the room they were given", [READ_FAILED_NOTE, READ_GAVE_UP_NOTE, NO_BUYERS_NOTE, PLAN_OFF_NOTE, PLAN_OFF_NARROWED_NOTE, studioWaitNote("September 30, 2027")].every((note) => note.length <= NOTE_ROOM), true);

  part("ALTO (round 2): a narrowed email whose store no longer reads its buyers is never sent without its narrowing");
  await upsertContact(shop.listId as string, "bea@example.com", { agreed: true, explicit: true, source: "import" }, ROOM);
  await upsertContact(shop.listId as string, "cy@example.com", { agreed: true, explicit: true, source: "import" }, ROOM);
  await copy();
  await setUsed(0);
  const vip = await write({ sendAt: Date.now() + 3_600_000 });
  is("written to the one buyer who spent enough, of three on the list", vip.broadcast.total, 1);
  await dueNow(vip.broadcast.id);
  await clearStripeAccount(OWNER);
  stripeCalls = 0;
  const unread = await run(vip.broadcast.id);
  is("Stripe disconnected, no PayPal and none brought over: canceled, saying why, sent to no one, its hold given back", [unread?.status, unread?.note, unread?.listed, unread?.sent, (await recordOf(vip.broadcast.id)).hold?.units, await used(), stripeCalls], ["cancelled", NO_BUYERS_NOTE, false, 0, 0, 0, 0]);
  await setStripeAccount(OWNER, "acct_1TestLedger0001", true);

  part("MÉDIO 2: a hold made under a larger plan never draws past the figure of the smaller plan of the month it is read in");
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "scale", period: paidPeriod() });
  const scaleShop = await load();
  await copy();
  await setUsed(0);
  const big = await createBroadcast(scaleShop, { ...narrowed, sendAt: Date.now() + 3_600_000 } as Parameters<typeof createBroadcast>[1], countLedger(scaleShop).count);
  if (!big.ok) throw new Error("not written");
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", period: paidPeriod() });
  // The rest of the month used up to 4 below Pro's figure, the hold beside it.
  await setUsed(figure - 4 + READS_HELD * worst);
  await dueNow(big.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  stripeCalls = 0;
  const smaller = await run(big.broadcast.id);
  is("on Pro, its hold draws only the 4 Pro leaves, the rest given back; the reading needs more, so it waits for next month, unread", [smaller?.status, smaller?.note, stripeCalls, await used(), (await recordOf(big.broadcast.id)).hold?.units], ["waiting", studioWaitNote(opensAgainWords(allowanceWindow(shop)!)), 0, figure, 4]);

  part("Refusals and waits that say what happened");
  await copy();
  await setUsed(figure - 3);
  const tooFew = await createBroadcast(shop, { ...narrowed, sendAt: Date.now() + 3_600_000 } as Parameters<typeof createBroadcast>[1], countLedger(shop).count);
  is("this month too few left: how many it needs and how many are left", [tooFew.ok, !tooFew.ok && "message" in tooFew && tooFew.message.startsWith(`This needs ${READS_HELD * worst} of your studio requests this month, and only 3 are left.`)], [false, true]);
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", trialEnds: Math.floor(Date.now() / 1000) + 7 * 86_400, period: null });
  const trialShop = await load();
  await setUsed(0);
  const pastTrial = await createBroadcast(trialShop, { ...narrowed, sendAt: Date.now() + 20 * 86_400_000 } as Parameters<typeof createBroadcast>[1], countLedger(trialShop).count);
  is("in a trial, a day past its end is refused with the day the trial ends", [pastTrial.ok, !pastTrial.ok && "message" in pastTrial && pastTrial.message.startsWith("Your trial ends on ")], [false, true]);
  await setSubscription(OWNER, { customerId: "cus_ledger", subscriptionId: "sub_ledger", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await copy();
  await setUsed(0);
  const uncounted = await write({ sendAt: Date.now() + 3_600_000 }, false);
  await dueNow(uncounted.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  const unsure = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (commands.some((c) => c[0] === "INCRBY" && c[1] === nowKey()) ? [null, "lost"] : unsure(commands))) as typeof redis.pipeline;
  stripeCalls = 0;
  const notCounted = await run(uncounted.broadcast.id);
  redis.pipeline = unsure;
  is("a count that could not be made: not read, waiting an hour, saying so", [notCounted?.status, stripeCalls, (notCounted?.retryAt ?? 0) - Math.floor(Date.now() / 1000) > LIST_RETRY_SECONDS - 5, notCounted?.note.endsWith("It is tried again in an hour.")], ["waiting", 0, true, true]);
  const ahead2 = windowAt(shop, Date.now() + 60 * 86_400_000)!.id;
  const aheadKey = nowKey().replace(/:[^:]+$/, `:${ahead2}`);
  await redisPipeline([["DEL", aheadKey]]);
  await giveAllowanceIn(shop, "studio", 5, ahead2);
  const [aheadLeft, aheadTtl] = await redisPipeline([["GET", aheadKey], ["TTL", aheadKey]]);
  is("giving back to a counter that is not there never leaves one below zero, nor one without an expiry", [Number(aheadLeft ?? 0) >= 0, aheadLeft === null || Number(aheadTtl) > 0], [true, true]);
  const testing = { id: "a".repeat(24), sendAt: Math.floor(Date.now() / 1000) - 3_600, test: { by: "sales" } } as unknown as Broadcast;
  await setUsed(figure);
  stripeCalls = 0;
  const unpaid = await countTest(shop, testing);
  is("a subject test decided by sales: without studio requests its sales are not read", [unpaid.sales, stripeCalls, await used()], [null, 0, figure]);
  await setUsed(0);
  const paidTest = await countTest(shop, testing);
  is("with them, paid first, then read", [paidTest.sales !== null, stripeCalls > 0, await used()], [true, true, BUYER_LEDGER_UNITS]);

  part("MÉDIO 4 and the record's room: a full data room refuses the email and gives back what it held");
  await copy();
  await setUsed(0);
  const roomKey = dataKey(shop)!;
  const [roomUsed] = await redisPipeline([["HGET", roomKey, "#"]]);
  await redisPipeline([["HSET", roomKey, "#", 10 ** 12]]);
  const beforeFull = written();
  const full = await createBroadcast(shop, { ...narrowed, sendAt: Date.now() + 3_600_000 }, countLedger(shop).count).then((r) => (r.ok ? "written" : r.reason), (error: unknown) => (error instanceof StoreFullError ? "store_full" : String(error)));
  await redisPipeline([["HSET", roomKey, "#", Number(roomUsed ?? 0)]]);
  is("store_full, nothing written, and nothing held left taken", [full, written(), await used()], ["store_full", beforeFull, 0]);
  is("the studio says so, as a refusal, not as a write it cannot confirm", [broadcastAnswer(false, { ok: false, error: "store_full" }, {}), flat("components/email-studio.tsx").includes("so this email was not saved and nothing was sent. Nothing was set aside for it.")], [{ ok: false, error: "store_full" }, true]);
  const roomBefore = Number((await redisPipeline([["HGET", roomKey, "#"]]))[0] ?? 0);
  const sized = await write({ sendAt: Date.now() + 3_600_000 });
  const roomTaken = Number((await redisPipeline([["HGET", roomKey, "#"]]))[0] ?? 0) - roomBefore;
  const widest = Number.MAX_SAFE_INTEGER;
  const grownRecord = { ...(await recordOf(sized.broadcast.id)), status: "cancelled", note: "x".repeat(NOTE_ROOM), finishedAt: widest, total: widest, sent: widest, failures: widest, hold: { window: "2027-12-31", units: widest }, reads: widest, misses: widest, retryAt: widest };
  is("the room it takes covers its record at its widest: its readings, misses, wait and hold too", roomTaken >= Buffer.byteLength(JSON.stringify(grownRecord)), true);
  await cancelBroadcast(shop, sized.broadcast.id);

  part("LEVE 8: a draw that cannot be written down takes nothing from the hold");
  await copy();
  await setUsed(0);
  const unsaved = await write({ sendAt: Date.now() + 3_600_000 });
  await dueNow(unsaved.broadcast.id);
  await redisPipeline([["DEL", ledgerKey]]);
  const realPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) {
      if (command[0] === "SET" && command[1] === `nl:mail:bc:${unsaved.broadcast.id}` && JSON.parse(String(command[2])).hold?.units < READS_HELD * worst) throw new Error("write lost");
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  stripeCalls = 0;
  const kept = await run(unsaved.broadcast.id);
  redis.pipeline = realPipeline;
  is("not read, waiting, its hold whole on the record", [kept?.status, stripeCalls, (await recordOf(unsaved.broadcast.id)).hold?.units, await used()], ["waiting", 0, READS_HELD * worst, READS_HELD * worst]);

  part("A list that cannot be made for another reason is read again at most EXTRA_READS times, each paid, then the email stops, failed, saying why");
  let ledgerReads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) if (command[0] === "STRLEN" && command[1] === ledgerKey) ledgerReads += 1;
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const rounds = async (id: string, n: number) => {
    const seen: string[] = [];
    for (let i = 0; i < n; i += 1) {
      // Its hour's wait waited out.
      await setRecord(id, { retryAt: 0 });
      seen.push((await run(id))?.status ?? "none");
    }
    return seen;
  };
  const dataFull = "Your store's data room is full, so the list of who it goes to could not be made. Nothing was sent.";
  for (const [kind, holds] of [["holding its readings", true], ["written down with nothing held", false]] as const) {
    await copy();
    await setUsed(0);
    const fullList = await write({ sendAt: Date.now() + 3_600_000 }, holds);
    await dueNow(fullList.broadcast.id);
    await redisPipeline([["HSET", roomKey, "#", 10 ** 12]]);
    ledgerReads = 0;
    const usedBefore = await used();
    const statuses = await rounds(fullList.broadcast.id, 3);
    const end = await recordOf(fullList.broadcast.id);
    is(`an email ${kind}, its data room full for 3 rounds: read ${READS_HELD} times at the most, waiting with the data room's note until then, then failed`, [ledgerReads, end.reads, statuses], [READS_HELD, READS_HELD, [...Array(READS_HELD - 1).fill("waiting"), ...Array(4 - READS_HELD).fill("failed")]]);
    is("what it held and did not draw given back when it stops", [(await used()) - usedBefore, holds ? end.hold?.units : end.hold], [holds ? -(READS_HELD * worst) : 0, holds ? 0 : undefined]);
    is("then it stops, failed, with why it waited, out of the queue: never dropped without a word", [end.status, end.note, end.note.length <= NOTE_ROOM, (await redisPipeline([["SISMEMBER", "nl:mail:queue", fullList.broadcast.id]]))[0]], ["failed", `${dataFull} It was tried as many times as it can be, so it stopped. To send it, write it again.`, true, 0]);
    await redisPipeline([["HSET", roomKey, "#", Number(roomUsed ?? 0)]]);
  }
  await copy();
  const freed = await write({ sendAt: Date.now() + 3_600_000 });
  await dueNow(freed.broadcast.id);
  await redisPipeline([["HSET", roomKey, "#", 10 ** 12]]);
  ledgerReads = 0;
  const whileFull = await rounds(freed.broadcast.id, 1);
  const fullNote = (await recordOf(freed.broadcast.id)).note;
  is("waiting, its note says what happens and when: tried again in an hour, once more, then it stops", [fullNote, (await recordOf(freed.broadcast.id)).retryAt - Math.floor(Date.now() / 1000) > LIST_RETRY_SECONDS - 5], [`${dataFull} Make room: it is tried again in an hour, once more, then it stops.`, true]);
  is("and before that hour nothing is tried", (await run(freed.broadcast.id))?.reads, 1);
  await redisPipeline([["HSET", roomKey, "#", Number(roomUsed ?? 0)]]);
  await setRecord(freed.broadcast.id, { retryAt: 0 });
  const once = await run(freed.broadcast.id);
  is("made room within its readings, its list is made at the next round and it goes on", [whileFull, once?.listed, once?.total, once?.status !== "failed" && !once?.note.startsWith(dataFull), ledgerReads], [["waiting"], true, 1, true, READS_HELD]);
  redis.pipeline = realPipeline;
  is("the note without a retry sentence of its own keeps its words; an empty one says the list could not be made", [readsSpentNote("The recipient list could not be prepared. Nothing was sent. It will be checked again automatically."), readsSpentNote("")], ["The recipient list could not be prepared. Nothing was sent. It was tried as many times as it can be, so it stopped. To send it, write it again.", "The list of who it goes to could not be made. Nothing was sent. It was tried as many times as it can be, so it stopped. To send it, write it again."]);

  part("A scheduled or waiting email with no list made, nothing sent, can be canceled; what it held and did not draw is given back");
  await copy();
  await setUsed(0);
  const callOff = await write({ sendAt: Date.now() + 3_600_000 });
  is("canceled while scheduled: canceled, out of the queue, its hold given back and marked so", [await cancelBroadcast(shop, callOff.broadcast.id), (await recordOf(callOff.broadcast.id)).status, (await recordOf(callOff.broadcast.id)).hold?.units, (await redisPipeline([["SISMEMBER", "nl:mail:queue", callOff.broadcast.id]]))[0], await used()], [true, "cancelled", 0, 0, 0]);
  const waitOff = await write({ sendAt: Date.now() + 3_600_000 });
  const offKey = `nl:mail:bc:${waitOff.broadcast.id}`;
  const offRecord = await recordOf(waitOff.broadcast.id);
  // Waiting before its list was made, for another reason (here the data room full), with a list half written by a run cut short.
  await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, status: "waiting", note: "Your store's data room is full, so the list of who it goes to could not be made. Nothing was sent. Make room, and it is tried again automatically." })], ["RPUSH", `${offKey}:to`, "ann@example.com"]]);
  // While a run holds it (making its list), it cannot be canceled: no race with that run.
  await redisPipeline([["SET", `${offKey}:lock`, "1"]]);
  is("not while a run holds it", await cancelBroadcast(shop, waitOff.broadcast.id), false);
  await redisPipeline([["DEL", `${offKey}:lock`]]);
  is("then it cancels, leaves the queue, and its half-written list, kept with no expiry, goes with it (LEVE 6)", [await cancelBroadcast(shop, waitOff.broadcast.id), (await recordOf(waitOff.broadcast.id)).status, (await redisPipeline([["SISMEMBER", "nl:mail:queue", waitOff.broadcast.id]]))[0], (await redisPipeline([["EXISTS", `${offKey}:to`]]))[0]], [true, "cancelled", 0, 0]);
  stripeCalls = 0;
  const afterOff = await run(waitOff.broadcast.id);
  is("a run after that reads and sends nothing", [afterOff?.status, afterOff?.listed, afterOff?.sent, stripeCalls], ["cancelled", false, 0, 0]);
  for (const changed of [{ listed: true }, { sent: 1, total: 1 }]) {
    await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, status: "waiting", ...changed })]]);
    is(`a waiting email ${changed.listed ? "whose list was made" : "with some sent"} still cannot be canceled`, [await cancelBroadcast(shop, waitOff.broadcast.id), (await recordOf(waitOff.broadcast.id)).status], [false, "waiting"]);
  }
  for (const bad of [{ hold: { window: windowId(shop), units: -1 } }, { hold: { window: "soon", units: 1 } }, { reads: 1.5 }, { retryAt: -1 }]) {
    await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, ...bad })]]);
    is(`a record with ${JSON.stringify(bad)} is refused as malformed, never run`, await run(waitOff.broadcast.id).then(() => "ran", () => "refused"), "refused");
  }
  await redisPipeline([["DEL", offKey]]);

  part("The routes and the studio");
  const history = flat("components/email-studio.tsx");
  is("the studio offers the same button for a waiting email with no list made and nothing sent, at a 44-pixel target", [history.includes('{(b.status === "scheduled" || (b.status === "waiting" && b.listed === false && b.sent === 0)) && canSend ? ('), history.includes('className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"'), flat("app/studio/email/page.tsx").includes("listed: b.listed,")], [true, true, true]);
  const mail = flat("app/api/store/mail/route.ts");
  is("the composer's count counts its reading of the buyers, and says the refusal's sentence", [mail.includes("const ledger = await buyerLedger(store, counting.count)"), mail.includes("if (ledger instanceof LedgerNotCounted) return notCounted(counting.said.message);"), mail.includes('Response.json({ ok: false, error: "studio_used", message: message || NOT_COUNTED }, { status: 429 })')], [true, true, true]);
  is("a narrowed email written down counts it too", [mail.includes("}, counting.count).catch((error) => {"), mail.includes("if (created instanceof LedgerNotCounted) return notCounted(counting.said.message);")], [true, true]);
  is("the mail route reads the buyers only counted: never without a count, and its send started now takes the narrowing just counted", [mail.includes("buyerLedger(store)"), mail.includes("advanceBroadcast(id, storeForHandle, Date.now() + 50_000, { keep })"), mail.includes("if (created.startsNow) {"), mail.includes("+ 60) {")], [false, true, true, false]);
  is("a hold refused says its own sentence", mail.includes('if (!created.ok) return created.reason === "studio_used" ? notCounted(created.message) : fail(created.reason);'), true);
  const update = flat("app/api/store/product-update/route.ts");
  is("the update's refusal carries its sentence, or the shared one", update.includes('error: "studio_used", message: started.message ? `${started.message} Nothing was sent.` : NOT_COUNTED }'), true);
  const ask = flat("app/api/store/numbers/ask/route.ts");
  const at = (words: string) => ask.indexOf(words);
  is("asking the numbers checks the month's AI jobs, then counts their reading as their page does, then reads them", [at("aiLeft(store)") > 0, at("aiLeft(store)") < at("countUnits(store, STUDIO_PAGE_UNITS - 1)"), at("countUnits(store, STUDIO_PAGE_UNITS - 1)") < at("readNumbers(store)")], [true, true, true]);
  is("with the shared sentence when the count gave none", ask.includes("message: (counted && !counted.ok && counted.message) || NOT_COUNTED }"), true);
  const composer = flat("components/email-studio.tsx");
  is("a narrowed email says, before it is confirmed, what it sets aside and from which month, and that what it does not use comes back; a refusal is shown as an alert", [composer.includes('" Scheduling it sets aside, from the month it goes out, the studio requests needed to find these buyers then, and to find them once more if it has to wait. If that month has too few left, it is not scheduled, and you see how many it needs. What it has not used is given back, also if you cancel."') && composer.includes('" Sending it sets aside the studio requests needed to find these buyers once more if it has to wait. What it does not use is given back."'), composer.includes('<p className="notice notice-error mt-3" role="alert">{error}</p>')], [true, true]);
  is("the composer shows the sentence, on the count as on a send, and takes the count's away when the next count goes through", [composer.includes('a.error === "studio_used" && typeof a.message === "string" && a.message ? a.message'), composer.includes('} else if (a.error === "stripe" || a.error === "studio_used") {'), composer.includes("if (shown !== null) setError((current) => (current === shown ? null : current));")], [true, true, true]);
  is("so do the update box and the numbers question", [flat("components/product-update-box.tsx").includes('data.error === "studio_used" && typeof data.message === "string" && data.message ? data.message'), flat("components/numbers-ask.tsx").includes('else if (data.error === "studio_used" && typeof data.message === "string" && data.message) setError(data.message);')], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
