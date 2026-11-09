import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { addLink, countLinks, findLink, linkKey, readLinks, removeLink, retarget } from "@/lib/short-links";
import { GET } from "@/app/l/[code]/route";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const owner = { sid: "store-evidence", statsId: "stats-evidence" };
const kept = { ...owner, code: "abcxyz", name: "post", place: "other", target: { kind: "store" }, made: 1000 };
const index = `nl:slink:store:${owner.statsId}`;
beforeEach(() => { redis.clear(); });
afterEach(() => { redis.pipeline = pipeline; });
function inject(command: string, reply: unknown[]) {
  redis.pipeline = async commands => commands[0][0] === command ? reply : pipeline(commands);
}
function seed() { redis.run(["SET", linkKey(kept.code), JSON.stringify(kept)]); redis.run(["HSET", index, kept.code, JSON.stringify(kept)]); }

for (const reply of [[], [undefined], [null], [false], [""], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [0, null]]) test(`HLEN ${JSON.stringify(reply)} is unknown, not zero links`, async () => {
  inject("HLEN", reply); await assert.rejects(countLinks(owner.statsId));
});
for (const reply of [[], [null], [undefined], [false], [[] , null], [["bad-json"]], [[JSON.stringify(kept), "bad-json"]], [[JSON.stringify({ ...kept, made: null })]]]) test(`HVALS ${JSON.stringify(reply)} cannot become empty or partial inventory`, async () => {
  inject("HVALS", reply); await assert.rejects(readLinks(owner.statsId));
});
test("an unknown inventory cannot authorize creating a duplicate name", async () => {
  let writes = 0;
  redis.pipeline = async commands => { if (commands[0][0] === "HVALS") return [null]; writes += 1; return pipeline(commands); };
  await assert.rejects(addLink(owner, { name: "post", place: "other", target: { kind: "store" } }, () => true));
  assert.equal(writes, 0);
});

for (const reply of [[], [undefined], [false], [0], [{}], ["OK", null], [null, "OK"]]) test(`SET NX ${JSON.stringify(reply)} cannot claim an unpersisted short link`, async () => {
  let reservations = 0, indexWrites = 0;
  redis.pipeline = async commands => {
    if (commands[0][0] === "SET") { reservations += 1; return reply; }
    if (commands[0][0] === "HSET") indexWrites += 1;
    return pipeline(commands);
  };
  const result = await addLink(owner, { name: "post", place: "other", target: { kind: "store" } }, () => true);
  assert.equal(result.ok, false);
  assert.equal(reservations, 1, "do not retry an uncertain reservation");
  assert.equal(indexWrites, 0);
});

for (const action of ["add", "retarget", "remove"] as const) for (const receipt of [[], [null], ["OK"], ["OK", null], ["OK", 1, "extra"]]) {
  test(`${action}: incomplete mutation ${JSON.stringify(receipt)} is never reported as saved`, async () => {
    seed();
    redis.pipeline = async commands => {
      if (action === "add" && commands[0][0] === "HSET") return receipt;
      if (action === "retarget" && commands[0][0] === "SET") return receipt;
      if (action === "remove" && commands[0][0] === "DEL") return receipt;
      return pipeline(commands);
    };
    const work = action === "add" ? () => addLink(owner, { name: "new-post", place: "other", target: { kind: "store" } }, () => true)
      : action === "retarget" ? () => retarget(owner.statsId, kept.code, { kind: "product", id: "guide" }, () => true)
      : () => removeLink(owner.statsId, kept.code);
    await assert.rejects(work());
  });
}

for (const reply of [[], [undefined], [false], ["bad-json"], [JSON.stringify({ ...kept, code: "zzzzzz" })], [JSON.stringify({ ...kept, made: null })], [null, null]]) test(`GET ${JSON.stringify(reply)} cannot confirm an ended link`, async () => {
  inject("GET", reply); await assert.rejects(findLink(kept.code));
  const response = await GET(new Request(`https://example.test/l/${kept.code}`) as never, { params: Promise.resolve({ code: kept.code }) });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("confirmed absence, empty inventory and zero count remain valid", async () => {
  assert.equal(await findLink(kept.code), null);
  assert.deepEqual(await readLinks(owner.statsId), []);
  assert.equal(await countLinks(owner.statsId), 0);
  // Main's exact count (countOf, CX-123 rule 24) takes only a number: a text "0" is unknown, never zero links.
  inject("HLEN", ["0"]); await assert.rejects(countLinks(owner.statsId));
  redis.pipeline = pipeline;
  const response = await GET(new Request(`https://example.test/l/${kept.code}`) as never, { params: Promise.resolve({ code: kept.code }) });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location")!, /\/l\/ended$/);
});
