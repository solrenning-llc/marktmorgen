/**
 * A paid pre-order is written down exactly before anything else is said of it (Claude 5's review of #2963, comment
 * 6704653331; CX-123 rule 24). recordPreorder's HSETNX answers 1 (written) or 0 (already there, and then the entry
 * read back by the HGET of the same pipeline must be this same order); the HGET, the EXPIRE and the two SETs that let a
 * refund find it (rule 30) are read in their exact shapes too. Anything else throws UnknownReplyError: no receipt, no
 * hand-over, no "sent" mark on the confirmation, and the next try writes it down.
 *
 * Before: an unknown HSETNX was taken as written. With the product on sale the hand-over found no entry and answered
 * "skip", and the confirmation was marked "sent" for good; coming soon, the receipt went out with nothing kept, so no
 * job was made at launch. Either way the paid pre-order was never handed over.
 *
 * Money: a paid pre-order. Real MemoryRedis; one pipeline's reply replaced, or its write lost, after it ran.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { confirmPreorder, readPreorder } from "@/lib/preorders";
import { confirmPurchase, confirmationKey } from "@/lib/purchase-email";
import { importedFor } from "@/lib/imported-purchases";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

const emails: { to: string | string[]; subject: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;
process.env.RESEND_API_KEY = "re_test_only";
process.env.STRIPE_SECRET_KEY = "sk_test_record_exact_only";

const SID = "pre0stats0rec1";
const shop = { statsId: SID, sid: "presidrec1", handle: "harbor", stripeAccountId: "acct_1Proof0000rec1", pastBuyers: true, name: "Harbor", language: "en", email: "owner@example.com", previousHandles: [], releasedHandles: [] } as unknown as Store;
const product = { id: "prodrec00001", title: "Unreleased Album", course: null } as unknown as Listing;
const deps = { base: "https://example.com/@harbor", from: "Harbor <x@example.com>", ordersLink: async () => null, recordStart: async () => {} };
const session = (n: number, email: string, productId = product.id, handle = "harbor") => ({
  id: `cs_test_prerecord${String(n).padStart(10, "0")}`,
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created: 1_700_000_000,
  amount_total: 2500,
  currency: "usd",
  payment_intent: `pi_prerecord${String(n).padStart(8, "0")}`,
  metadata: { preorder: "yes", store: handle, product: productId },
  customer_details: { email },
});

type Alter = (commands: (string | number)[][], run: (c: (string | number)[][]) => Promise<unknown[]>) => Promise<unknown>;
/** Runs `body` with recordPreorder's pipeline (the one that starts with HSETNX) altered; every other pipeline is real. */
async function altered<T>(alter: Alter, body: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => (c[0]?.[0] === "HSETNX" ? alter(c, real) : real(c))) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}
/** The write never reached Redis, and the reply of the HSETNX was `reply`. */
const lost = (reply: () => unknown): Alter => async (c, run) => [reply(), ...(await run(c.slice(1)))];
/** Every write reached Redis, and the reply in slot `slot` was replaced by `reply`. */
const replyAt = (slot: number, reply: () => unknown): Alter => async (c, run) => {
  const a = await run(c);
  return a.map((r, i) => (i === slot ? reply() : r));
};
const outcomeOf = (p: Promise<unknown>) => p.then((o) => String(o), (e: Error) => `threw ${e.name}`);

const lostReplies: [string, () => unknown][] = [
  ["no reply", () => undefined],
  ["null", () => null],
  ['the text "1"', () => "1"],
  ["2", () => 2],
  ["true", () => true],
  ['"OK"', () => "OK"],
];

for (const [label, reply] of lostReplies) {
  test(`on sale, a lost write answered ${label} hands nothing over, says nothing, and the next try hands it over`, async () => {
    redis.clear();
    emails.length = 0;
    const s = session(1, "ann@example.com");
    const first = await altered(lost(reply), () => outcomeOf(confirmPreorder(shop, s as never, product, deps)));
    assert.equal(first, "threw UnknownReplyError", "never \"skip\", which the confirmation would mark sent for good");
    assert.equal((await importedFor(shop, "ann@example.com")).length, 0);
    assert.equal(emails.length, 0);
    assert.equal(await outcomeOf(confirmPreorder(shop, s as never, product, deps)), "given");
    assert.equal((await importedFor(shop, "ann@example.com")).length, 1);
  });

  test(`coming soon, a lost write answered ${label} sends no receipt, and the next try keeps it and sends one`, async () => {
    redis.clear();
    emails.length = 0;
    redis.run(["SADD", `nl:wl:${SID}:soon`, product.id]);
    const s = session(2, "bob@example.com");
    const first = await altered(lost(reply), () => outcomeOf(confirmPreorder(shop, s as never, product, deps)));
    assert.equal(first, "threw UnknownReplyError", "never a receipt for a pre-order nobody kept");
    assert.equal(emails.length, 0);
    assert.equal(await readPreorder(shop, product.id, s.id), null);
    assert.equal(await outcomeOf(confirmPreorder(shop, s as never, product, deps)), "sent");
    assert.equal((await readPreorder(shop, product.id, s.id))?.to, "bob@example.com");
    assert.equal(emails.length, 1);
  });
}

