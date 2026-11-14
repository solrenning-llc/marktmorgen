/**
 * Meta's deauthorize / data deletion callback refuses a signed_request it already acted on, and one issued too long
 * ago (the Zoom callback's own once-only mark, app/api/integrations/zoom/deauthorize). Until 14 November 2026 a
 * signed_request, once valid, was valid for ever: sent again months later, after the person connected Meta Ads again,
 * it forgot their new connections and told the owner once more. A notice that failed is still heard again, so Meta's
 * retry after a 503 goes through. Synthetic Redis and secrets only.
 */
import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as metaDeauthorize } from "@/app/api/integrations/meta/deauthorize/route";
import { store as redis } from "./redis-stub";

const SECRET = "meta-app-secret-for-replay-tests-012345";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const metaUserKey = (user: string) => `nl:metaads:user:${hash(`metaads-user:${user}`)}`;
const metaConnKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const META_STORES = "nl:metaads:stores";

function seedMeta(user: string, statsId: string) {
  redis.run(["SADD", metaUserKey(user), statsId]);
  redis.run(["SADD", META_STORES, statsId]);
  redis.run(["SET", metaConnKey(statsId), JSON.stringify({ user, token: "sealed", accounts: [], account: "", sid: "sid-1", owner: { email: "owner@example.com", handle: "shop" } })]);
}

function signedFor(user: string, issuedAt: number): string {
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: user, issued_at: issuedAt })).toString("base64url");
  return `${createHmac("sha256", SECRET).update(payload).digest("base64url")}.${payload}`;
}

const call = (signed: string) =>
  metaDeauthorize(new NextRequest("https://marktmorgen.com/api/integrations/meta/deauthorize", { method: "POST", body: new URLSearchParams({ signed_request: signed }), headers: { "x-forwarded-for": "198.51.100.90" } }));

test("the same signed_request sent again after it was acted on never forgets a newer connection", async () => {
  redis.clear();
  const user = "10150000000000090";
  const signed = signedFor(user, Math.floor(Date.now() / 1000));
  seedMeta(user, "mreplay1");
  const first = await call(signed);
  assert.equal(first.status, 200);
  assert.equal(redis.run(["EXISTS", metaConnKey("mreplay1")]), 0, "the first notice forgets the connection");
  // The person connects Meta Ads again; the old notice is sent again.
  seedMeta(user, "mreplay2");
  const again = await call(signed);
  assert.equal(again.status < 500, true, "answered, not an error");
  assert.equal(redis.run(["EXISTS", metaConnKey("mreplay2")]), 1, "the newer connection is kept");
});

test("a signed_request issued more than a day ago is refused, and forgets nothing", async () => {
  redis.clear();
  const user = "10150000000000091";
  seedMeta(user, "mold1");
  const old = await call(signedFor(user, Math.floor(Date.now() / 1000) - 2 * 86_400));
  assert.equal(old.status, 400);
  assert.equal(redis.run(["EXISTS", metaConnKey("mold1")]), 1);
});

test("a signed_request with no issued_at is refused", async () => {
  redis.clear();
  const user = "10150000000000092";
  seedMeta(user, "mnone1");
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: user })).toString("base64url");
  const response = await call(`${createHmac("sha256", SECRET).update(payload).digest("base64url")}.${payload}`);
  assert.equal(response.status, 400);
  assert.equal(redis.run(["EXISTS", metaConnKey("mnone1")]), 1);
});

test("a fresh signed_request is still acted on", async () => {
  redis.clear();
  const user = "10150000000000093";
  seedMeta(user, "mfresh1");
  const response = await call(signedFor(user, Math.floor(Date.now() / 1000)));
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes("confirmation_code"), true);
  assert.equal(redis.run(["EXISTS", metaConnKey("mfresh1")]), 0);
});
