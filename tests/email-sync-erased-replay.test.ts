/**
 * Privacy (erase-then-replay): a person deleted from a store is never handed to the creator's email platform — a third
 * party — on a yes they gave before the deletion. The thank-you page has no age limit and a sale's "told" mark lasts
 * 40 days (lib/sale-events.ts), the "handed over" mark 30 (lib/email-sync.ts SEEN_SECONDS): reloading the thank-you
 * page of an order placed before the deletion, after those marks, ran queuePerson again with the checkout's consent and
 * queued the address for the platform, although the deletion (lib/person-erasure.ts) had cleared their jobs. Now
 * queuePerson reads the store's deletion print (lib/suppression.ts) first: a person whose consent is from before the
 * deletion's second is "off", with nothing written and nothing logged; a new yes after it is handed over as anyone's.
 * Synthetic data only; nothing is sent anywhere (the queue is only read).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUEUE_KEY, queuePerson } from "@/lib/email-sync";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "erasedsync0001";
const LIST = "e1a5ed0000aa";
const store = { statsId: STATS, listId: LIST } as Store;
const WHO = "deleted.buyer@example.com";
const cfgKey = `nl:esync:cfg:${STATS}`;
const logKey = `nl:esync:log:${STATS}`;
const ORDER_AT = Date.parse("2026-11-01T10:00:00Z");
const ERASED_SECONDS = Date.parse("2026-11-05T12:00:00Z") / 1000;
let n = 0;
const person = (email: string, at: number, consent = true) => ({ source: "purchase" as const, email, name: "Dana Reyes", products: [], consent, seed: `cs_test_erased${(n += 1)}`, at });

function reset(): void {
  redis.clear();
  redis.run(["SET", cfgKey, JSON.stringify({ handle: "erased", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: ORDER_AT - 86_400_000, connectedAt: ORDER_AT - 86_400_000 })]);
  redis.run(suppressCommand(LIST, WHO, ERASED_SECONDS));
}
const queueSize = () => Number(redis.run(["ZCARD", QUEUE_KEY]));
const logSize = () => Number(redis.run(["LLEN", logKey]));
const holdsAddress = () => (redis.run(["LRANGE", logKey, 0, -1]) as string[]).some((id) => String(redis.run(["GET", `nl:esync:j:${id}`]) ?? "").includes(WHO));

test("a yes from before the deletion, replayed after it, hands nothing over and logs nothing", async () => {
  reset();
  assert.equal(await queuePerson(store, person(WHO, ORDER_AT)), "off");
  assert.equal(queueSize(), 0);
  assert.equal(logSize(), 0);
  assert.equal(holdsAddress(), false);
  // In capitals, as a checkout may give it: the same person.
  assert.equal(await queuePerson(store, person(" Deleted.Buyer@Example.com ", ORDER_AT)), "off");
  assert.equal(queueSize(), 0);
});

test("a yes in the very second of the deletion is not known to be after it", async () => {
  reset();
  assert.equal(await queuePerson(store, person(WHO, ERASED_SECONDS * 1000 + 500)), "off");
  assert.equal(queueSize(), 0);
});

test("a new purchase with the box checked after the deletion is handed over as anyone's", async () => {
  reset();
  assert.equal(await queuePerson(store, person(WHO, (ERASED_SECONDS + 60) * 1000)), "queued");
  assert.equal(queueSize(), 1);
  assert.equal(holdsAddress(), true);
});

test("someone never deleted is handed over as before", async () => {
  reset();
  assert.equal(await queuePerson(store, person("kept.buyer@example.com", ORDER_AT)), "queued");
  assert.equal(queueSize(), 1);
});

test("a deletion print that does not read is unknown: nothing written, never taken as not deleted", async () => {
  for (const value of ["yesterday", "17.5", ""]) {
    reset();
    redis.run(["HSET", suppressedKey(LIST), suppressionPrint(LIST, WHO), value]);
    await assert.rejects(queuePerson(store, person(WHO, (ERASED_SECONDS + 60) * 1000)));
    assert.equal(queueSize(), 0, value);
    assert.equal(logSize(), 0, value);
  }
});
