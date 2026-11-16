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
 * of every deletion and of the walk at store closing.
 *
 * Since the Codex reviews of @e9ad001138 (V, P, N1, T, X5): a new feed's index, note and grant are one script; a feed
 * asked for again notes its product; feeds granted before the note are noted by a one-time walk (notePodcastProducts,
 * run hourly by app/api/cron/recount until done), and until it is done a deletion and a copy look for the person's own
 * old indexes by a read-only SCAN, a deletion answering "not finished" whenever that SCAN does not end.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { erasePerson } from "@/lib/person-erasure";
import * as access from "@/lib/podcast-access";
import { CLOSING, COUNTED_FAMILIES } from "@/lib/data-families";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, removeProduct, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as recountCron } from "@/app/api/cron/recount/route";
import { NOTE_RUN_BYTES, NOTE_RUN_COMMANDS, NOTE_STORE_READS } from "@/lib/podcast-access";
import { PODCAST_NOTE_RUN_USD } from "./plan-cost-registry";
import { BACKUP_SCAN_PAGES } from "@/lib/backup-parts";

const owner = "podcast-removed-owner@example.test";
const person = "podcast-removed-person@example.test";
const other = "podcast-removed-other@example.test";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const grantKey = (token: string) => `nl:pod:t:${sha(token)}`;

async function world(keep = false) {
  if (!keep) redis.clear();
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
  const box: { erased?: Awaited<ReturnType<typeof erasePerson>> } = {};
  redis.pipeline = async (commands) => {
    const replies = await original(commands);
    const indexWrite = commands.some((c) => c[0] === "EVAL" && c.some((a) => String(a).startsWith("nl:pod:by:")));
    if (indexWrite && !box.erased) {
      redis.pipeline = original;
      box.erased = await erasePerson((await storeForEmail(owner))!, late, { kind: "person" });
    }
    return replies;
  };
  let token: string | null;
  try { token = await access.feedToken(shop, pid, late); } finally { redis.pipeline = original; }
  assert.ok(box.erased, "the deletion ran between the feed's writes");
  assert.equal(box.erased.ok, true);
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

/**
 * A feed granted before the product note existed, as the code then left it: the index and the grant with the address,
 * no member in nl:pod:pids:<sid>. Written directly, never by this head's feedToken (Codex P, N1, T and X5).
 */
async function legacyWorld() {
  const { sid, pid } = await world();
  redis.run(["DEL", `nl:pod:pids:${sid}`]);
  const made = await addProduct(owner, "Synthetic old podcast", "", "27", null);
  assert.ok(made.ok);
  const old = made.product.id;
  const token = randomBytes(24).toString("hex");
  const address = sha(`nimbus-podcast:${person}`).slice(0, 32);
  redis.run(["SET", `nl:pod:by:${sid}:${old}:${address}`, token]);
  redis.run(["SET", grantKey(token), JSON.stringify({ s: sid, h: "podremoved", p: old, e: person })]);
  return { sid, pid, old, token };
}

delete process.env.CRON_SECRET;

// Codex N1, T and X5 (HIGH): a feed granted before the note, whose product was removed before this change.
test("a feed granted before the note, of a product removed before this change, is reached by a person's deletion", () => quietly(async () => {
  const { sid, old, token } = await legacyWorld();
  assert.ok((await removeProduct(owner, old)).ok);
  assert.equal(redis.run(["SISMEMBER", `nl:pod:pids:${sid}`, old]), 0, "nothing notes the removed product yet");
  const result = await erasePerson((await storeForEmail(owner))!, person, { kind: "person" });
  assert.equal(result.ok, true);
  assert.equal(redis.run(["GET", grantKey(token)]), null, "the old grant, with the address, is gone");
}));

// Codex P and T (HIGH): the same feed, whose product is removed only after this change, nobody asking for it again.
test("a feed granted before the note, of a product removed after this change, is reached by a person's deletion", () => quietly(async () => {
  const { old, token } = await legacyWorld();
  const shop = (await storeForEmail(owner))!;
  assert.ok(shop.catalog.items.some((item) => item.id === old), "the product was still in the catalog");
  assert.ok((await removeProduct(owner, old)).ok);
  const result = await erasePerson((await storeForEmail(owner))!, person, { kind: "person" });
  assert.equal(result.ok, true);
  assert.equal(redis.run(["GET", grantKey(token)]), null, "the old grant, with the address, is gone");
}));

test("the copy of a person's data lists a feed granted before the note, of a removed product", () => quietly(async () => {
  const { old } = await legacyWorld();
  assert.ok((await removeProduct(owner, old)).ok);
  const shop = (await storeForEmail(owner))!;
  const catalog = shop.catalog.items.map((item) => item.id);
  assert.ok((await access.feedsOf(shop, catalog, person)).includes(old));
}));

test("while the old feeds cannot be walked, a deletion is never said to be done", () => quietly(async () => {
  const { old, token } = await legacyWorld();
  assert.ok((await removeProduct(owner, old)).ok);
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "SCAN") ? [{ garbled: true }] : original(commands));
  try {
    const result = await erasePerson((await storeForEmail(owner))!, person, { kind: "person" });
    assert.equal(result.ok, false, "never done while an old grant may be left");
    assert.ok(!result.ok && result.reason === "incomplete" && result.failed.includes("lib/podcast-access.ts"));
  } finally { redis.pipeline = original; }
  assert.notEqual(redis.run(["GET", grantKey(token)]), null, "and the grant is still there to be deleted on the next try");
}));

