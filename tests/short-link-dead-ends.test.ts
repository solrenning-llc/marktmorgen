/**
 * #2527, Codex J's MEDIUM and Claude 5's MEDIUM and two LOWs (review 6704643895).
 *
 * A short link never ends in a dead end:
 *   - a store read that comes back partial is "try again" (503, no-store), never an ended link kept by the CDN;
 *   - a record that is there but that this code cannot read (a rule made stricter since it was written) is a
 *     confirmed fact, not an unknown reply: the public link says it has ended, the store's list leaves it out,
 *     ending it removes it, and ending or adding another link still answers the list;
 *   - a link ended while its target was being changed stays ended;
 *   - a link that was saved is reported saved, even when the list cannot be read again just after.
 * Envelopes of the wrong shape still fail closed (tests/short-link-evidence.test.ts). Synthetic Redis only.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "@/app/l/[code]/route";
import { addLink, findLink, linkKey, readLinks, removeLink, retarget } from "@/lib/short-links";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
let sid = "", statsId = "", code = "";
const index = () => `nl:slink:store:${statsId}`;
const open = (c = code) => GET(new Request(`https://example.test/l/${c}`) as never, { params: Promise.resolve({ code: c }) });
const make = async (name: string) => {
  const made = await addLink({ sid, statsId }, { name, place: "other", target: { kind: "store" } }, () => true, 1000);
  if (!made.ok) throw new Error("fixture link unavailable");
  return made.link.code;
};
/** The record a stricter rule can no longer read: `made` kept as text. */
const broken = (c: string, owner = statsId) => JSON.stringify({ code: c, name: "old", place: "other", target: { kind: "store" }, made: "1000", sid, statsId: owner });

beforeEach(async () => {
  redis.pipeline = pipeline;
  redis.clear();
  await claimHandle("owner@example.com", "harbor", "Harbor", "");
  await ensureStoreId("owner@example.com");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  sid = store.sid; statsId = store.statsId!;
  code = await make("post");
});
afterEach(() => { redis.pipeline = pipeline; });

for (const stage of ["pointer", "owner-record"] as const) test(`J: a partial ${stage} read is try-again, never an ended link in the CDN`, async () => {
  redis.pipeline = async (commands) => {
    const key = String(commands[0][1]);
    const target = stage === "pointer" ? key === `nl:store:id:${sid}` : key.startsWith("nl:store:") && !key.startsWith("nl:store:id:");
    return commands[0][0] === "GET" && target ? [] : pipeline(commands);
  };
  const response = await open();
  assert.deepEqual([response.status, response.headers.get("location"), response.headers.get("cache-control")], [503, null, "no-store"]);
});

test("J: a store confirmed gone still ends the link", async () => {
  redis.pipeline = (commands) => commands[0][0] === "GET" && commands[0][1] === `nl:store:id:${sid}` ? Promise.resolve([null]) : pipeline(commands);
  const response = await open();
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location")!, /\/l\/ended$/);
});

test("C5 P4: a record this code cannot read opens the ended page, kept by the CDN", async () => {
  redis.run(["SET", linkKey(code), broken(code)]);
  assert.equal(await findLink(code), null);
  const response = await open();
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location")!, /\/l\/ended$/);
  assert.match(response.headers.get("cache-control")!, /s-maxage=/);
});

test("C5 P4: a record that names another code is ended too, never opened", async () => {
  redis.run(["SET", linkKey(code), JSON.stringify({ code: "zzzzzz", name: "post", place: "other", target: { kind: "store" }, made: 1000, sid, statsId })]);
  assert.equal(await findLink(code), null);
  assert.equal((await open()).status, 302);
});

test("C5 P2: ending a link whose record cannot be read removes it", async () => {
  redis.run(["SET", linkKey(code), broken(code)]); redis.run(["HSET", index(), code, broken(code)]);
  assert.deepEqual(await removeLink(statsId, code), []);
  assert.deepEqual([redis.run(["GET", linkKey(code)]), redis.run(["HGET", index(), code])], [null, null]);
});

test("C5 P2: an unreadable entry in this store's list never ends another store's link", async () => {
  const theirs = JSON.stringify({ code, name: "theirs", place: "other", target: { kind: "store" }, made: 1000, sid: "other-store", statsId: "other-stats" });
  redis.run(["SET", linkKey(code), theirs]); redis.run(["HSET", index(), code, broken(code)]);
  await removeLink(statsId, code);
  assert.deepEqual([redis.run(["GET", linkKey(code)]), redis.run(["HGET", index(), code])], [theirs, null]);
});

test("C5 P3: with an unreadable sibling, ending another link answers the list", async () => {
  const other = await make("second");
  redis.run(["HSET", index(), "qqqqqq", broken("qqqqqq")]);
  const links = await removeLink(statsId, other);
  assert.deepEqual(links.map((l) => l.code), [code]);
  assert.equal(redis.run(["GET", linkKey(other)]), null);
});

test("C5: the store's list leaves out what it cannot read and keeps the rest", async () => {
  redis.run(["HSET", index(), "qqqqqq", broken("qqqqqq")]);
  redis.run(["HSET", index(), "rrrrrr", broken("rrrrrr", "other-stats").replace('"1000"', "1000")]);
  assert.deepEqual((await readLinks(statsId)).map((l) => l.code), [code]);
});

test("C5: changing an unreadable link's target is refused, nothing written", async () => {
  redis.run(["SET", linkKey(code), broken(code)]); redis.run(["HSET", index(), code, broken(code)]);
  assert.equal(await retarget(statsId, code, { kind: "store" }, () => true), null);
  assert.equal(redis.run(["GET", linkKey(code)]), broken(code));
});

test("C5 P1: a link ended while its target changes stays ended", async () => {
  let ended = false;
  redis.pipeline = async (commands) => {
    if (!ended && commands.some((c) => c[0] === "SET" && c[1] === linkKey(code))) {
      ended = true;
      await pipeline([["DEL", linkKey(code)], ["HDEL", index(), code]]);
    }
    return pipeline(commands);
  };
  await assert.rejects(retarget(statsId, code, { kind: "product", id: "guide" }, () => true));
  redis.pipeline = pipeline;
  assert.equal(await findLink(code), null);
  assert.equal(redis.run(["HGET", index(), code]), null);
});

test("C5 P5: a link saved is reported saved when the list cannot be read just after", async () => {
  let saved = false;
  redis.pipeline = async (commands) => {
    if (commands[0][0] === "HSET") saved = true;
    if (saved && commands[0][0] === "HVALS") return [];
    return pipeline(commands);
  };
  const made = await addLink({ sid, statsId }, { name: "third", place: "other", target: { kind: "store" } }, () => true, 2000);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.deepEqual(made.links.map((l) => l.code), [made.link.code, code]);
});
