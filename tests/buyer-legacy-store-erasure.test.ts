/**
 * Buyer area hunt (Claude 7, 14 November 2026; synthetic only): a store whose record has no statsId keys its
 * buyers' passes and course ledger by storeKey's fallback (a hash of the store's address). erasureScope gives the
 * store a statsId first (ensureStatsId), so forgetLearnerPerson looked only under the new storeKey, and the person's
 * pass records (their address in plain text) and course ledger made before stayed in Redis. Both keys are now read
 * and deleted.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, OWNER } from "./erasure-world";
import { forgetLearnerPerson, mintPass, recordEnrollment } from "@/lib/learn";
import { erasureScope } from "@/lib/person-erasure";
import { storeForEmail } from "@/lib/store";
import { createHash } from "node:crypto";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

async function main() {
  const world = await makeWorld();
  // A store kept from before statsId: the same record without the field.
  const key = `nl:store:owner:${sha(`nimbus-store:${OWNER}`).slice(0, 40)}`;
  const [raw] = await redis.pipeline([["GET", key]]);
  const record = JSON.parse(String(raw));
  delete record.statsId;
  await redis.pipeline([["SET", key, JSON.stringify(record)]]);
  const legacy = (await storeForEmail(OWNER))!;
  is("the store reads with no statsId", legacy.statsId, null);

  part("a buyer of the legacy store holds a pass and an enrollment, then is erased");
  const token = await mintPass(legacy, "buyer@example.com", "all");
  await recordEnrollment(legacy, "buyer@example.com", world.courseProduct, Math.floor(Date.now() / 1000) - 60);
  const scope = (await erasureScope(legacy, "buyer@example.com"))!;
  is("the erasure gave the store a statsId first", typeof scope.store.statsId, "string");
  await forgetLearnerPerson(scope.store, scope.email, scope.courses.map((c) => ({ courseId: c.courseId, moduleIds: c.moduleIds })));
  const [pass] = await redis.pipeline([["GET", `nl:learn:pass:${sha(token)}`]]);
  is("the pass record (with the address) is gone after the erasure (expected null)", pass, null);
  const oldStoreKey = sha(`nimbus-learn-store:${legacy.email}`).slice(0, 32);
  const ledger = `nl:learn:enr:${oldStoreKey}:${sha("nimbus-learner:buyer@example.com").slice(0, 32)}`;
  const [left] = await redis.pipeline([["EXISTS", ledger]]);
  is("the person's course ledger under the old key is gone (expected 0)", left, 0);
  done();
}
void main();
