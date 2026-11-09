/**
 * A PayPal payout batch left for the creator's own check (`m: 1` in
 * lib/pending-payouts.ts), and how the creator sorts it out from the studio
 * (Claude 5, 09/11/2026; pre-review of #3335).
 *
 * A batch whose answer from PayPal never came is sent again once a day; after
 * a week, or when PayPal says it has the batch without saying which, it is
 * marked for the creator's own check and never sent again. Before this, the
 * mark had no way out: the people in it stayed "on their way" for good, so
 * they were left out of every new PayPal payment, payout file and recorded
 * batch, whatever they earned later, and the store stayed in the daily job.
 *
 * The owner's decision (C1-20261109-1029-C5-52, item 10): such a batch is
 * cleared only by the payment's own ID in PayPal (the payout batch ID). The
 * creator's word is not enough, and "paid" alone is not either. The ID is
 * read from PayPal with the creator's own app, and taken only when it is a
 * batch of the creator's own account, sent under this batch's own reference
 * (sender_batch_id), to exactly these people (each address's fingerprint)
 * for exactly these amounts, and not already held for another batch. Then
 * the batch is held under that ID, and the settling writes each person paid
 * once PayPal says their part went through, or owed again when PayPal says
 * it did not. Anything not known marks nothing, and the studio says so.
 *
 * Rule 23: the first version of this file (same branch, before the decision)
 * asserted the creator's own per-person answer: resolveOwnCheck(store, batch,
 * { paid, unpaid }) writing "paid" payouts under the reference "PayPal <ref>,
 * checked by you", "changed" for answers that left someone out, the payout
 * write and payouts read faults of that path, and the panel's "What does your
 * PayPal activity show?", "Yes, save this" and "or does not show a payment to
 * them at all". All of them asserted the creator's word as enough, which the
 * owner's decision forbids; they are replaced by the assertions below, which
 * keep their intent (nobody paid twice, nothing marked on a fault, the batch
 * can be cleared) under the payout batch ID.
 *
 * Also here: the "being checked" sentence no longer says PayPal's answer did
 * not reach us (a batch never sent, or refused, can be in it too), and a
 * press whose "?" entry could be confirmed neither written nor removed puts
 * the store in the daily job again, so the settling finds it without the
 * creator opening the studio.
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com.
 */
