/**
 * CX-123 rule 24: a provider's deletion notice (Zoom's app_deauthorized, Meta's deauthorize / data deletion callback)
 * and the daily Meta pass never read an unknown reply as "this user connected no store" or "this store has no
 * connection". Before, an unknown SMEMBERS answered as an empty list: nothing was forgotten, the user's index was
 * deleted for good, and Meta was given a confirmation code. An unknown connection GET in the daily pass took the store
 * off the list of stores read. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { forgetUser } from "@/lib/meet-connect";
import { forgetMetaUser, readMetaDue } from "@/lib/meta-ads";
import { POST as metaDeauthorize } from "@/app/api/integrations/meta/deauthorize/route";
import { store as redis } from "./redis-stub";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const zoomUserKey = (id: string) => `nl:meet:user:zoom:${hash(`meet-user:zoom:${id}`)}`;
const zoomConnKey = (statsId: string) => `nl:meet:conn:${statsId}:zoom`;
const metaUserKey = (user: string) => `nl:metaads:user:${hash(`metaads-user:${user}`)}`;
const metaConnKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const META_STORES = "nl:metaads:stores";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const sent: Command[] = [];
/** Answers the first pipeline whose first command matches with `reply`; every command sent is recorded. */
function inject(match: (c: Command) => boolean, reply: unknown) {
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    sent.push(...commands);
    if (!used && commands[0] && match(commands[0])) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
}
/**
 * Changed with #3322's merge (rule 23): a Meta user's deletion now marks them gone in the same pipeline as, and before,
 * the read of their stores (lib/meta-ads.ts forgetMetaUser), so the mark is answered "OK" and the store list's reply is
 * the one bent, at its own place in that pipeline.
 */
function injectMetaStores(reply: unknown[]) {
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    sent.push(...commands);
    if (!used && commands.length === 2 && commands[0][0] === "SET" && commands[1][0] === "SMEMBERS") {
      used = true;
      await real([commands[0]]);
      return ["OK", ...reply];
    }
    return real(commands);
  }) as typeof redis.pipeline;
}
function restore() {
  redis.pipeline = real;
  sent.length = 0;
}

function seedZoom(id: string, statsId: string) {
  redis.run(["SADD", zoomUserKey(id), statsId]);
  redis.run(["SET", zoomConnKey(statsId), JSON.stringify({ provider: "zoom", account: { id, email: "host@example.com", name: "Host" }, refresh: "sealed", access: "sealed", owner: { email: "owner@example.com", handle: "shop" } })]);
}
function seedMeta(user: string, statsId: string) {
  redis.run(["SADD", metaUserKey(user), statsId]);
  redis.run(["SADD", META_STORES, statsId]);
  redis.run(["SET", metaConnKey(statsId), JSON.stringify({ user, token: "sealed", accounts: [], account: "", sid: "sid-1", owner: { email: "owner@example.com", handle: "shop" } })]);
}

const UNKNOWN_LISTS: [string, unknown][] = [
  ["a missing envelope", []],
  ["a null result", [null]],
  ["a number", [7]],
  ["a list with a non-string member", [["store-a", 3]]],
];

for (const [label, reply] of UNKNOWN_LISTS) {
  test(`Zoom: a user's store list answered with ${label} is not "no store", and the index is kept`, async () => {
    redis.clear();
    seedZoom("zu-1", "zstats1");
    inject((c) => c[0] === "SMEMBERS", reply);
    try {
      await assert.rejects(() => forgetUser("zoom", "zu-1"));
      assert.equal(sent.some((c) => c[0] === "DEL"), false, "nothing deleted");
    } finally { restore(); }
    assert.equal(redis.run(["EXISTS", zoomUserKey("zu-1")]), 1);
    assert.equal(redis.run(["EXISTS", zoomConnKey("zstats1")]), 1);
  });

  test(`Meta: a user's store list answered with ${label} is not "no store"; the callback gives no confirmation`, async () => {
    redis.clear();
    seedMeta("10150000000000001", "mstats1");
    injectMetaStores(reply as unknown[]);
    try {
      await assert.rejects(() => forgetMetaUser("10150000000000001"));
      assert.equal(sent.some((c) => c[0] === "DEL" || c[0] === "SREM"), false, "nothing deleted");
    } finally { restore(); }
    assert.equal(redis.run(["EXISTS", metaUserKey("10150000000000001")]), 1);
  });
}

