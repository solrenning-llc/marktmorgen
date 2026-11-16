/**
 * A removed product's private podcast feeds never outlive a person's deletion (nuvem I privacy audit of main
 * @3cdc624a7d, 13 November 2026, ALTO).
 *
 * A feed's grant (nl:pod:t:<sha>) holds the listener's address in plain text, kept for good, found only through
 * its index (nl:pod:by:<sid>:<pid>:<hash>). Removing the product dropped neither, and deleting a person went only
 * over the products still in the catalog: the erasure answered done with the address kept, while the feed itself
 * answered "no longer here" (410) to everyone.
 *
 * Now each new grant also notes its product in the store's set (nl:pod:pids:<sid>), in the same counted write as
 * its index, and a person's deletion (and the copy of their data) goes over the catalog and that set, read exactly
 * (unreadable: the deletion is not finished). A removed product stays in the set, so its feeds stay within reach
 * of every deletion and of the walk at store closing. Grants made before this change for a product removed before
 * it are reached only by that walk (known limit).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { erasePerson } from "@/lib/person-erasure";
import * as access from "@/lib/podcast-access";
import { CLOSING, COUNTED_FAMILIES } from "@/lib/data-families";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, removeProduct, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const owner = "podcast-removed-owner@example.test";
const person = "podcast-removed-person@example.test";
const other = "podcast-removed-other@example.test";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const grantKey = (token: string) => `nl:pod:t:${sha(token)}`;

async function world() {
  redis.clear();
  await claimHandle(owner, "podremoved", "Podcast Removed", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_PodRemoved", subscriptionId: "sub_PodRemoved", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic podcast", "", "27", null);
  assert.ok(made.ok);
  const shop = (await storeForEmail(owner))!;
  const pid = made.product.id;
  const mine = await access.feedToken(shop, pid, person);
  const theirs = await access.feedToken(shop, pid, other);
  assert.ok(mine && theirs, "both listeners have a feed");
  return { sid: shop.statsId!, pid, mine, theirs };
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const oldFetch = globalThis.fetch, oldLog = console.error;
  globalThis.fetch = async () => { throw new Error("No external provider allowed"); };
  console.error = () => {};
  try { return await run(); } finally { globalThis.fetch = oldFetch; console.error = oldLog; }
}

test("a feed of a product removed before is still reached by a person's deletion", () => quietly(async () => {
  const { sid, pid, mine, theirs } = await world();
  const removed = await removeProduct(owner, pid);
  assert.ok(removed.ok);
  const shop = (await storeForEmail(owner))!;
  assert.equal(shop.catalog.items.some((item) => item.id === pid), false);
  const result = await erasePerson(shop, person, { kind: "person" });
  assert.equal(result.ok, true);
  assert.equal(redis.run(["GET", grantKey(mine)]), null, "the person's grant, with their address, is gone");
  assert.notEqual(redis.run(["GET", grantKey(theirs)]), null, "another listener's grant stays");
  assert.equal(redis.run(["SISMEMBER", `nl:pod:pids:${sid}`, pid]), 1, "the removed product stays noted for the next deletion");
}));

test("an unreadable set of podcast products leaves the deletion unfinished, never done", () => quietly(async () => {
  const { pid } = await world();
  await removeProduct(owner, pid);
  const shop = (await storeForEmail(owner))!;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:pod:pids:"))) return [{ garbled: true }];
    return original(commands);
  };
  try {
    const result = await erasePerson(shop, person, { kind: "person" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === "incomplete" && result.failed.includes("lib/podcast-access.ts"));
  } finally { redis.pipeline = original; }
}));

test("the new family is counted and erased when a store closes", () => {
  for (const family of ["nl:pod:pids:"]) {
    assert.ok(COUNTED_FAMILIES.includes(family), `${family} is counted`);
    assert.deepEqual(CLOSING[family], { how: "erase" }, `${family} is erased at closing`);
  }
});

// Codex V on #4471 @e9ad001138 (HIGH): the index and the product note were written in one script and the grant, which
// holds the address, in a second one. A deletion that ran between the two found the index, deleted it, found no grant
// yet and answered done; the second write then left the address in a grant no index leads to.
test("a deletion between a new feed's index and its grant leaves no address behind", () => quietly(async () => {
  const { pid } = await world();
  const shop = (await storeForEmail(owner))!;
  const late = "podcast-removed-late@example.test";
  const original = redis.pipeline.bind(redis);
  let erased: Awaited<ReturnType<typeof erasePerson>> | null = null;
  redis.pipeline = async (commands) => {
    const replies = await original(commands);
    const indexWrite = commands.some((c) => c[0] === "EVAL" && c.some((a) => String(a).startsWith("nl:pod:by:")));
    if (indexWrite && erased === null) {
      redis.pipeline = original;
      erased = await erasePerson((await storeForEmail(owner))!, late, { kind: "person" });
    }
    return replies;
  };
  let token: string | null;
  try { token = await access.feedToken(shop, pid, late); } finally { redis.pipeline = original; }
  assert.ok(erased, "the deletion ran between the feed's writes");
  assert.equal(erased!.ok, true);
  if (token) assert.equal(redis.run(["GET", grantKey(token)]), null, "no grant holds the erased address");
  const left = ((redis.run(["SCAN", "0", "MATCH", "nl:pod:t:*"]) as [string, string[]])[1]).filter((key) => String(redis.run(["GET", key])).includes(late));
  assert.deepEqual(left, [], "no grant anywhere holds the erased address");
}));

// Codex P, T, L and X5 on #4471 @e9ad001138: a feed granted before the product note existed is handed out again
// through its index, and that path returned before any note, so asking again for the link never made the product
// findable once it was removed.
test("asking again for a feed granted before the note notes its product, and its deletion then reaches it", () => quietly(async () => {
  const { sid, pid, mine } = await world();
  redis.run(["DEL", `nl:pod:pids:${sid}`]); // as a grant made before the note existed left it
  assert.equal(await access.feedToken((await storeForEmail(owner))!, pid, person), mine, "the same feed address");
  assert.equal(redis.run(["SISMEMBER", `nl:pod:pids:${sid}`, pid]), 1, "its product is noted before the link is handed out");
  assert.ok((await removeProduct(owner, pid)).ok);
  const result = await erasePerson((await storeForEmail(owner))!, person, { kind: "person" });
  assert.equal(result.ok, true);
  assert.equal(redis.run(["GET", grantKey(mine)]), null, "the grant, with the address, is gone");
}));

test("an unknown reply to the note hands out no link", () => quietly(async () => {
  const { sid, pid } = await world();
  redis.run(["DEL", `nl:pod:pids:${sid}`]);
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "EVAL" && c.some((a) => String(a).startsWith("nl:pod:pids:")))) return [[0, "garbled"]];
    return original(commands);
  };
  let token: unknown;
  try { token = await access.feedToken((await storeForEmail(owner))!, pid, person).catch((error: unknown) => error); } finally { redis.pipeline = original; }
  assert.ok(typeof token !== "string", "no link while its product's note is unknown");
}));
