/**
 * Issue #4810 (Codex g, reproduced by Claude 2): forgetCrmPerson left out a deal whose stored value does not read, as if
 * it were somebody else's, and finished with the address still kept. Synthetic, the Redis stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetCrmPerson } from "@/lib/crm";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";

test("an unreadable CRM deal naming the person is never skipped as somebody else's", async () => {
  redis.clear();
  const statsId = "crm_erasure_stats";
  const email = "person@example.com";
  const key = `nl:crm:deals:${statsId}`;
  await redis.pipeline([["HSET", key, "deal_1", `{"email":"${email}"`]]);
  let result: unknown = "resolved";
  try { result = await forgetCrmPerson(statsId, personKey(statsId, email), email); } catch { result = "rejected"; }
  const [kept] = await redis.pipeline([["HGET", key, "deal_1"]]);
  console.log("RESULT forgetCrmPerson:", result, "| row kept:", JSON.stringify(kept));
  assert.equal(result, "rejected");
  assert.equal(kept, `{"email":"${email}"`);
});
