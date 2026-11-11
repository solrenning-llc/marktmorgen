/**
 * A provider's deletion notice (Zoom's app_deauthorized, Meta's deauthorize callback) is confirmed only once every
 * store the user connected is forgotten (Codex H2 and Claude 5 on #2869, MEDIUM): with more stores than one pass
 * walks, the pass is not answered as done and the next notice goes on with the rest, never deleting the index that
 * leads to a connection still kept. And a pass that stops on an unknown reply still hands back the stores it already
 * forgot, so their owners are told (Claude 5, LIGHT): on the next notice those stores read as gone and would never be.
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { forgetUser } from "@/lib/meet-connect";
import { forgetMetaUser } from "@/lib/meta-ads";
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

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

function seedZoom(id: string, statsId: string) {
  redis.run(["SADD", zoomUserKey(id), statsId]);
  redis.run(["SET", zoomConnKey(statsId), JSON.stringify({ provider: "zoom", account: { id, email: "host@example.com", name: "Host" }, refresh: "sealed", access: "sealed", owner: { email: `owner@${statsId}.example`, handle: statsId } })]);
}
function seedMeta(user: string, statsId: string) {
  redis.run(["SADD", metaUserKey(user), statsId]);
  redis.run(["SADD", "nl:metaads:stores", statsId]);
  redis.run(["SET", metaConnKey(statsId), JSON.stringify({ user, token: "sealed", accounts: [], account: "", sid: "sid-1", owner: { email: `owner@${statsId}.example`, handle: statsId } })]);
}
const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
const forgotOf = (error: unknown): string[] =>
  ((error as { forgot?: { statsId: string }[] }).forgot ?? []).map((one) => one.statsId);
async function settle<T>(work: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  }
}

test("Zoom: 51 stores are not confirmed in one pass; the next notice forgets the rest, every owner told once", async () => {
  redis.clear();
  const stores = ids(51, "zs");
  for (const s of stores) seedZoom("zu-51", s);
  const first = await settle(() => forgetUser("zoom", "zu-51"));
  assert.ok(first.error, "the first pass is not answered as done");
  assert.equal(redis.run(["EXISTS", zoomUserKey("zu-51")]), 1, "the index is kept while a connection is");
  const second = await settle(() => forgetUser("zoom", "zu-51"));
  assert.equal(second.error, undefined, "the next pass finishes");
  const told = [...forgotOf(first.error), ...(second.value ?? []).map((one) => one.statsId)].sort();
  assert.deepEqual(told, stores, "every owner told exactly once");
  assert.equal(stores.filter((s) => redis.run(["EXISTS", zoomConnKey(s)]) === 1).length, 0, "no connection kept");
  // Changed with #3333's merge (rule 23): each store leaves the index on its own (SREM), so the index lists nothing
  // after; Redis drops a set left empty, which the in-memory double keeps, so it is read by how many it lists.
  assert.equal(redis.run(["SCARD", zoomUserKey("zu-51")]), 0, "the index lists nothing last");
});

test("Meta: 51 stores answer 503 with no confirmation code until every one is forgotten", async () => {
  redis.clear();
  const user = "10150000000000051";
  const stores = ids(51, "ms");
  for (const s of stores) seedMeta(user, s);
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: user, issued_at: 1 })).toString("base64url");
  const signed = `${createHmac("sha256", SECRET).update(payload).digest("base64url")}.${payload}`;
  const call = () => metaDeauthorize(new NextRequest("https://marktmorgen.com/api/integrations/meta/deauthorize", { method: "POST", body: new URLSearchParams({ signed_request: signed }), headers: { "x-forwarded-for": "198.51.100.51" } }));
  const first = await call();
  const firstBody = await first.text();
  assert.equal(first.status, 503, "not confirmed while a store is left");
  assert.equal(firstBody.includes("confirmation_code"), false);
  const second = await call();
  assert.equal(second.status, 200);
  assert.equal((await second.text()).includes("confirmation_code"), true);
  assert.equal(stores.filter((s) => redis.run(["EXISTS", metaConnKey(s)]) === 1).length, 0, "no connection kept");
  assert.equal(redis.run(["EXISTS", metaUserKey(user)]), 0);
});

test("Meta: 51 stores in the library: the first pass hands back the 50 it forgot, the next the last one", async () => {
  redis.clear();
  const user = "10150000000000052";
  const stores = ids(51, "mt");
  for (const s of stores) seedMeta(user, s);
  const first = await settle(() => forgetMetaUser(user));
  assert.ok(first.error, "the first pass is not answered as done");
  const second = await settle(() => forgetMetaUser(user));
  assert.equal(second.error, undefined);
  assert.deepEqual([...forgotOf(first.error), ...(second.value ?? []).map((one) => one.statsId)].sort(), stores);
});

function failSecondConnection(prefix: string, target: string) {
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!used && commands[0]?.[0] === "GET" && commands[0][1] === target) {
      used = true;
      return [];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  void prefix;
}

test("Zoom: a pass stopped by an unknown reply hands back the store it already forgot, so its owner is told", async () => {
  redis.clear();
  seedZoom("zu-ab", "a-store");
  seedZoom("zu-ab", "b-store");
  failSecondConnection("nl:meet:conn:", zoomConnKey("b-store"));
  const first = await settle(() => forgetUser("zoom", "zu-ab"));
  redis.pipeline = real;
  assert.ok(first.error);
  assert.deepEqual(forgotOf(first.error), ["a-store"], "A, already forgotten, is handed back");
  const second = await settle(() => forgetUser("zoom", "zu-ab"));
  assert.deepEqual((second.value ?? []).map((one) => one.statsId), ["b-store"]);
});

test("Meta: a pass stopped by an unknown reply hands back the store it already forgot, so its owner is told", async () => {
  redis.clear();
  const user = "10150000000000053";
  seedMeta(user, "a-store");
  seedMeta(user, "b-store");
  failSecondConnection("nl:metaads:conn:", metaConnKey("b-store"));
  const first = await settle(() => forgetMetaUser(user));
  redis.pipeline = real;
  assert.ok(first.error);
  assert.deepEqual(forgotOf(first.error), ["a-store"]);
  const second = await settle(() => forgetMetaUser(user));
  assert.deepEqual((second.value ?? []).map((one) => one.statsId), ["b-store"]);
});
