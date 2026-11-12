/**
 * The count of what was brought over for an address (lib/buyer-orders.ts:
 * purchasesFor and the download's lookUp) is paid for before the record is
 * read, so an unreadable HLEN reply is unknown, never zero (rule 24, MR): the
 * reading stops there, with nothing more read and nothing taken as zero. An
 * unreadable HKEYS reply is unknown too, never "no such purchase".
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { OrdersMeter, findPurchase, ordersLinkFor, purchasesFor } from "@/lib/buyer-orders";
import { importedKey, importedReference } from "@/lib/imported-purchases";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";

const OWNER = "moss@example.com";
const BUYER = "ana@example.com";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname.includes("resend")) return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** Every command the store is sent, and the replies swapped for a shape the store never gives. */
const sent: string[] = [];
let odd: Record<string, unknown> = {};
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String).join(" "));
  if (commands.length === 1 && odd[String(commands[0][0])] === "LOST") return [];
  const replies = await pipeline(commands);
  return replies.map((reply, i) => (String(commands[i][0]) in odd ? odd[String(commands[i][0])] : reply));
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  sent.length = 0;
  odd = {};
  process.env.STRIPE_SECRET_KEY = "sk_test_orders_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function shop(): Promise<{ store: Store; ids: string[]; token: string }> {
  await claimHandle(OWNER, "moss", "Moss Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMoss000001", true);
  await setSubscription(OWNER, { customerId: "cus_moss000001", subscriptionId: "sub_moss000001", active: true, tier: "creator", period: paidPeriod() });
  const ids: string[] = [];
  for (const title of ["Guide", "Archive"]) {
    const made = await addProduct(OWNER, title, "", "19", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, "https://example.com/notes");
    ids.push(made.product.id);
  }
  const store = { ...((await storeForEmail(OWNER)) as Store), pastBuyers: true };
  await redis.pipeline([["HSET", importedKey(store.statsId!, BUYER), ids[0], JSON.stringify({ at: 1, job: "api:1" }), ids[1], JSON.stringify({ at: 2, job: "api:2" })]]);
  const token = new URL((await ordersLinkFor(store, BUYER, "https://marktmorgen.com/@moss"))!).searchParams.get("token")!;
  return { store, ids, token };
}

for (const reply of ["2", "lots", -1, 1.5, null, {}]) {
  test(`an orders list whose HLEN of what was brought over reads ${JSON.stringify(reply)} reads no record and takes nothing as zero`, async () => {
    const { store } = await shop();
    odd = { HLEN: reply };
    sent.length = 0;
    await assert.rejects(purchasesFor(store, BUYER, new OrdersMeter(store)), UnknownReplyError);
    assert.deepEqual(sent.filter((command) => command.startsWith("HGETALL") && command.includes(importedKey(store.statsId!, BUYER))), []);
  });

  test(`a download of what was brought over whose HLEN reads ${JSON.stringify(reply)} reads no ids and takes nothing as zero`, async () => {
    const { store, ids, token } = await shop();
    odd = { HLEN: reply };
    sent.length = 0;
    await assert.rejects(findPurchase(store, token, importedReference(store.statsId!, BUYER, ids[1])), UnknownReplyError);
    assert.deepEqual(sent.filter((command) => command.startsWith("HKEYS") || command.startsWith("HGET ")), []);
  });
}

for (const reply of ["lots", null, {}, [1, 2]]) {
  test(`a download of what was brought over whose HKEYS reads ${JSON.stringify(reply)} is unknown, never "no such purchase"`, async () => {
    const { store, ids, token } = await shop();
    odd = { HKEYS: reply };
    await assert.rejects(findPurchase(store, token, importedReference(store.statsId!, BUYER, ids[1])), UnknownReplyError);
  });
}

for (const reply of [1, {}, ["x"], "LOST"]) {
  test(`a download of what was brought over whose entry reads ${JSON.stringify(reply)} is unknown, never "no such purchase"`, async () => {
    const { store, ids, token } = await shop();
    odd = { HGET: reply };
    await assert.rejects(findPurchase(store, token, importedReference(store.statsId!, BUYER, ids[1])), UnknownReplyError);
  });
}

// The entry's own fields are read strictly by #2794 (lib/imported-purchases.ts, parse); here, text that is not JSON.
for (const raw of ["{not json", "["]) {
  test(`a download of what was brought over whose entry is text that does not read (${raw}) is unknown, never "no such purchase"`, async () => {
    const { store, ids, token } = await shop();
    odd = { HGET: raw };
    await assert.rejects(findPurchase(store, token, importedReference(store.statsId!, BUYER, ids[1])), UnknownReplyError);
  });
}

test("an entry deleted between its id and its read (HGET nil) is no such purchase", async () => {
  const { store, ids, token } = await shop();
  odd = { HGET: null };
  assert.equal(await findPurchase(store, token, importedReference(store.statsId!, BUYER, ids[1])), null);
});

test("readable replies still find what was brought over", async () => {
  const { store, ids, token } = await shop();
  const found = await findPurchase(store, token, importedReference(store.statsId!, BUYER, ids[1]));
  assert.deepEqual([found?.purchase.productId, found?.purchase.kind], [ids[1], "imported"]);
  const listed = await purchasesFor(store, BUYER, new OrdersMeter(store));
  assert.ok(listed.some((purchase) => purchase.productId === ids[0] && purchase.kind === "imported"));
});
