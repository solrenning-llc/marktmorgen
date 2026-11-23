/**
 * A person's agreement index with a member that is not an agreement id keeps the erasure unfinished (issue #4804,
 * Codex X5-20261113-1034). The set nl:agree:p:<store>:<person> is the only way to find the person's agreements, but
 * forgetAgreementsPerson dropped a member that did not match ID_PATTERN, deleted the set and reported the step done: a
 * record still stored under that member could never be found again. Now any malformed member makes the scope unknown:
 * UnknownReplyError, the set kept, and nothing deleted, so a retry still finds everything. Synthetic Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { agreementKeys, forgetAgreementsPerson } from "@/lib/agreement-store";
import { personKey } from "@/lib/person-key";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const SID = "s".repeat(32);
const EMAIL = "person@example.test";
const person = `nl:agree:p:${SID}:${personKey(SID, EMAIL)}`;
const GOOD = "a".repeat(32);

function seed(members: string[]) {
  redis.clear();
  for (const id of members) {
    redis.run(["SADD", person, id]);
    redis.run(["SET", `nl:agree:r:${id}`, JSON.stringify({ email: EMAIL, name: "Person" })]);
    redis.run(["SET", `nl:agree:v:${id}:1`, JSON.stringify({ text: "Private agreement" })]);
  }
}

for (const [label, members] of [
  ["a member that is not an id", ["bad"]],
  ["a valid id beside one that is not", [GOOD, "bad"]],
  ["an id in capitals", ["A".repeat(32)]],
] as [string, string[]][]) {
  test(`${label}: the erasure is not done, and nothing is deleted`, async () => {
    seed(members);
    await assert.rejects(forgetAgreementsPerson(SID, EMAIL), UnknownReplyError);
    assert.deepEqual((redis.run(["SMEMBERS", person]) as string[]).sort(), [...members].sort(), "the person's index is kept for a retry");
    for (const id of members) assert.equal(typeof redis.run(["GET", `nl:agree:r:${id}`]), "string", `the record under ${id} is still there to find`);
  });
}

test("an exact index of valid ids is still erased whole", async () => {
  seed([GOOD, "b".repeat(32)]);
  assert.equal(await forgetAgreementsPerson(SID, EMAIL), 2);
  assert.equal(redis.run(["EXISTS", person]), 0);
  for (const id of [GOOD, "b".repeat(32)]) for (const key of agreementKeys(id)) assert.equal(redis.run(["EXISTS", key]), 0, key);
});

test("an exact empty index is still nothing to erase", async () => {
  redis.clear();
  assert.equal(await forgetAgreementsPerson(SID, EMAIL), 0);
});
