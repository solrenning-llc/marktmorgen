/** Evidence only: actual API-key helpers with the repository's MemoryRedis transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { makeKey, resolveKey, revokeKey } from "@/lib/api-keys";
import { store as redis } from "./redis-stub";

const sid = "a".repeat(32);
const otherSid = "b".repeat(32);
const original = redis.pipeline.bind(redis);

async function syntheticKey() {
  redis.clear();
  const made = await makeKey(sid, "Synthetic revocation evidence");
  assert.equal(made.ok, true, "the real writer must create the synthetic key");
  if (!made.ok) throw new Error("Synthetic key creation failed");
  assert.equal((await resolveKey(made.key))?.sid, sid);
  return made;
}

for (const [label, reply] of [
  ["missing envelope", []],
  ["one null slot", [null]],
  ["partial numeric envelope", [1, 1]],
  ["extra numeric envelope", [1, 1, 0, 0, 0]],
] as const) {
  test(`${label}: unknown revocation cannot be reported as completed`, async () => {
    const made = await syntheticKey();
    let injections = 0;
    redis.pipeline = async (commands) => {
      if (commands.length === 4 && commands[0]?.[0] === "DEL" && String(commands[0]?.[1]).startsWith("nl:api:k:")) {
        injections += 1;
        // Only the deletion trip is replaced; no deletion is applied. These
        // are dense JSON-compatible arrays, not getters, Proxies or holes.
        return [...reply];
      }
      return original(commands);
    };
    let reportedRevoked: boolean;
    try {
      reportedRevoked = await revokeKey(sid, made.made.id);
    } finally {
      redis.pipeline = original;
    }
    const stillWorks = (await resolveKey(made.key))?.sid === sid;
    assert.equal(injections, 1, "only the intended real deletion trip was intercepted");
    // Restore the normal transport before testing the ordinary retry.
    assert.equal(await revokeKey(sid, made.made.id), true);
    assert.equal(await resolveKey(made.key), null, "a confirmed retry closes access");
    assert.deepEqual({ reportedRevoked, stillWorks }, { reportedRevoked: false, stillWorks: true });
  });
}

test("healthy revocation closes the very next real key resolution", async () => {
  const made = await syntheticKey();
  assert.equal(await revokeKey(sid, made.made.id), true);
  assert.equal(await resolveKey(made.key), null);
  assert.equal(await revokeKey(sid, made.made.id), false);
});

test("another store cannot revoke the real synthetic key", async () => {
  const made = await syntheticKey();
  assert.equal(await revokeKey(otherSid, made.made.id), false);
  assert.equal((await resolveKey(made.key))?.sid, sid);
});
