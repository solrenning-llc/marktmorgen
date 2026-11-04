/**
 * Every studio request that reads the store's buyers or all its sales from
 * Stripe again counts that reading in the studio's requests before it reads
 * (MR: a ceiling before every spend), not only the tasks agenda:
 *
 *   - the email composer's count and a narrowed email written down (the
 *     buyers, lib/segments.ts buyerLedger, through createBroadcast's count);
 *     its send started in the same request takes that narrowing as read and
 *     counted, and a scheduled one holds its later reading's worst case when
 *     it is accepted (refused at once, nothing written, without room), so the
 *     scheduled job draws from that hold and never refuses it (C3-80 (d));
 *   - telling a product's buyers of an update (every paid sale,
 *     lib/product-updates.ts updateReadUnits);
 *   - asking the store's numbers (read as the studio's home page reads them,
 *     STUDIO_PAGE_UNITS);
 *
 * and, when it is not counted, nothing is read or written and the studio
 * says how many this needs and how many are left.
 */
import { readFileSync } from "node:fs";
import { advanceBroadcast, cancelBroadcast, createBroadcast } from "@/lib/broadcasts";
import { upsertContact } from "@/lib/contacts";
import { ROOM } from "./data-room";
import { broadcastAnswer } from "@/lib/broadcast-response";
import { startUpdate, updateReadUnits } from "@/lib/product-updates";
import { BUYER_LEDGER_UNITS, LedgerNotCounted, ledgerReadBytes, ledgerReadingUnits, ledgerUnits } from "@/lib/segments";
import { countLedger } from "@/lib/person-agenda-read";
import { readListing } from "@/lib/catalog";
import { redisPipeline } from "@/lib/redis";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { type Store, addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "ledger-owner@example.com";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
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
  await redisPipeline([["SET", studioKey()!, "0"]]);
  const shop = await load();
  await upsertContact(shop.listId as string, "ann@example.com", { agreed: true, explicit: true, source: "import" }, ROOM);
  const ledgerKey = `nl:stats:${shop.statsId}:ledger`;
  const copy = () => redisPipeline([["SET", ledgerKey, JSON.stringify({ c: shop.currency, p: false, r: [["ann@example.com", 9000, Date.now(), "direct", 2]], v: 6 })]]);
  const used = async () => Number((await redisPipeline([["GET", studioKey()!]]))[0]);
  const narrowed = { subject: "Hello", body: "News for our best buyers.", productId: "", notProductId: "", who: "all", narrow: { minSpent: 5000 } };
  await copy();
  const now = await createBroadcast(shop, { ...narrowed, sendAt: undefined }, countLedger(shop).count);
  if (!now.ok) throw new Error(`not written: ${now.reason}`);
  // Its copy gone: a reading now would go to Stripe and count BUYER_LEDGER_UNITS.
  await redisPipeline([["DEL", ledgerKey]]);
  stripeCalls = 0;
  const before = await used();
  const listed = await advanceBroadcast(now.broadcast.id, storeForHandle, Date.now() - 1, { keep: now.keep });
  is("sent now, it lists from the narrowing just read and counted: Stripe not read, nothing counted again", [listed?.listed, listed?.total, stripeCalls, (await used()) - before], [true, 1, 0, 0]);

  part("A narrowed email scheduled holds its later reading when it is accepted, and the scheduled job never refuses it (C3-80 (d))");
  const later = { ...narrowed, sendAt: Date.now() + 3_600_000 };
  const recordOf = async (id: string) => JSON.parse(String((await redisPipeline([["GET", `nl:mail:bc:${id}`]]))[0]));
  const dueNow = async (id: string) => redisPipeline([["SET", `nl:mail:bc:${id}`, JSON.stringify({ ...(await recordOf(id)), sendAt: Math.floor(Date.now() / 1000) - 5 })]]);
  await copy();
  const worst = await ledgerReadingUnits(shop);
  is("its reading's worst case, as kept now: the copy by size, and Stripe's pages should the copy be gone", worst, ledgerUnits(Buffer.byteLength(String((await redisPipeline([["GET", ledgerKey]]))[0]))) + BUYER_LEDGER_UNITS);
  await redisPipeline([["SET", studioKey()!, String(allowanceFor(shop, "studio") - 3)]]);
  const beforeRefused = written();
  const tooFew = countLedger(shop);
  stripeCalls = 0;
  const notHeld = await createBroadcast(shop, later, tooFew.count).then(
    (r) => (r.ok ? "written" : r.reason),
    (error: unknown) => (error instanceof LedgerNotCounted ? "not counted" : String(error)),
  );
  is("without room for it, scheduling is refused at once: nothing written, nothing taken", [notHeld, written(), await used()], ["not counted", beforeRefused, allowanceFor(shop, "studio") - 3]);
  is("with the sentence of how many it needs and how many are left", tooFew.said.message.startsWith(`This needs ${worst} of your studio requests, and only 3 are left.`), true);
  await redisPipeline([["SET", studioKey()!, "0"]]);
  const held = await createBroadcast(shop, later, countLedger(shop).count);
  if (!held.ok) throw new Error(`not written: ${held.reason}`);
  is("with room, it holds exactly that worst case, on the record too", [await used(), held.broadcast.reserve, (await recordOf(held.broadcast.id)).reserve], [worst, worst, worst]);
  const startsNow = await createBroadcast(shop, { ...narrowed, sendAt: undefined }, countLedger(shop).count);
  if (!startsNow.ok) throw new Error(`not written: ${startsNow.reason}`);
  is("one that starts in the same request holds nothing: it lists from the narrowing just read", [startsNow.broadcast.reserve, await used()], [undefined, worst]);
  await dueNow(held.broadcast.id);
  // Its copy gone and no request left: the reading goes to Stripe, drawing what was held.
  await redisPipeline([["DEL", ledgerKey], ["SET", studioKey()!, String(allowanceFor(shop, "studio"))]]);
  stripeCalls = 0;
  const went = await advanceBroadcast(held.broadcast.id, storeForHandle, Date.now() + 5_000);
  is("due, its copy gone and no studio request left, the scheduled job still reads and lists it: never waiting", [went?.status !== "waiting", went?.listed, stripeCalls > 0], [true, true, true]);
  is("drawing what was held, never counting again", [await used(), went?.reserve, (await recordOf(held.broadcast.id)).reserve], [allowanceFor(shop, "studio"), worst - BUYER_LEDGER_UNITS, worst - BUYER_LEDGER_UNITS]);

  await copy();
  await redisPipeline([["SET", studioKey()!, "0"]]);
  const less = await createBroadcast(shop, later, countLedger(shop).count);
  if (!less.ok) throw new Error(`not written: ${less.reason}`);
  await dueNow(less.broadcast.id);
  const usedBefore = await used();
  stripeCalls = 0;
  const fromCopy = await advanceBroadcast(less.broadcast.id, storeForHandle, Date.now() + 5_000);
  is("reading less than held (its copy still kept): Stripe not read, nothing counted, the rest stays on the record, not given back", [fromCopy?.listed, stripeCalls, (await used()) - usedBefore, (await recordOf(less.broadcast.id)).reserve], [true, 0, 0, worst - ledgerUnits(Buffer.byteLength(String((await redisPipeline([["GET", ledgerKey]]))[0])))]);

  // An email written down before anything was held (or with nothing to count it): its reading needs more than it holds.
  await copy();
  const older = await createBroadcast(shop, later);
  if (!older.ok) throw new Error(`not written: ${older.reason}`);
  await dueNow(older.broadcast.id);
  await redisPipeline([["DEL", ledgerKey], ["SET", studioKey()!, String(allowanceFor(shop, "studio"))]]);
  stripeCalls = 0;
  const unheld = await advanceBroadcast(older.broadcast.id, storeForHandle, Date.now() + 5_000);
  is("needing more than it holds with no request left, it is still read and listed, never waiting, and nothing more is counted", [older.broadcast.reserve, unheld?.status !== "waiting", unheld?.listed, stripeCalls > 0, await used()], [undefined, true, true, true, allowanceFor(shop, "studio")]);

  part("A scheduled or waiting email with no list made, nothing sent, can be canceled; what it holds is not given back");
  await copy();
  await redisPipeline([["SET", studioKey()!, "0"]]);
  const callOff = await createBroadcast(shop, later, countLedger(shop).count);
  if (!callOff.ok) throw new Error(`not written: ${callOff.reason}`);
  const heldOff = await used();
  is("canceled while scheduled: canceled, out of the queue, its hold kept on the record, nothing given back", [await cancelBroadcast(shop, callOff.broadcast.id), (await recordOf(callOff.broadcast.id)).status, (await recordOf(callOff.broadcast.id)).reserve, (await redisPipeline([["SISMEMBER", "nl:mail:queue", callOff.broadcast.id]]))[0], await used()], [true, "cancelled", worst, 0, heldOff]);
  const waitOff = await createBroadcast(shop, later, countLedger(shop).count);
  if (!waitOff.ok) throw new Error(`not written: ${waitOff.reason}`);
  const offKey = `nl:mail:bc:${waitOff.broadcast.id}`;
  const offRecord = await recordOf(waitOff.broadcast.id);
  // Waiting before its list was made, for another reason (here the data room full).
  await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, status: "waiting", note: "Your store's data room is full, so the list of who it goes to could not be made. Nothing was sent. Make room, and it is tried again automatically." })]]);
  // While a run holds it (making its list), it cannot be canceled: no race with that run.
  await redisPipeline([["SET", `${offKey}:lock`, "1"]]);
  is("not while a run holds it", await cancelBroadcast(shop, waitOff.broadcast.id), false);
  await redisPipeline([["DEL", `${offKey}:lock`]]);
  is("then it cancels, and leaves the queue", [await cancelBroadcast(shop, waitOff.broadcast.id), (await recordOf(waitOff.broadcast.id)).status, (await redisPipeline([["SISMEMBER", "nl:mail:queue", waitOff.broadcast.id]]))[0]], [true, "cancelled", 0]);
  stripeCalls = 0;
  const afterOff = await advanceBroadcast(waitOff.broadcast.id, storeForHandle, Date.now() + 5_000);
  is("a run after that reads and sends nothing", [afterOff?.status, afterOff?.listed, afterOff?.sent, stripeCalls], ["cancelled", false, 0, 0]);
  for (const changed of [{ listed: true }, { sent: 1, total: 1 }]) {
    await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, status: "waiting", ...changed })]]);
    is(`a waiting email ${changed.listed ? "whose list was made" : "with some sent"} still cannot be canceled`, [await cancelBroadcast(shop, waitOff.broadcast.id), (await recordOf(waitOff.broadcast.id)).status], [false, "waiting"]);
  }
  await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, reserve: -1 })]]);
  is("a record whose hold is not a whole number of requests is refused as malformed, never run", await advanceBroadcast(waitOff.broadcast.id, storeForHandle, Date.now() + 5_000).then(() => "ran", () => "refused"), "refused");
  await redisPipeline([["DEL", offKey]]);
  is("no code path writes the old wait for the studio's requests, and the scheduled job counts nothing in them", [flat("lib/broadcasts.ts").includes("notCountedNote"), flat("lib/broadcasts.ts").includes("countUnits("), flat("lib/broadcasts.ts").includes("countLedger(")], [false, false, false]);

  part("The routes and the studio");
  const history = flat("components/email-studio.tsx");
  is("the studio offers the same button for a waiting email with no list made and nothing sent, at a 44-pixel target", [history.includes('{(b.status === "scheduled" || (b.status === "waiting" && b.listed === false && b.sent === 0)) && canSend ? ('), history.includes('className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"'), flat("app/studio/email/page.tsx").includes("listed: b.listed,")], [true, true, true]);
  const mail = flat("app/api/store/mail/route.ts");
  is("the composer's count counts its reading of the buyers, and says the refusal's sentence", [mail.includes("const ledger = await buyerLedger(store, counting.count)"), mail.includes("if (ledger instanceof LedgerNotCounted) return notCounted(counting.said.message);"), mail.includes('Response.json({ ok: false, error: "studio_used", message: message || NOT_COUNTED }, { status: 429 })')], [true, true, true]);
  is("a narrowed email written down counts it too", [mail.includes("}, counting.count).catch((error) => {"), mail.includes("if (created instanceof LedgerNotCounted) return notCounted(counting.said.message);")], [true, true]);
  is("the mail route reads the buyers only counted: never without a count, and its send started now takes the narrowing just counted", [mail.includes("buyerLedger(store)"), mail.includes("advanceBroadcast(id, storeForHandle, Date.now() + 50_000, { keep })")], [false, true]);
  const update = flat("app/api/store/product-update/route.ts");
  is("the update's refusal carries its sentence, or the shared one", update.includes('error: "studio_used", message: started.message ? `${started.message} Nothing was sent.` : NOT_COUNTED }'), true);
  const ask = flat("app/api/store/numbers/ask/route.ts");
  const at = (words: string) => ask.indexOf(words);
  is("asking the numbers checks the month's AI jobs, then counts their reading as their page does, then reads them", [at("aiLeft(store)") > 0, at("aiLeft(store)") < at("countUnits(store, STUDIO_PAGE_UNITS - 1)"), at("countUnits(store, STUDIO_PAGE_UNITS - 1)") < at("readNumbers(store)")], [true, true, true]);
  is("with the shared sentence when the count gave none", ask.includes("message: (counted && !counted.ok && counted.message) || NOT_COUNTED }"), true);
  const composer = flat("components/email-studio.tsx");
  is("scheduling a narrowed email says, before it is confirmed, that it sets aside studio requests now and that canceling does not give them back; a refusal is shown as an alert", [composer.includes('" Scheduling it sets aside, now, the studio requests needed to find these buyers when it goes out. If too few are left, it is not scheduled, and you see how many it needs. Canceling does not give them back."'), composer.includes('<p className="notice notice-error mt-3" role="alert">{error}</p>')], [true, true]);
  is("the composer shows the sentence, on the count as on a send, and takes the count's away when the next count goes through", [composer.includes('a.error === "studio_used" && typeof a.message === "string" && a.message ? a.message'), composer.includes('} else if (a.error === "stripe" || a.error === "studio_used") {'), composer.includes("if (shown !== null) setError((current) => (current === shown ? null : current));")], [true, true, true]);
  is("so do the update box and the numbers question", [flat("components/product-update-box.tsx").includes('data.error === "studio_used" && typeof data.message === "string" && data.message ? data.message'), flat("components/numbers-ask.tsx").includes('else if (data.error === "studio_used" && typeof data.message === "string" && data.message) setError(data.message);')], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
