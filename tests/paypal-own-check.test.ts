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
 * The studio said to check PayPal and pay them "from there", but nothing the
 * creator did there cleared the mark.
 *
 * Now the creator says, person by person, what PayPal shows: paid (written
 * into the book once, under a reference naming the batch, so a retry never
 * writes it twice) or not paid (owed again, and paid with the next payment
 * the creator confirms). Nothing is sent to PayPal by this answer.
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
import { connectPayPal, onTheirWay, paypalChecks, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
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

/** Every money request PayPal received. */
let posts = 0;
/** When true, PayPal's answer to the next money request is lost (a 503): it may have been made. */
let loseNext = false;
const batches = new Map<string, string>();
const sentBodies: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    sentBodies.push(String(init.body));
    if (loseNext) {
      loseNext = false;
      return json({ name: "INTERNAL_SERVICE_ERROR" }, 503);
    }
    const key = String((init.headers as Record<string, string>)["PayPal-Request-Id"] ?? "");
    if (!batches.has(key)) batches.set(key, `BATCH${batches.size + 1}OWN`);
    return json({ batch_header: { payout_batch_id: batches.get(key), batch_status: "PENDING" } }, 201);
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
  loseNext = false;
  batches.clear();
  sentBodies.length = 0;
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
const payoutsOf = async (aff: string) => {
  const [all] = await real([["HGETALL", PAYOUTS]]);
  const values = Array.isArray(all) ? all.filter((_, i) => i % 2 === 1) : Object.values((all ?? {}) as object);
  return values.map((v) => JSON.parse(String(v)) as { aff: string; cents: number; reference: string }).filter((p) => p.aff === aff);
};
const inDailyJob = async (store: Store) => (await real([["SISMEMBER", STORES, store.sid]]))[0];

type Resolve = (store: Store, batch: string, answer: { paid: string[]; unpaid: string[] }) => Promise<Record<string, unknown>>;
type OwnChecks = (store: Store) => Promise<{ id: string; at: number; currency: string; lines: { a: string; c: number }[] }[]>;
const resolveOwnCheck = (paypal as unknown as { resolveOwnCheck?: Resolve }).resolveOwnCheck;
const paypalOwnChecks = (paypal as unknown as { paypalOwnChecks?: OwnChecks }).paypalOwnChecks;
const readOwnCheckAnswer = (paypal as unknown as { readOwnCheckAnswer?: (body: unknown) => unknown }).readOwnCheckAnswer;

/** The press loses PayPal's answer, and a week of daily runs later the batch is left for the creator's own check. */
async function leftForOwnCheck(store: Store): Promise<string> {
  loseNext = true;
  const press = await payWithPayPal(store);
  if (press.ok || press.reason !== "unknown") throw new Error(`expected an unknown press, got ${JSON.stringify(press)}`);
  later(paypal.UNKNOWN_MANUAL_AFTER_MS + 60_000);
  await settlePayPal(store);
  const [field] = await openFields();
  return field;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_own_check_only";
  console.error = () => {};
  const store = shop();

  part("The defect: a batch left for the creator's own check keeps its people on their way, with no way out");
  await seed(store);
  const field = await leftForOwnCheck(store);
  is("one batch is open, under its '?' entry", field.startsWith("?"), true);
  is("both people are left for the creator's own check", await paypalChecks(store), { checking: 0, manual: 2 });
  is("PayPal was asked for the money once", posts, 1);
  // A month on, both earned again: neither can be paid by PayPal, by a payout file or a recorded batch.
  later(30 * 86_400_000);
  await settlePayPal(store);
  is("still on their way a month later", [...(await onTheirWay(store))].sort(), [SARA, TOM]);
  is("the store is still in the daily job", await inDailyJob(store), 1);
  is("the press finds nobody to pay", await payWithPayPal(store), { ok: false, reason: "nothing" });
  // Rule 23: new assertions, red on main (the functions do not exist): the studio can list the batch and settle it.
  is("the studio can list the batch for the creator's check", typeof paypalOwnChecks, "function");
  is("and the creator can say what PayPal shows", typeof resolveOwnCheck, "function");
  if (!paypalOwnChecks || !resolveOwnCheck || !readOwnCheckAnswer) {
    await rest(store);
    done();
    return;
  }

  part("The studio lists the batch: when it was sent, and who for how much");
  const listed = await paypalOwnChecks(store);
  is("one batch", listed.map((b) => b.id), [field]);
  is("its people and amounts", listed[0].lines.map((l) => [l.a, l.c]).sort(), [[SARA, 3000], [TOM, 1500]]);
  is("its currency", listed[0].currency, "usd");

  part("PayPal paid Sara and not Tom: Sara is written down as paid once, Tom is owed again, nothing is sent");
  const answered = await resolveOwnCheck(store, field, { paid: [SARA], unpaid: [TOM] });
  is("the answer is saved", answered, { ok: true, paid: 1, unpaid: 1, gone: 0 });
  is("nothing is sent to PayPal by the answer", posts, 1);
  is("nothing is left open", await openFields(), []);
  is("nobody is on their way", (await onTheirWay(store)).size, 0);
  is("nobody is left for the creator's own check", await paypalChecks(store), { checking: 0, manual: 0 });
  const sara = await payoutsOf(SARA);
  is("Sara has one payout, for what the batch sent her", sara.map((p) => p.cents), [3000]);
  is("its reference names the batch and the creator's check", sara[0]?.reference, `PayPal ${field.slice(1)}, checked by you`);
  is("Tom has none", (await payoutsOf(TOM)).length, 0);
  const book = await readBook(store);
  const owed = (aff: string) => book.rows.find((r) => r.affiliate.id === aff)?.payable;
  is("the book owes Sara nothing and Tom his 15.00", [owed(SARA), owed(TOM)], [0, 1500]);
  await settlePayPal(store);
  is("the store leaves the daily job", await inDailyJob(store), 0);
  const press = await payWithPayPal(store);
  is("the next press pays Tom alone", press.ok ? [press.people, press.cents] : press.reason, [1, 1500]);
  is("in one more money request", posts, 2);
  is("asking again finds nothing to answer", await resolveOwnCheck(store, field, { paid: [SARA], unpaid: [TOM] }), { ok: false, reason: "gone" });
  is("and writes nothing more", (await payoutsOf(SARA)).length, 1);

  part("Both paid");
  await seed(store);
  const both = await leftForOwnCheck(store);
  is("saved", await resolveOwnCheck(store, both, { paid: [SARA, TOM], unpaid: [] }), { ok: true, paid: 2, unpaid: 0, gone: 0 });
  is("one payout each", [(await payoutsOf(SARA)).length, (await payoutsOf(TOM)).length], [1, 1]);
  is("the press then finds nobody owed", await payWithPayPal(store), { ok: false, reason: "nothing" });

  part("An answer that does not cover exactly the people in the batch is refused, and changes nothing");
  await seed(store);
  const exact = await leftForOwnCheck(store);
  for (const [why, answer] of [
    ["one person left out", { paid: [SARA], unpaid: [] }],
    ["someone not in the batch", { paid: [SARA, "cccccccccccc"], unpaid: [TOM] }],
    ["one person both ways", { paid: [SARA, TOM], unpaid: [TOM] }],
    ["one person twice", { paid: [SARA, SARA], unpaid: [TOM] }],
  ] as const) {
    is(`${why}: refused`, await resolveOwnCheck(store, exact, { paid: [...answer.paid], unpaid: [...answer.unpaid] }), { ok: false, reason: "changed" });
  }
  is("the batch is still there", await openFields(), [exact]);
  is("no payout written", (await payoutsOf(SARA)).length + (await payoutsOf(TOM)).length, 0);
  is("a batch that is not there is gone", await resolveOwnCheck(store, "?nl-statsown0001-zzzz", { paid: [SARA], unpaid: [TOM] }), { ok: false, reason: "gone" });
  is("a batch PayPal named is not the creator's to answer", await resolveOwnCheck(store, "BATCH9OWN", { paid: [SARA], unpaid: [TOM] }), { ok: false, reason: "gone" });

  part("A batch still being asked of PayPal (not yet the creator's check) cannot be answered");
  await seed(store);
  loseNext = true;
  await payWithPayPal(store);
  const [asking] = await openFields();
  is("refused", await resolveOwnCheck(store, asking, { paid: [SARA], unpaid: [TOM] }), { ok: false, reason: "gone" });
  is("it stays, and is being checked", await paypalChecks(store), { checking: 2, manual: 0 });
  is("and is not in the creator's list", (await paypalOwnChecks(store)).length, 0);

  part("A payout write that fails halfway: nothing is lost, and a second answer never writes one twice");
  await seed(store);
  const half = await leftForOwnCheck(store);
  const isPayoutWrite = (commands: Commands) => commands[0]?.[0] === "HSET" && commands[0][1] === PAYOUTS;
  const lost = await withFault(isPayoutWrite, async (commands) => {
    await real(commands);
    throw new Error("Synthetic: the payout's HSET was applied and its answer lost");
  }, () => resolveOwnCheck(store, half, { paid: [SARA, TOM], unpaid: [] }));
  is("the payout write was the one that failed", lost.hit, true);
  is("the answer is not saved", lost.value, { ok: false, reason: "error" });
  is("the batch is still there, so its people stay on their way", await openFields(), [half]);
  is("again: saved", await resolveOwnCheck(store, half, { paid: [SARA, TOM], unpaid: [] }), { ok: true, paid: 2, unpaid: 0, gone: 0 });
  is("one payout each, never two", [(await payoutsOf(SARA)).length, (await payoutsOf(TOM)).length], [1, 1]);

  part("Taking the batch away fails: the answer is not saved, and a second answer writes nothing twice");
  await seed(store);
  const stuck = await leftForOwnCheck(store);
  const isOpenDelete = (commands: Commands) => commands[0]?.[0] === "HDEL" && commands[0][1] === OPEN;
  const kept = await withFault(isOpenDelete, async () => ["QUEUED"], () => resolveOwnCheck(store, stuck, { paid: [SARA], unpaid: [TOM] }));
  is("the removal was the one that failed", kept.hit, true);
  is("the answer is not said saved", kept.value, { ok: false, reason: "error" });
  is("Tom is still on his way, never owed while the batch may stay", (await onTheirWay(store)).has(TOM), true);
  is("again: saved", await resolveOwnCheck(store, stuck, { paid: [SARA], unpaid: [TOM] }), { ok: true, paid: 1, unpaid: 1, gone: 0 });
  is("Sara has one payout, never two", (await payoutsOf(SARA)).length, 1);
  is("changing the answer after Sara was written down as paid is refused", (await (async () => {
    await seed(store);
    const again = await leftForOwnCheck(store);
    await withFault(isOpenDelete, async () => ["QUEUED"], () => resolveOwnCheck(store, again, { paid: [SARA], unpaid: [TOM] }));
    return resolveOwnCheck(store, again, { paid: [], unpaid: [SARA, TOM] });
  })()), { ok: false, reason: "changed" });

  part("The payouts cannot be read exactly: nothing is written, nothing is released");
  await seed(store);
  const blind = await leftForOwnCheck(store);
  const isPayoutsRead = (commands: Commands) => commands[0]?.[0] === "HGETALL" && commands[0][1] === PAYOUTS;
  const unread = await withFault(isPayoutsRead, async () => [["odd"]], () => resolveOwnCheck(store, blind, { paid: [SARA], unpaid: [TOM] }));
  is("the read was the one that failed", unread.hit, true);
  is("not saved", unread.value, { ok: false, reason: "error" });
  is("the batch stays", await openFields(), [blind]);
  is("no payout", (await payoutsOf(SARA)).length, 0);

  part("A person no longer in the program: nothing written for them, and the batch is settled");
  await seed(store);
  const left = await leftForOwnCheck(store);
  await real([["HDEL", `nl:aff:${STATS}:people`, TOM]]);
  is("saved, Tom counted as gone", await resolveOwnCheck(store, left, { paid: [SARA, TOM], unpaid: [] }), { ok: true, paid: 1, unpaid: 0, gone: 1 });
  is("nothing is left open", await openFields(), []);

  part("The answer the route reads");
  is("a well-formed answer", readOwnCheckAnswer({ batch: field, paid: [SARA], unpaid: [TOM] }), { batch: field, paid: [SARA], unpaid: [TOM] });
  for (const [why, body] of [
    ["no batch", { paid: [SARA], unpaid: [TOM] }],
    ["a batch that is not a '?' one", { batch: "BATCH1OWN", paid: [SARA], unpaid: [TOM] }],
    ["lists that are not lists", { batch: field, paid: SARA, unpaid: [TOM] }],
    ["an id of another shape", { batch: field, paid: ["SARA"], unpaid: [TOM] }],
    ["nobody at all", { batch: field, paid: [], unpaid: [] }],
  ] as const) {
    is(`${why}: refused`, readOwnCheckAnswer(body), null);
  }

  await rest(store);
  done();
}

/** The two smaller findings of the same pre-review. */
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

  part("The 'being checked' sentence says only what is known");
  const panel = readFileSync("components/paypal-payouts.tsx", "utf8");
  // Rule 23: new assertion, red on main: a batch never sent, or refused, can be in that count too.
  is("it no longer says PayPal's answer did not reach us", panel.includes("its answer to the payment did not reach us"), false);
  is("the creator's check asks what PayPal shows, with a confirmation", ["What does your PayPal activity show?", "Yes, save this"].every((t) => panel.includes(t)), true);
  // Pre-review (9 November 2026): a batch whose request never reached PayPal shows nothing in the activity, and nothing
  // sends it again; the warning must let the creator answer "did not pay" then, or the affiliate is never paid.
  is("the warning names a payment PayPal does not show at all as not paid", panel.includes("or does not show a payment to them at all"), true);
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