import { readFileSync } from "node:fs";
import * as paypal from "@/lib/paypal-payouts";
import { connectPayPal, onTheirWay, paypalChecks, paypalOwnChecks, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsown0001";
const OPEN = `nl:pp:open:${STATS}`;
const PAYOUTS = `nl:aff:${STATS}:payouts`;
const STORES = "nl:pp:stores";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
const SARA = "aaaaaaaaaaaa";
const TOM = "bbbbbbbbbbbb";
const CARL = "cccccccccccc";

type Item = { sender_item_id: string; receiver: string; amount: { currency: string; value: string } };
/** The batches PayPal holds in the creator's own account, by payout batch ID. */
const account = new Map<string, { sender: string; items: Item[] }>();
/** What PayPal says of each item, by the affiliate's id; "PENDING" when not set. */
const statusOf = new Map<string, string>();
/** Every money request PayPal received, and every read of a batch. */
let posts = 0;
let gets = 0;
/** "lost": the next money request is not made and its answer is lost (a 503). "made": made, and its answer lost. */
let loseNext: "" | "lost" | "made" = "";
/** How the next reads of a batch fail: a 503, a success that is not JSON, or no answer at all. */
let readFault: "" | "503" | "garbage" | "throw" = "";
const batches = new Map<string, string>();
/**
 * How PayPal's read writes each item back (pre-review of b70909c20b): "" as it was sent; "short" and "padded" the same
 * amount in another plain decimal form (30 for 30.00, 30.000); "upper" and "spaced" the same address in capitals or
 * with spaces around it; "lower" the address in small letters. `value` and `receiver` replace them outright.
 */
let readShape: "" | "short" | "padded" | "upper" | "spaced" | "lower" = "";
let readValue: ((value: string, sender: string) => string) | null = null;
/** Runs while PayPal is being read, before its answer comes back (the batch can change in our records meanwhile). */
let duringRead: (() => Promise<void>) | null = null;
function shapedItem(item: Item): Item {
  const value = readValue ? readValue(item.amount.value, item.sender_item_id)
    : readShape === "short" ? String(Number(item.amount.value)) : readShape === "padded" ? `${item.amount.value}0` : item.amount.value;
  const receiver = readShape === "upper" ? item.receiver.toUpperCase() : readShape === "spaced" ? ` ${item.receiver} `
    : readShape === "lower" ? item.receiver.toLowerCase() : item.receiver;
  return { ...item, receiver, amount: { ...item.amount, value } };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    const lose = loseNext;
    loseNext = "";
    if (lose === "lost") return json({ name: "INTERNAL_SERVICE_ERROR" }, 503);
    const key = String((init.headers as Record<string, string>)["PayPal-Request-Id"] ?? "");
    if (!batches.has(key)) {
      const id = `BATCH${batches.size + 1}OWN`;
      batches.set(key, id);
      const body = JSON.parse(String(init.body)) as { sender_batch_header: { sender_batch_id: string }; items: Item[] };
      account.set(id, {
        sender: body.sender_batch_header.sender_batch_id,
        items: body.items.map(({ sender_item_id, receiver, amount }) => ({ sender_item_id, receiver, amount: { ...amount } })),
      });
    }
    if (lose === "made") return json({ name: "INTERNAL_SERVICE_ERROR" }, 503);
    return json({ batch_header: { payout_batch_id: batches.get(key), batch_status: "PENDING" } }, 201);
  }
  const read = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(url.pathname);
  if (read && (init?.method ?? "GET") === "GET") {
    gets += 1;
    if (readFault === "503") return json({ name: "INTERNAL_SERVICE_ERROR" }, 503);
    if (readFault === "garbage") return new Response("<html>busy</html>", { status: 200 });
    if (readFault === "throw") throw new Error("Synthetic: the line dropped");
    if (duringRead) await duringRead();
    const id = decodeURIComponent(read[1]);
    const made = account.get(id);
    if (!made) return json({ name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." }, 404);
    return json({
      batch_header: { payout_batch_id: id, batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: made.sender } },
      items: made.items.map((item, i) => ({
        payout_item_id: `${id}ITEM${i}`,
        payout_batch_id: id,
        transaction_status: statusOf.get(item.sender_item_id) ?? "PENDING",
        payout_item: shapedItem(item),
      })),
      total_items: made.items.length,
      total_pages: 1,
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidowncheck00001", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd", email: "owner@example.com",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

const realNow = Date.now;
/** Moves the clock forward, as the days pass between the daily runs. */
function later(ms: number): void {
  const offset = ms;
  const before = Date.now;
  Date.now = () => before() + offset;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  Date.now = realNow;
  posts = 0;
  gets = 0;
  loseNext = "";
  readFault = "";
  readShape = "";
  readValue = null;
  duringRead = null;
  batches.clear();
  account.clear();
  statusOf.clear();
  const at = Math.floor(realNow() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, SARA, person(SARA, "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, TOM, person(TOM, "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", SARA, 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", TOM, 5000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
/** Runs `body` with one kind of pipeline answered by `fault` instead of Redis, the first time only. */
async function withFault<T>(match: (commands: Commands) => boolean, fault: (commands: Commands) => Promise<unknown[]>, body: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  let hit = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!hit && match(commands)) {
      hit = true;
      return fault(commands);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return { value: await body(), hit };
  } finally {
    redis.pipeline = real;
  }
}
const openFields = async () => {
  const [all] = await real([["HGETALL", OPEN]]);
  return (Array.isArray(all) ? all.filter((_, i) => i % 2 === 0) : Object.keys((all ?? {}) as object)).map(String).sort();
};
const openEntry = async (field: string) => {
  const [raw] = await real([["HGET", OPEN, field]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
};
const payoutsOf = async (aff: string) => {
  const [all] = await real([["HGETALL", PAYOUTS]]);
  const values = Array.isArray(all) ? all.filter((_, i) => i % 2 === 1) : Object.values((all ?? {}) as object);
  return values.map((v) => JSON.parse(String(v)) as { aff: string; cents: number; reference: string }).filter((p) => p.aff === aff);
};
const inDailyJob = async (store: Store) => (await real([["SISMEMBER", STORES, store.sid]]))[0];

type Resolve = (store: Store, batch: string, paypalId: unknown) => Promise<Record<string, unknown>>;
const resolveOwnCheck = (paypal as unknown as { resolveOwnCheck: Resolve }).resolveOwnCheck;
const readOwnCheckAnswer = (paypal as unknown as { readOwnCheckAnswer: (body: unknown) => unknown }).readOwnCheckAnswer;

/**
 * The press loses PayPal's answer, and a week of daily runs later the batch is left for the creator's own check.
 * "made": PayPal did make the batch (so it has a payout batch ID); "lost": it never did.
 */
async function leftForOwnCheck(store: Store, how: "made" | "lost" = "made"): Promise<{ field: string; id: string }> {
  loseNext = how;
  const press = await payWithPayPal(store);
  if (press.ok || press.reason !== "unknown") throw new Error(`expected an unknown press, got ${JSON.stringify(press)}`);
  later(paypal.UNKNOWN_MANUAL_AFTER_MS + 60_000);
  await settlePayPal(store);
  const [field] = await openFields();
  return { field, id: batches.get(field.slice(1)) ?? "" };
}

/** Nothing was marked: the batch is still the creator's to check, its people on their way, nothing sent. */
async function untouched(store: Store, field: string, what: string): Promise<void> {
  is(`${what}: the batch is still left for the creator's check`, [await openFields(), await paypalChecks(store)], [[field], { checking: 0, manual: 2 }]);
  is(`${what}: nobody written down as paid`, (await payoutsOf(SARA)).length + (await payoutsOf(TOM)).length, 0);
  is(`${what}: nothing sent to PayPal`, posts, 1);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_own_check_only";
  console.error = () => {};
  const store = shop();

  part("The batch is left for the creator's own check, and the studio lists it");
  await seed(store);
  const { field, id } = await leftForOwnCheck(store);
  is("one batch is open, under its '?' entry", field.startsWith("?"), true);
  is("PayPal did make it, under a payout batch ID", /^BATCH\dOWN$/.test(id), true);
  is("both people are left for the creator's own check", await paypalChecks(store), { checking: 0, manual: 2 });
  const listed = await paypalOwnChecks(store);
  is("the studio lists it", listed.map((b) => b.id), [field]);
  is("its people and amounts", listed[0].lines.map((l) => [l.a, l.c]).sort(), [[SARA, 3000], [TOM, 1500]]);

  part("The creator's word alone, or 'paid' alone, is refused: the payout batch ID is required");
  // Rule 23: was { ok: true, paid: 1, unpaid: 1, gone: 0 } (the creator's per-person answer saved); the owner's decision
  // (item 10) refuses it.
  is("the per-person answer, without an ID", await resolveOwnCheck(store, field, { paid: [SARA], unpaid: [TOM] }), { ok: false, reason: "id" });
  is("'paid' alone", await resolveOwnCheck(store, field, "paid"), { ok: false, reason: "id" });
  is("no ID", await resolveOwnCheck(store, field, ""), { ok: false, reason: "id" });
  is("blanks only", await resolveOwnCheck(store, field, "   "), { ok: false, reason: "id" });
  is("PayPal was not asked", gets, 0);
  await untouched(store, field, "no ID");

  part("An ID of another shape is refused before PayPal is asked");
  for (const bad of ["BATCH 1OWN", "batch1own!", "ABC", "X".repeat(31), "nl-statsown0001-abc", field]) {
    is(`"${bad.slice(0, 20)}": refused`, await resolveOwnCheck(store, field, bad), { ok: false, reason: "id" });
  }
  is("PayPal was not asked", gets, 0);
  await untouched(store, field, "an invalid ID");

  part("An ID that is not a payment of the creator's own PayPal: not found, nothing marked");
  is("refused as not found", await resolveOwnCheck(store, field, "BATCH404NOWHERE"), { ok: false, reason: "not-found" });
  is("PayPal was asked once", gets, 1);
  await untouched(store, field, "an ID PayPal does not find");

  part("The ID of another batch in the creator's PayPal: refused, even with the same people and amounts");
  const made = account.get(id);
  if (!made) throw new Error("the batch PayPal made is missing");
  account.set("BATCH77OTHER", { sender: "nl-statsown0001-other", items: made.items.map((item) => ({ ...item, amount: { ...item.amount } })) });
  is("refused as another batch", await resolveOwnCheck(store, field, "BATCH77OTHER"), { ok: false, reason: "other" });
  await untouched(store, field, "another batch's ID");

  part("The right batch, but its amounts or people differ from what we sent: refused");
  const original = made.items.map((item) => ({ ...item, amount: { ...item.amount } }));
  const tamper = (change: (items: Item[]) => Item[]) => account.set(id, { sender: made.sender, items: change(original.map((item) => ({ ...item, amount: { ...item.amount } }))) });
  for (const [why, change] of [
    ["an amount differs", (items: Item[]) => items.map((item) => (item.sender_item_id === TOM ? { ...item, amount: { ...item.amount, value: "14.00" } } : item))],
    ["a currency differs", (items: Item[]) => items.map((item) => (item.sender_item_id === TOM ? { ...item, amount: { ...item.amount, currency: "EUR" } } : item))],
    ["a recipient differs", (items: Item[]) => items.map((item) => (item.sender_item_id === SARA ? { ...item, receiver: "someone@example.net" } : item))],
    ["someone is missing", (items: Item[]) => items.filter((item) => item.sender_item_id !== TOM)],
    ["someone else is in it", (items: Item[]) => [...items, { sender_item_id: CARL, receiver: "carl@example.com", amount: { currency: "USD", value: "5.00" } }]],
    ["someone is in it twice", (items: Item[]) => [...items, items[0]]],
  ] as const) {
    tamper(change);
    is(`${why}: refused`, await resolveOwnCheck(store, field, id), { ok: false, reason: "mismatch" });
  }
  account.set(id, { sender: made.sender, items: original });
  await untouched(store, field, "amounts or people that differ");

  part("PayPal's answer is not known: nothing marked, and the studio is told so");
  for (const fault of ["503", "garbage", "throw"] as const) {
    readFault = fault;
    is(`a read that fails (${fault}): not known`, await resolveOwnCheck(store, field, id), { ok: false, reason: "unknown" });
  }
  readFault = "";
  await untouched(store, field, "an unknown read");

  part("A batch kept with no fingerprint of where it went: the recipients cannot be matched, so it is refused");
  const entry = await openEntry(field);
  if (!entry) throw new Error("the batch is missing");
  await real([["HSET", OPEN, field, JSON.stringify({ ...entry, lines: (entry.lines as { a: string; c: number }[]).map(({ a, c }) => ({ a, c })) })]]);
  is("refused", await resolveOwnCheck(store, field, id), { ok: false, reason: "mismatch" });
  await real([["HSET", OPEN, field, JSON.stringify(entry)]]);
  await untouched(store, field, "no fingerprint");

  part("Holding the batch under its ID is not confirmed: nothing is said saved, and the batch stays");
  const isHold = (commands: Commands) => commands[0]?.[0] === "HSET" && commands[0][1] === OPEN && commands[0][2] === id;
  const unheld = await withFault(isHold, async () => ["QUEUED"], () => resolveOwnCheck(store, field, id));
  is("the hold was the one that failed", unheld.hit, true);
  is("not saved", unheld.value, { ok: false, reason: "error" });
  await untouched(store, field, "a hold not confirmed");

  part("The right ID: the batch is held under it, and the settling writes what PayPal says, once");
  // Rule 23: replaces "PayPal paid Sara and not Tom" by the creator's word; now PayPal's own word, per item.
  const before = gets;
  is("saved", await resolveOwnCheck(store, field, `  ${id.toLowerCase()} `), { ok: true, batch: id, people: 2 });
  is("PayPal was read for it", gets > before, true);
  is("nothing is sent to PayPal", posts, 1);
  is("the batch is held under its ID", await openFields(), [id]);
  is("with its own reference, and no mark for the creator's check", [(await openEntry(id))?.s, (await openEntry(id))?.m], [field.slice(1), undefined]);
  is("nobody is left for the creator's check", await paypalChecks(store), { checking: 0, manual: 0 });
  is("both are still on their way until PayPal says each went", [...(await onTheirWay(store))].sort(), [SARA, TOM]);
  statusOf.set(SARA, "SUCCESS");
  statusOf.set(TOM, "RETURNED");
  is("the settling: Sara paid, Tom owed again", await settlePayPal(store), { paid: 1, released: 1, waiting: 0 });
  const sara = await payoutsOf(SARA);
  is("Sara has one payout, for what the batch sent her, under PayPal's own item", sara.map((p) => [p.cents, p.reference.startsWith(`PayPal ${id}ITEM`)]), [[3000, true]]);
  is("Tom has none", (await payoutsOf(TOM)).length, 0);
  const book = await readBook(store);
  const owed = (aff: string) => book.rows.find((r) => r.affiliate.id === aff)?.payable;
  is("the book owes Sara nothing and Tom his 15.00", [owed(SARA), owed(TOM)], [0, 1500]);
  is("the store leaves the daily job", await inDailyJob(store), 0);
  is("settling again writes nothing more", [await settlePayPal(store), (await payoutsOf(SARA)).length], [{ paid: 0, released: 0, waiting: 0 }, 1]);
  const press = await payWithPayPal(store);
  is("the next press pays Tom alone", press.ok ? [press.people, press.cents] : press.reason, [1, 1500]);
  is("asking again finds nothing to answer", await resolveOwnCheck(store, field, id), { ok: false, reason: "gone" });

  part("The same ID for two batches: refused");
  await seed(store);
  const first = await leftForOwnCheck(store);
  is("the first batch is saved under its ID", await resolveOwnCheck(store, first.field, first.id), { ok: true, batch: first.id, people: 2 });
  const second = "?nl-statsown0001-second";
  await real([["HSET", OPEN, second, JSON.stringify({ at: realNow(), currency: "usd", lines: [{ a: CARL, c: 900, r: "0".repeat(64) }], m: 1 })]]);
  const asked = gets;
  is("a second batch with the same ID, while the first is held under it: refused", await resolveOwnCheck(store, second, first.id), { ok: false, reason: "used" });
  is("PayPal was not asked", gets, asked);
  statusOf.set(SARA, "SUCCESS");
  statusOf.set(TOM, "SUCCESS");
  await settlePayPal(store);
  is("the first is settled and gone", await openFields(), [second]);
  is("the same ID after that: still refused, as another batch's", await resolveOwnCheck(store, second, first.id), { ok: false, reason: "other" });
  is("the second batch stays for the creator's check", await openFields(), [second]);

  part("A batch PayPal never made has no ID: it cannot be cleared by the creator's word");
  await seed(store);
  const never = await leftForOwnCheck(store, "lost");
  is("PayPal has no batch for it", never.id, "");
  is("'not paid' by the creator's word: refused", await resolveOwnCheck(store, never.field, { paid: [], unpaid: [SARA, TOM] }), { ok: false, reason: "id" });
  is("still left for the creator's check", await paypalChecks(store), { checking: 0, manual: 2 });

  part("Batches that are not the creator's to answer");
  await seed(store);
  const other = await leftForOwnCheck(store);
  is("a batch that is not there is gone", await resolveOwnCheck(store, "?nl-statsown0001-zzzz", other.id), { ok: false, reason: "gone" });
  is("a batch PayPal named is not the creator's to answer", await resolveOwnCheck(store, "BATCH9OWN", other.id), { ok: false, reason: "gone" });
  await seed(store);
  loseNext = "made";
  await payWithPayPal(store);
  const [asking] = await openFields();
  is("a batch still being asked of PayPal: refused", await resolveOwnCheck(store, asking, batches.get(asking.slice(1))), { ok: false, reason: "gone" });
  is("it stays, and is being checked", await paypalChecks(store), { checking: 2, manual: 0 });
  is("and is not in the creator's list", (await paypalOwnChecks(store)).length, 0);

  part("The answer the route reads");
  // Rule 23: was { batch, paid, unpaid } lists of affiliates; now the batch and the payout batch ID, normalized.
  is("a batch and an ID", readOwnCheckAnswer({ batch: field, paypal: " batch1own " }), { batch: field, paypal: "BATCH1OWN" });
  is("the per-person answer carries no ID", readOwnCheckAnswer({ batch: field, paid: [SARA], unpaid: [TOM] }), { batch: field, paypal: "" });
  is("an ID of another shape is no ID", readOwnCheckAnswer({ batch: field, paypal: "BATCH 1" }), { batch: field, paypal: "" });
  for (const [why, body] of [
    ["no batch", { paypal: "BATCH1OWN" }],
    ["a batch that is not a '?' one", { batch: "BATCH1OWN", paypal: "BATCH1OWN" }],
  ] as const) {
    is(`${why}: refused`, readOwnCheckAnswer(body), null);
  }
  const route = readFileSync("app/api/store/affiliates/paypal/route.ts", "utf8");
  is("the route counts the read against the store's calls to other services before asking PayPal", /withinServiceWhy\("paypal-check"/.test(route), true);
  is("the route refuses a missing ID before counting anything", route.indexOf('fail("id")') > 0 && route.indexOf('fail("id")') < route.indexOf('"paypal-check"'), true);

  await rest(store);
  done();
}

/** The two smaller findings of the same pre-review, and the panel's words. */
async function rest(store: Store): Promise<void> {
  part("The '?' entry could be confirmed neither written nor removed: the store is put in the daily job again");
  await seed(store);
  const isFirstWrite = (commands: Commands) => commands[0]?.[0] === "HSET" && commands[0][1] === OPEN && String(commands[0][2]).startsWith("?") && commands[1]?.[0] === "SADD";
  const isOpenDelete = (commands: Commands) => commands[0]?.[0] === "HDEL" && commands[0][1] === OPEN;
  // Only the HSET was applied (the SADD was not), its answer is of another shape, and the removal fails too.
  const faults = { write: 0, remove: 0 };
  redis.pipeline = (async (commands: Commands) => {
    if (!faults.write && isFirstWrite(commands)) {
      faults.write += 1;
      await real([commands[0]]);
      return ["OK", "OK"];
    }
    if (!faults.remove && isOpenDelete(commands)) {
      faults.remove += 1;
      throw new Error("Synthetic: the HDEL failed");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let press: unknown = null;
  try {
    press = await payWithPayPal(store);
  } finally {
    redis.pipeline = real;
  }
  is("both faults were hit", faults, { write: 1, remove: 1 });
  is("the store was not put in the daily job by the first write", (await openFields()).length, 1);
  is("the press says the batch may still go", press, { ok: false, reason: "pending" });
  // Rule 23: new assertion, red on main (0): the settling finds the '?' entry without the creator opening the studio.
  is("the store is in the daily job", await inDailyJob(store), 1);

  await forms(store);

  part("The panel's words");
  const panel = readFileSync("components/paypal-payouts.tsx", "utf8");
  // Rule 23: new assertion, red on main: a batch never sent, or refused, can be in that count too.
  is("it no longer says PayPal's answer did not reach us", panel.includes("its answer to the payment did not reach us"), false);
  // Rule 23: was "What does your PayPal activity show?" and "Yes, save this" (the per-person answer); now the payout
  // batch ID, where to find it, and a check with PayPal.
  is("the creator's check asks for the payout batch ID and says where to find it", ["payout batch ID", "Payouts", "Check this ID with PayPal"].every((t) => panel.includes(t)), true);
  is("no per-person answer is offered any more", ["PayPal paid them", "PayPal did not pay them"].some((t) => panel.includes(t)), false);
  // Rule 23: was "or does not show a payment to them at all" (the creator's "not paid" word for a batch PayPal does not
  // show); the creator's word no longer clears a batch, so the panel says what happens without an ID.
  is("the panel says what happens without an ID", panel.includes("Without that ID"), true);
  is("each refusal has its own words", ['"not-found":', "other:", "mismatch:", "used:", '"own-unknown":'].every((t) => panel.includes(t)), true);
  // Rule 23: new assertions (pre-review of b70909c20b, VR 2), red on b70909c20b: a save whose answer was lost, or a
  // request that never got an answer, may have been saved, so the panel never says nothing was.
  is("a save not confirmed is not said to be unsaved", panel.includes('"own-error": "We could not confirm it was saved. Reload the page to see where it stands."'), true);
  is("the panel never says 'Nothing was saved'", panel.includes("Nothing was saved"), false);
  is("a request with no answer at all has its own words", /lost: "/.test(panel) && /catch \(\)|catch \{/.test(panel.slice(panel.indexOf("async function send"), panel.indexOf("export function PayPalPayouts"))), true);
  // Rule 23: new assertions (pre-review of b70909c20b, AAA 3.3.1/3.3.3/1.3.1), red on b70909c20b: the refusal of an ID
  // is shown with that payment's own form, tied to its field, and "other" names this payment's reference.
  is("the refusal is tied to the payout batch ID field", ["aria-invalid={", "-error`"].every((t) => panel.includes(t)), true);
  is("'other' names the reference instead of pointing below", panel.includes("reference shown below"), false);
  is("'other' gives this payment's reference", /other: "[^"]*\{reference\}/.test(panel), true);
  is("a payment that changed while PayPal was read has its own words", /"own-moved": "[^"]*changed[^"]*while we were checking/.test(panel), true);
}

/** The same amount or address in another plain form is the same; anything else is still refused (pre-review of b70909c20b). */
async function forms(store: Store): Promise<void> {
  part("PayPal writes the same amount in another plain decimal form: matched (30 is 30.00)");
  // Rule 23: new assertions, red on b70909c20b (compared as strings: "30" was a mismatch). PayPal's OpenAPI types
  // amount.value as a string, an integer or a decimal fraction, without fixing its form.
  for (const shape of ["short", "padded"] as const) {
    await seed(store);
    const left = await leftForOwnCheck(store);
    readShape = shape;
    is(`${shape}: saved`, await resolveOwnCheck(store, left.field, left.id), { ok: true, batch: left.id, people: 2 });
  }

  part("PayPal writes the address in capitals, or with spaces around it: matched (an email address, compared in small letters)");
  // Rule 23: new assertions, red on b70909c20b (the fingerprint was of the address exactly as written).
  for (const shape of ["upper", "spaced"] as const) {
    await seed(store);
    const left = await leftForOwnCheck(store);
    readShape = shape;
    is(`${shape}: saved`, await resolveOwnCheck(store, left.field, left.id), { ok: true, batch: left.id, people: 2 });
  }
  await seed(store);
  await redis.pipeline([["HSET", `nl:aff:${STATS}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", paypal: "Sara.Lee@Example.COM", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })]]);
  const mixed = await leftForOwnCheck(store);
  readShape = "lower";
  is("an address kept in capitals, that PayPal writes in small letters: saved", await resolveOwnCheck(store, mixed.field, mixed.id), { ok: true, batch: mixed.id, people: 2 });

  part("An amount in any form that is not a plain decimal is still refused");
  await seed(store);
  const left = await leftForOwnCheck(store);
  for (const odd of ["3e1", "+30.00", "-30.00", "30,00", "30.00 ", " 30.00", "0x1E", "30.", ".5", "", "30.01", "300.0"]) {
    readValue = (value, sender) => (sender === SARA ? odd : value);
    is(`"${odd}": refused`, await resolveOwnCheck(store, left.field, left.id), { ok: false, reason: "mismatch" });
  }
  readValue = null;
  await untouched(store, left.field, "an amount in another form");

  part("The batch changes in our records while PayPal is read: refused with its own reason, nothing marked");
  // Rule 23: new assertion, red on b70909c20b ("gone", which said it was already sorted out, untrue here).
  duringRead = async () => {
    duringRead = null;
    const entry = await openEntry(left.field);
    if (entry) await real([["HSET", OPEN, left.field, JSON.stringify({ ...entry, at: Number(entry.at) + 1 })]]);
  };
  is("changed meanwhile: moved", await resolveOwnCheck(store, left.field, left.id), { ok: false, reason: "moved" });
  await untouched(store, left.field, "a batch that changed meanwhile");
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
