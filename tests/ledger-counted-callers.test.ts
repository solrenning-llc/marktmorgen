/**
 * Every studio request that reads the store's buyers or all its sales from
 * Stripe again counts that reading in the studio's requests before it reads
 * (MR: a ceiling before every spend), not only the tasks agenda:
 *
 *   - the email composer's count and a narrowed email written down (the
 *     buyers, lib/segments.ts buyerLedger, through createBroadcast's count);
 *     its send started in the same request takes that narrowing as read and
 *     counted, and a scheduled one counts its own reading, waiting (never
 *     dropped) while it is not counted;
 *   - telling a product's buyers of an update (every paid sale,
 *     lib/product-updates.ts updateReadUnits);
 *   - asking the store's numbers (read as the studio's home page reads them,
 *     STUDIO_PAGE_UNITS);
 *
 * and, when it is not counted, nothing is read or written and the studio
 * says how many this needs and how many are left.
 */
import { readFileSync } from "node:fs";
import { NOTE_ROOM, advanceBroadcast, cancelBroadcast, createBroadcast, notCountedNote } from "@/lib/broadcasts";
import { upsertContact } from "@/lib/contacts";
import { ROOM } from "./data-room";
import { broadcastAnswer } from "@/lib/broadcast-response";
import { startUpdate, updateReadUnits } from "@/lib/product-updates";
import { BUYER_LEDGER_UNITS, LedgerNotCounted, ledgerReadBytes, ledgerUnits } from "@/lib/segments";
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

  await copy();
  const later = await createBroadcast(shop, { ...narrowed, sendAt: Date.now() + 3_600_000 }, countLedger(shop).count);
  if (!later.ok) throw new Error(`not written: ${later.reason}`);
  const recordKey = `nl:mail:bc:${later.broadcast.id}`;
  const due = JSON.parse(String((await redisPipeline([["GET", recordKey]]))[0]));
  await redisPipeline([["SET", recordKey, JSON.stringify({ ...due, sendAt: Math.floor(Date.now() / 1000) - 5 })], ["DEL", ledgerKey], ["SET", studioKey()!, String(allowanceFor(shop, "studio") - 3)]]);
  stripeCalls = 0;
  const waiting = await advanceBroadcast(later.broadcast.id, storeForHandle, Date.now() - 1);
  const queued = (await redisPipeline([["SISMEMBER", "nl:mail:queue", later.broadcast.id]]))[0];
  is("scheduled, its copy gone and too few requests left: Stripe not read, it waits (not sent, not failed) and stays queued", [waiting?.status, waiting?.listed, waiting?.sent, stripeCalls, queued], ["waiting", false, 0, 0, 1]);
  is("saying why, in the refusal's own words, and that it goes on by itself", [waiting?.note.startsWith(`This needs ${BUYER_LEDGER_UNITS} of your studio requests, and only 3 are left.`), waiting?.note.endsWith("Nothing was sent. It is tried again automatically."), (waiting?.note.length ?? 0) <= NOTE_ROOM], [true, true, true]);
  is("a refusal with no sentence, or one too long for the record, says the studio's requests could not be counted", [notCountedNote(""), notCountedNote("x".repeat(NOTE_ROOM))], Array(2).fill("Your studio's requests could not be counted just now, so the list of who it goes to could not be made. Nothing was sent. It is tried again automatically."));
  part("A waiting email with no list made, nothing sent, can be canceled (second review M1)");
  await copy();
  const callOff = await createBroadcast(shop, { ...narrowed, sendAt: Date.now() + 3_600_000 }, countLedger(shop).count);
  if (!callOff.ok) throw new Error(`not written: ${callOff.reason}`);
  const offKey = `nl:mail:bc:${callOff.broadcast.id}`;
  const offRecord = JSON.parse(String((await redisPipeline([["GET", offKey]]))[0]));
  await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, sendAt: Math.floor(Date.now() / 1000) - 5 })], ["DEL", ledgerKey]]);
  const held = await advanceBroadcast(callOff.broadcast.id, storeForHandle, Date.now() - 1);
  is("it waits, its reading not counted", [held?.status, held?.listed, held?.sent], ["waiting", false, 0]);
  // While a run holds it (making its list), it cannot be canceled: no race with that run.
  await redisPipeline([["SET", `${offKey}:lock`, "1"]]);
  is("not while a run holds it", await cancelBroadcast(shop, callOff.broadcast.id), false);
  await redisPipeline([["DEL", `${offKey}:lock`]]);
  is("then it cancels, and leaves the queue", [await cancelBroadcast(shop, callOff.broadcast.id), JSON.parse(String((await redisPipeline([["GET", offKey]]))[0])).status, (await redisPipeline([["SISMEMBER", "nl:mail:queue", callOff.broadcast.id]]))[0]], [true, "cancelled", 0]);
  await redisPipeline([["SET", studioKey()!, "0"]]);
  stripeCalls = 0;
  const afterOff = await advanceBroadcast(callOff.broadcast.id, storeForHandle, Date.now() + 5_000);
  is("a run after that reads and sends nothing", [afterOff?.status, afterOff?.listed, afterOff?.sent, stripeCalls], ["cancelled", false, 0, 0]);
  for (const changed of [{ listed: true }, { sent: 1, total: 1 }]) {
    await redisPipeline([["SET", offKey, JSON.stringify({ ...offRecord, status: "waiting", ...changed })]]);
    is(`a waiting email ${changed.listed ? "whose list was made" : "with some sent"} still cannot be canceled`, [await cancelBroadcast(shop, callOff.broadcast.id), JSON.parse(String((await redisPipeline([["GET", offKey]]))[0])).status], [false, "waiting"]);
  }
  await redisPipeline([["SET", studioKey()!, String(allowanceFor(shop, "studio") - 3)]]);

  await redisPipeline([["SET", studioKey()!, "0"]]);
  const retried = await advanceBroadcast(later.broadcast.id, storeForHandle, Date.now() - 1);
  is("once there is room, the next run counts the reading, reads Stripe and lists it", [retried?.listed, stripeCalls > 0, await used()], [true, true, BUYER_LEDGER_UNITS]);

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
  is("the composer shows the sentence, on the count as on a send, and takes the count's away when the next count goes through", [composer.includes('a.error === "studio_used" && typeof a.message === "string" && a.message ? a.message'), composer.includes('} else if (a.error === "stripe" || a.error === "studio_used") {'), composer.includes("if (shown !== null) setError((current) => (current === shown ? null : current));")], [true, true, true]);
  is("so do the update box and the numbers question", [flat("components/product-update-box.tsx").includes('data.error === "studio_used" && typeof data.message === "string" && data.message ? data.message'), flat("components/numbers-ask.tsx").includes('else if (data.error === "studio_used" && typeof data.message === "string" && data.message) setError(data.message);')], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
