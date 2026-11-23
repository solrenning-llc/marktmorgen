/**
 * Defect #4175: a key's record is one identity tuple, the lookup's id, the
 * Redis field and the id written inside the record. A record kept under one
 * field but naming another id (an inconsistent restore, a partial repair) is
 * never a live credential (resolveKey) and is never shown or acted on as a key
 * under the id it names (keyRecords, listKeys), since revoking or pausing that
 * id would not touch the field the record is kept under. A matching record
 * still resolves and is listed. Real helpers, synthetic in-memory Redis.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { keyRecords, listKeys, makeKey, resolveKey } from "@/lib/api-keys";
import { store as redis } from "./redis-stub";

const sid = "c".repeat(32);
const named = "bbbbbbbbbbbb";

async function made(name: string) {
  const key = await makeKey(sid, name);
  assert.equal(key.ok, true);
  if (!key.ok) throw new Error("Synthetic key creation failed");
  return key;
}

test("a record whose embedded id differs from its field is neither live nor listed under that id", async () => {
  redis.clear();
  const odd = await made("Restored key");
  const fine = await made("Matching key");
  assert.notEqual(odd.made.id, named);
  assert.notEqual(fine.made.id, named);
  const [raw] = await redis.pipeline([["HGET", `nl:api:keys:${sid}`, odd.made.id]]);
  assert.equal(typeof raw, "string");
  const record = JSON.parse(raw as string) as { id: string };
  record.id = named;
  await redis.pipeline([["HSET", `nl:api:keys:${sid}`, odd.made.id, JSON.stringify(record)]]);

  let resolved: Awaited<ReturnType<typeof resolveKey>> | "threw" = null;
  try {
    resolved = await resolveKey(odd.key);
  } catch (error) {
    assert.ok(error instanceof Error && error.name === "UnknownReplyError");
    resolved = "threw";
  }
  assert.ok(resolved === "threw" || resolved === null || resolved.paused, "the mismatched record never opens the API live");

  const listed = (await listKeys(sid)).map((key) => key.id);
  assert.equal(listed.includes(named), false, "the id the record names is not shown as a key");
  assert.deepEqual(listed, [fine.made.id], "the matching key is still listed");
  const records = (await keyRecords(sid)).map((key) => key.id);
  assert.equal(records.includes(named), false, "nor handed to the pause and team rules as a key");

  const live = await resolveKey(fine.key);
  assert.equal(live?.id, fine.made.id);
  assert.equal(live?.paused, false, "a matching record still resolves");
});
