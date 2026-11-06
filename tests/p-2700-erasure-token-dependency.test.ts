import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { leadsKey, forgetContactPerson } from "@/lib/contacts";
import { forgetClicksPerson, keyIndex, linkKeyOf } from "@/lib/mail-clicks";
import { store as redis } from "./redis-stub";

const listId = "p_2700_erasure";
const email = "reader@example.com";
const token = "a".repeat(40);
const campaign = "s-0123456789abcdef-fedcba9876543210";
const marker = keyIndex(linkKeyOf(token));
const used = `nl:mail:clk:${listId}:${createHash("sha256")
  .update(`nimbus-clk:${email}`)
  .digest("hex")
  .slice(0, 32)}`;
const realPipeline = redis.pipeline.bind(redis);

beforeEach(() => {
  redis.pipeline = realPipeline;
  redis.clear();
});

test("a retry can still delete the click marker after an unknown first read", async () => {
  await realPipeline([
    ["HSET", leadsKey(listId), email, JSON.stringify({ t: token })],
    ["SET", marker, token],
    ["SADD", used, campaign],
  ]);

  redis.pipeline = async (commands) =>
    commands.some((command) => command[0] === "HGET") ? [undefined] : realPipeline(commands);
  await assert.rejects(forgetClicksPerson(listId, email));
  redis.pipeline = realPipeline;

  // erasePerson continues after one module fails, so the contact eraser runs
  // and removes the only stored token from which the click marker is derived.
  await forgetContactPerson(listId, email);
  await forgetClicksPerson(listId, email);

  assert.equal((await realPipeline([["GET", marker]]))[0], null);
});
