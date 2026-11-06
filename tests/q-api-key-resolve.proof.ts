/** Evidence only: actual key creation, pause CAS and resolution with MemoryRedis. */
import assert from "node:assert/strict";
import test from "node:test";
import { makeKey, resolveKey, swapHolds } from "@/lib/api-keys";
import { store as redis } from "./redis-stub";

const sid = "a".repeat(32);
const original = redis.pipeline.bind(redis);

async function syntheticKey() {
  redis.clear();
  const made = await makeKey(sid, "Synthetic pause evidence");
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("Synthetic key creation failed");
  assert.equal((await resolveKey(made.key))?.paused, false);
  return made;
}

test("a partial resolution reply cannot turn a genuinely paused key live", async () => {
  const made = await syntheticKey();
  assert.deepEqual(await swapHolds(sid, [made.made.id], "paused", [null]), [made.made.id]);
  assert.equal((await resolveKey(made.key))?.paused, true, "the actual CAS applied the hold");
  let injections = 0;
  redis.pipeline = async (commands) => {
    const reply = await original(commands);
    if (commands.length === 4 && commands[0]?.[0] === "HGET"
      && commands[0]?.[1] === `nl:api:keys:${sid}`
      && commands[1]?.[1] === `nl:api:hold:${sid}`) {
      injections += 1;
      // The real read ran; truncate only the JSON-compatible read envelope.
      return reply.slice(0, 1);
    }
    return reply;
  };
  let refused = false;
  try {
    const resolved = await resolveKey(made.key);
    refused = resolved === null || resolved.paused;
  } catch (error) {
    assert.ok(error instanceof Error && error.name === "UnknownReplyError");
    refused = true;
  } finally {
    redis.pipeline = original;
  }
  assert.equal(injections, 1);
  assert.equal((await resolveKey(made.key))?.paused, true, "the stored hold survives the unknown read");
  assert.equal(refused, true, "unknown hold/team evidence must not authorize a paused key");
});

test("a complete healthy read preserves the real paused-key refusal", async () => {
  const made = await syntheticKey();
  assert.deepEqual(await swapHolds(sid, [made.made.id], "paused", [null]), [made.made.id]);
  const resolved = await resolveKey(made.key);
  assert.equal(resolved?.sid, sid);
  assert.equal(resolved?.paused, true);
});

test("a complete healthy read keeps an ordinary live key live", async () => {
  const made = await syntheticKey();
  const resolved = await resolveKey(made.key);
  assert.equal(resolved?.sid, sid);
  assert.equal(resolved?.paused, false);
});
