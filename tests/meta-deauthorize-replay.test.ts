/**
 * Meta's deauthorize notice (signed_request) was believed whatever its age: one seen once (a log line, a
 * proxy, a support paste) and sent again later disconnected every store the person had connected since, and
 * the owner was told "disconnected by Meta" again (#4585). Now a notice needs an integer issued_at not far
 * in the future, and reaches only connections made before it was issued. An old notice is still believed, so
 * Meta asking again after a 503 still deletes what it was about; a store connected later is kept, and stays
 * in the user's index so a later notice still finds it. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as metaDeauthorize } from "@/app/api/integrations/meta/deauthorize/route";
import { signedNotice, signedUser } from "@/lib/meta-ads";
import { store as redis } from "./redis-stub";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;

const USER = "10150000000004585";
const DAY = 86_400_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const userKey = (user: string) => `nl:metaads:user:${hash(`metaads-user:${user}`)}`;
const connKey = (statsId: string) => `nl:metaads:conn:${statsId}`;

function seed(statsId: string, connectedAt: number) {
  redis.run(["SADD", userKey(USER), statsId]);
  redis.run(["SADD", "nl:metaads:stores", statsId]);
  redis.run(["SET", connKey(statsId), JSON.stringify({ user: USER, token: "sealed", accounts: [], account: "", sid: "sid-1", connectedAt, owner: { email: `owner@${statsId}.example`, handle: statsId } })]);
}
function signed(fields: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: USER, ...fields })).toString("base64url");
  return `${createHmac("sha256", SECRET).update(payload).digest("base64url")}.${payload}`;
}
const at = (ms: number) => Math.floor(ms / 1000);
const call = (signedRequest: string) =>
  metaDeauthorize(new NextRequest("https://marktmorgen.com/api/integrations/meta/deauthorize", { method: "POST", body: new URLSearchParams({ signed_request: signedRequest }), headers: { "x-forwarded-for": "198.51.100.85" } }));
const connected = (statsId: string) => redis.run(["EXISTS", connKey(statsId)]) === 1;
const indexed = (statsId: string) => redis.run(["SISMEMBER", userKey(USER), statsId]) === 1;

test("a notice two days old does not disconnect a store connected since", async () => {
  redis.clear();
  const now = Date.now();
  seed("store-again", now - DAY);
  const res = await call(signed({ issued_at: at(now - 2 * DAY) }));
  assert.equal(res.status, 200, "an old notice is still answered, so a retry by Meta is not lost");
  assert.equal(connected("store-again"), true, "the store connected after the notice keeps its connection");
  assert.equal(indexed("store-again"), true, "and stays in the index, so a later notice still finds it");
});

test("an old notice still deletes what it was about, and only that", async () => {
  redis.clear();
  const now = Date.now();
  seed("store-before", now - 3 * DAY);
  seed("store-after", now - DAY);
  const res = await call(signed({ issued_at: at(now - 2 * DAY) }));
  assert.equal(res.status, 200);
  assert.deepEqual([connected("store-before"), connected("store-after")], [false, true]);
  assert.deepEqual([indexed("store-before"), indexed("store-after")], [false, true]);
});

test("a fresh notice disconnects; the same one sent again finds nothing more", async () => {
  redis.clear();
  const now = Date.now();
  seed("store-fresh", now - 1000);
  const fresh = signed({ issued_at: at(now) });
  const first = await call(fresh);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /meta-[a-z0-9]+-1"/, "one store forgotten");
  assert.equal(connected("store-fresh"), false);
  assert.equal(redis.run(["EXISTS", userKey(USER)]), 0, "the index goes once nothing is kept");
  const again = await call(fresh);
  assert.match(await again.text(), /meta-[a-z0-9]+-0"/, "sent twice, it disconnects only once");
});

test("a notice with no issued_at, a non-integer one, or one far ahead is refused", async () => {
  redis.clear();
  const now = Date.now();
  seed("store-kept", now - DAY);
  for (const fields of [{}, { issued_at: "1700000000" }, { issued_at: 1.5 }, { issued_at: 0 }, { issued_at: at(now + DAY) }]) {
    const res = await call(signed(fields));
    assert.equal(res.status, 400, JSON.stringify(fields));
  }
  assert.equal(connected("store-kept"), true, "nothing was disconnected");
  assert.equal(signedUser(signed({ issued_at: at(now) })), USER, "signedUser still names the user of a good notice");
  assert.deepEqual(signedNotice(signed({ issued_at: at(now) })), { user: USER, issuedAt: at(now) * 1000 });
});
