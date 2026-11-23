/**
 * Codex L-20261120-1005 (MEDIUM, personal data; #5010 row 31): a person's copy read their checkout reminder asks from
 * their own index (lib/checkout-ask.ts, askMembersOf) and dropped, in silence, any row of that index it could not
 * read or that named another person or store. The copy then looked complete while the index itself proved a personal
 * row was there. Read exactly (CX-123 rule 24), as the erasure's ASK_FORGET already is: a row of the person's own
 * index that cannot be read, or that is not theirs at this store, makes the copy unknown (UnknownReplyError), never
 * shorter. Synthetic only: an in-memory Redis, no provider reached.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { askIndexKey, askMember, asksOf } from "@/lib/checkout-ask";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const STATS = "st_ask_copy_unknown";
const PERSON = "ask-copy@example.test";
const at = 1_790_000_000;
const own = askMember({ statsId: STATS, handle: "askcopyshop", productId: "p1", email: PERSON, askedAt: at, from: "checkout", after: 3600 });

function seed(...members: string[]) {
  redis.clear();
  for (const [i, member] of members.entries()) redis.run(["ZADD", askIndexKey(STATS, PERSON), at + i, member]);
}

test("the person's own asks are copied, as before", async () => {
  seed(own);
  const asks = await asksOf(STATS, PERSON.toUpperCase());
  assert.deepEqual(asks.map((a) => a.product), ["p1"]);
});

test("a row of their own index that cannot be read makes the copy unknown, never shorter", async () => {
  seed(own, "not a reminder ask");
  await assert.rejects(() => asksOf(STATS, PERSON), UnknownReplyError);
});

test("a row of their own index naming another person makes the copy unknown", async () => {
  const another = askMember({ statsId: STATS, handle: "askcopyshop", productId: "p2", email: "someone-else@example.test", askedAt: at, from: "checkout", after: 3600 });
  seed(own, another);
  await assert.rejects(() => asksOf(STATS, PERSON), UnknownReplyError);
});

test("a row of their own index naming another store makes the copy unknown", async () => {
  const elsewhere = askMember({ statsId: "st_another_store", handle: "othershop", productId: "p3", email: PERSON, askedAt: at, from: "checkout", after: 3600 });
  seed(own, elsewhere);
  await assert.rejects(() => asksOf(STATS, PERSON), UnknownReplyError);
});

test("an empty index is an empty copy", async () => {
  seed();
  assert.deepEqual(await asksOf(STATS, PERSON), []);
});
