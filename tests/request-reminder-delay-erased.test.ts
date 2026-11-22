/**
 * Postponing a payment request's reminder never puts an erased request back on the due list (issue #4767, Codex L).
 * The five-minute job holds a due reminder's ids; if the person's erasure takes the request and its due member off
 * while the job's read of it fails, the job postponed it with a plain ZADD, which put the member back with a later
 * score: an erased request was kept on the list until a later run found it gone. Now the postponement is ZADD XX: it
 * moves a member that is still there and never adds one. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { delayReminder } from "@/lib/payment-request-store";
import { store as redis } from "./redis-stub";

const DUE = "nl:payreq:due";
const SID = "s".repeat(32);
const ID = "r".repeat(32);
const member = `${SID}|${ID}`;

test("a reminder erased before it is postponed stays off the due list", async () => {
  redis.clear();
  await delayReminder(SID, ID, 2_000_000);
  assert.equal(redis.run(["ZSCORE", DUE, member]), null, "the erased member is not added back");
  assert.equal(redis.run(["ZCARD", DUE]), 0);
});

test("a reminder still due is moved later, as before", async () => {
  redis.clear();
  redis.run(["ZADD", DUE, "1000", member]);
  redis.run(["ZADD", DUE, "1500", `${SID}|${"o".repeat(32)}`]);
  await delayReminder(SID, ID, 2_000_000);
  assert.equal(redis.run(["ZSCORE", DUE, member]), "2000000", "moved to the later time");
  assert.equal(redis.run(["ZSCORE", DUE, `${SID}|${"o".repeat(32)}`]), "1500", "another request's reminder is untouched");
});