for (const [label, reply] of [["a missing envelope", []], ["a number", [5]], ["text that is not a connection", ["{"]]] as const) {
  test(`Zoom: a connection answered with ${label} is not "no connection"; the index is kept`, async () => {
    redis.clear();
    seedZoom("zu-2", "zstats2");
    inject((c) => c[0] === "GET" && String(c[1]).startsWith("nl:meet:conn:"), reply);
    try {
      await assert.rejects(() => forgetUser("zoom", "zu-2"));
    } finally { restore(); }
    assert.equal(redis.run(["EXISTS", zoomUserKey("zu-2")]), 1);
  });

  test(`Meta: a connection answered with ${label} is not "no connection"; the index is kept`, async () => {
    redis.clear();
    seedMeta("10150000000000002", "mstats2");
    inject((c) => c[0] === "GET" && String(c[1]).startsWith("nl:metaads:conn:"), reply);
    try {
      await assert.rejects(() => forgetMetaUser("10150000000000002"));
    } finally { restore(); }
    assert.equal(redis.run(["EXISTS", metaUserKey("10150000000000002")]), 1);
    assert.equal(redis.run(["EXISTS", metaConnKey("mstats2")]), 1);
  });

  test(`Meta daily pass: a connection answered with ${label} does not take the store off the list`, async () => {
    redis.clear();
    seedMeta("10150000000000003", "mstats3");
    inject((c) => c[0] === "GET" && String(c[1]).startsWith("nl:metaads:conn:"), [reply[0], null].slice(0, reply.length === 0 ? 0 : 2));
    try {
      await readMetaDue(Date.now() + 5_000, async () => null).catch(() => null);
      assert.equal(sent.some((c) => c[0] === "SREM"), false, "no SREM");
    } finally { restore(); }
    assert.equal(redis.run(["SISMEMBER", META_STORES, "mstats3"]), 1);
  });
}

test("Meta callback: an unknown store list answers 503 with no confirmation code, so Meta asks again", async () => {
  redis.clear();
  seedMeta("10150000000000004", "mstats4");
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "10150000000000004", issued_at: 1 })).toString("base64url");
  const signed = `${createHmac("sha256", SECRET).update(payload).digest("base64url")}.${payload}`;
  injectMetaStores([null]);
  let status = 0, body = "";
  try {
    const response = await metaDeauthorize(new NextRequest("https://marktmorgen.com/api/integrations/meta/deauthorize", { method: "POST", body: new URLSearchParams({ signed_request: signed }), headers: { "x-forwarded-for": "198.51.100.7" } }));
    status = response.status;
    body = await response.text();
  } finally { restore(); }
  assert.equal(status, 503);
  assert.equal(body.includes("confirmation_code"), false);
  assert.equal(redis.run(["EXISTS", metaUserKey("10150000000000004")]), 1);
});

test("healthy controls: a known user's stores are forgotten, and the index with them", async () => {
  redis.clear();
  seedZoom("zu-5", "zstats5");
  const zoom = await forgetUser("zoom", "zu-5");
  assert.deepEqual(zoom.map((f) => f.statsId), ["zstats5"]);
  assert.equal(redis.run(["EXISTS", zoomConnKey("zstats5")]), 0);
  assert.equal(redis.run(["EXISTS", zoomUserKey("zu-5")]), 0);
  seedMeta("10150000000000005", "mstats5");
  const meta = await forgetMetaUser("10150000000000005");
  assert.deepEqual(meta.map((f) => f.statsId), ["mstats5"]);
  assert.equal(redis.run(["EXISTS", metaConnKey("mstats5")]), 0);
  assert.equal(redis.run(["EXISTS", metaUserKey("10150000000000005")]), 0);
});

test("confirmed absence: a user with no store, or a store whose connection is gone, is still settled", async () => {
  redis.clear();
  assert.deepEqual(await forgetUser("zoom", "zu-none"), []);
  assert.deepEqual(await forgetMetaUser("10150000000000006"), []);
  // The index names a store whose connection was already removed: nothing to forget there, and the index goes.
  redis.run(["SADD", zoomUserKey("zu-7"), "zstats7"]);
  assert.deepEqual(await forgetUser("zoom", "zu-7"), []);
  assert.equal(redis.run(["EXISTS", zoomUserKey("zu-7")]), 0);
  redis.run(["SADD", metaUserKey("10150000000000007"), "mstats7"]);
  assert.deepEqual(await forgetMetaUser("10150000000000007"), []);
  assert.equal(redis.run(["EXISTS", metaUserKey("10150000000000007")]), 0);
  // The daily pass: a store on the list whose connection is confirmed gone leaves the list.
  redis.run(["SADD", META_STORES, "mstats8"]);
  await readMetaDue(Date.now() + 5_000, async () => null);
  assert.equal(redis.run(["SISMEMBER", META_STORES, "mstats8"]), 0);
});