// The pipeline: HSETNX, HGET, EXPIRE, SET of the payment's pointer, SET of the store's "any" mark.
const landedUnknown: [string, number, () => unknown][] = [
  ["the HSETNX answered null", 0, () => null],
  ["the HSETNX answered 2", 0, () => 2],
  ["the HGET answered nothing", 1, () => undefined],
  ["the HGET answered a number", 1, () => 42],
  ["the HGET answered text that does not parse", 1, () => "{not json"],
  ["the HGET answered null after the HSETNX wrote", 1, () => null],
  ["the EXPIRE answered null", 2, () => null],
  ["the EXPIRE answered 0", 2, () => 0],
  ["the payment's pointer SET answered null", 3, () => null],
  ["the store's mark SET answered null", 4, () => null],
];
for (const [label, slot, reply] of landedUnknown) {
  test(`${label}: nothing is said, and the next try goes on with the one kept entry`, async () => {
    redis.clear();
    emails.length = 0;
    redis.run(["SADD", `nl:wl:${SID}:soon`, product.id]);
    const s = session(3, "cy@example.com");
    assert.equal(await altered(replyAt(slot, reply), () => outcomeOf(confirmPreorder(shop, s as never, product, deps))), "threw UnknownReplyError");
    assert.equal(emails.length, 0);
    assert.equal(await outcomeOf(confirmPreorder(shop, s as never, product, deps)), "sent");
    assert.equal(emails.length, 1);
  });
}

for (const [label, cut] of [
  ["one reply short", (a: unknown[]) => a.slice(0, -1)],
  ["one reply too many", (a: unknown[]) => [...a, "OK"]],
  ["not a list", () => ({ 0: 1 })],
] as [string, (a: unknown[]) => unknown][]) {
  test(`an envelope ${label} says nothing`, async () => {
    redis.clear();
    emails.length = 0;
    redis.run(["SADD", `nl:wl:${SID}:soon`, product.id]);
    const s = session(4, "dee@example.com");
    assert.equal(await altered(async (c, run) => cut(await run(c)), () => outcomeOf(confirmPreorder(shop, s as never, product, deps))), "threw UnknownReplyError");
    assert.equal(emails.length, 0);
  });
}

test("an entry already kept under this checkout for another order is never taken for this one", async () => {
  redis.clear();
  emails.length = 0;
  const s = session(5, "eve@example.com");
  redis.run(["HSET", `nl:pre:${SID}:${product.id}`, s.id, JSON.stringify({ to: "someone-else@example.com", at: 1_700_000_000, pi: "pi_prerecordOTHER001" })]);
  assert.equal(await outcomeOf(confirmPreorder(shop, s as never, product, deps)), "threw UnknownReplyError");
  assert.equal((await importedFor(shop, "eve@example.com")).length, 0);
  assert.equal((await importedFor(shop, "someone-else@example.com")).length, 0);
  assert.equal(emails.length, 0);
});

test("control: the same order confirmed twice reads back as itself (HSETNX 0) and is kept once", async () => {
  redis.clear();
  emails.length = 0;
  redis.run(["SADD", `nl:wl:${SID}:soon`, product.id]);
  const s = session(6, "fay@example.com");
  assert.equal(await outcomeOf(confirmPreorder(shop, s as never, product, deps)), "sent");
  assert.equal(await outcomeOf(confirmPreorder(shop, s as never, product, deps)), "sent");
  assert.equal(redis.run(["HLEN", `nl:pre:${SID}:${product.id}`]), 1);
});

test("through confirmPurchase: a lost write never earns the \"sent\" mark, and the next try confirms it", async () => {
  for (const soon of [false, true]) {
    redis.clear();
    emails.length = 0;
    const owner = "owner@example.com";
    await claimHandle(owner, "harbor", "Harbor Kitchen", "");
    await ensureStatsId(owner);
    await setStripeAccount(owner, "acct_1TestHarborRec1", true);
    await setSubscription(owner, { customerId: "cus_OwnerRec01", subscriptionId: "sub_OwnerRec01", active: true, period: paidPeriod() });
    const made = await addProduct(owner, "Sourdough Course", "", "25", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(owner, made.product.id, "https://example.com/course");
    const store = (await storeForEmail(owner))!;
    const listing = (await readListing(store, made.product.id))!;
    if (soon) redis.run(["SADD", `nl:wl:${store.statsId}:soon`, listing.id]);
    const s = session(soon ? 8 : 7, "gil@example.com", listing.id);
    const first = await altered(lost(() => null), () => outcomeOf(confirmPurchase(store, s.id, s as never)));
    assert.equal(first, "threw UnknownReplyError", `${soon ? "coming soon" : "on sale"}: not said as confirmed`);
    assert.equal(redis.run(["GET", confirmationKey(s.id)]), null, `${soon ? "coming soon" : "on sale"}: no mark, so it is tried again`);
    assert.equal(emails.length, 0);
    assert.equal(await outcomeOf(confirmPurchase(store, s.id, s as never)), "sent");
    assert.equal(redis.run(["GET", confirmationKey(s.id)]), "sent");
    if (soon) assert.equal((await readPreorder(store, listing.id, s.id))?.to, "gil@example.com");
    else assert.equal((await importedFor((await storeForEmail(owner))!, "gil@example.com")).length, 1);
  }
});