test("the hourly one-time job notes the products of feeds granted before the note", () => quietly(async () => {
  const { sid, old } = await legacyWorld();
  assert.ok((await removeProduct(owner, old)).ok);
  const answer = await recountCron(new NextRequest("https://local.example/api/cron/recount"));
  assert.equal(answer.status, 200);
  assert.equal(redis.run(["SISMEMBER", `nl:pod:pids:${sid}`, old]), 1, "the removed product is noted");
}));

test("one run of the walk stops at its reads of stores, and the next run goes on from there", () => quietly(async () => {
  redis.clear();
  const many = NOTE_STORE_READS + 3;
  const sidOf = (i: number) => `walkstore${String(i).padStart(4, "0")}`;
  for (let i = 0; i < many; i += 1) {
    redis.run(["SET", `nl:pod:by:${sidOf(i)}:walkproduct:${sha(`nimbus-podcast:${i}@example.test`).slice(0, 32)}`, randomBytes(24).toString("hex")]);
  }
  const original = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = async (sent) => { commands += sent.length; return original(sent); };
  let first: Awaited<ReturnType<typeof access.notePodcastProducts>>;
  try { first = await access.notePodcastProducts(Date.now() + 60_000); } finally { redis.pipeline = original; }
  assert.equal(first.storeReads, NOTE_STORE_READS);
  assert.equal(first.done, false, "not done: the page is walked again");
  assert.ok(commands <= NOTE_RUN_COMMANDS, `${commands} commands, within the run's ${NOTE_RUN_COMMANDS}`);
  const second = await access.notePodcastProducts(Date.now() + 60_000);
  assert.deepEqual([second.storeReads, second.noted, second.done], [3, 3, true]);
  for (let i = 0; i < many; i += 1) assert.equal(redis.run(["SISMEMBER", `nl:pod:pids:${sidOf(i)}`, "walkproduct"]), 1);
  const after = await access.notePodcastProducts(Date.now() + 60_000);
  assert.deepEqual([after.pages, after.storeReads, after.done], [0, 0, true], "once done, a run only reads where the walk is");
  assert.ok(PODCAST_NOTE_RUN_USD > 0 && Number.isFinite(PODCAST_NOTE_RUN_USD));
  console.log(`a run of the walk: at most ${NOTE_RUN_COMMANDS} commands and ${NOTE_RUN_BYTES} bytes, $${PODCAST_NOTE_RUN_USD.toFixed(6)}`);
}));

/**
 * A SCAN that pages as a real Redis does (Claude 6 on #4471 @c2cc79fec0, MEDIUM): each call examines COUNT keys of a
 * shared database of `keys` keys, answering [cursor + COUNT, []] until the end, then the stand-in's matches with "0".
 * The in-memory stand-in answers every SCAN in one page, which hid how long the walk and the bridge take.
 */
function pagedScan(keys: number): () => void {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands.length !== 1 || commands[0][0] !== "SCAN") return original(commands);
    const [, cursor, , , , count] = commands[0].map(String);
    const next = Number(cursor) + Number(count);
    if (next < keys) return [[String(next), []]];
    return original([commands[0].map((v, i) => (i === 1 ? "0" : v))]);
  };
  return () => { redis.pipeline = original; };
}

// Claude 6 (MEDIUM): on a real database every deletion answered "not finished" until the walk ended, which took
// (keys / 1,000) hours. One run must cover the database the daily backup accepts (BACKUP_SCAN_PAGES pages of 500).
test("one run of the walk covers a database of the size the daily backup accepts, and deletions finish after it", () => quietly(async () => {
  const { pid } = await world();
  const restore = pagedScan(BACKUP_SCAN_PAGES * 500);
  try {
    const run = await access.notePodcastProducts(Date.now() + 60_000);
    assert.equal(run.done, true, `one run ends the walk (${run.pages} pages)`);
    const result = await erasePerson((await storeForEmail(owner))!, "podcast-removed-nofeed@example.test", { kind: "person" });
    assert.equal(result.ok, true);
  } finally { restore(); }
  assert.ok(pid);
}));

// Claude 6 (MEDIUM): a store made after the walk started cannot hold a feed from before the note, so its deletions
// never wait for the walk.
test("a store made after the walk started never waits for it", () => quietly(async () => {
  redis.clear();
  const restore = pagedScan(10_000);
  try {
    const run = await access.notePodcastProducts(Date.now() + 60_000, 1);
    assert.equal(run.done, false, "the walk is under way");
    await world(true);
    const result = await erasePerson((await storeForEmail(owner))!, "podcast-removed-nofeed@example.test", { kind: "person" });
    assert.equal(result.ok, true);
  } finally { restore(); }
}));
