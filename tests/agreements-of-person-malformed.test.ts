/**
 * Claude 4 3rC's LOW on #5154 (#5285 board): agreementsOfPerson, which the buyer's "waiting for you" read uses
 * (lib/buyer-waiting.ts), dropped a member of the person's index that is not an agreement id in silence and answered
 * with a shorter list, although its own comment said it reads the set exactly, as forgetAgreementsPerson does. A
 * shorter list is not "these are all of them" (rule 24): any malformed member now makes the whole answer null, which
 * the page already says as "something could not be read". An exact index of valid ids, or an empty one, reads as
 * before. Synthetic Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { agreementsOfPerson } from "@/lib/agreement-store";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";

const SID = "s".repeat(32);
const EMAIL = "person@example.test";
const person = `nl:agree:p:${SID}:${personKey(SID, EMAIL)}`;
const GOOD = "a".repeat(32);

function seed(members: string[]) {
  redis.clear();
  for (const id of members) redis.run(["SADD", person, id]);
}

for (const [label, members] of [
  ["a member that is not an id", ["bad"]],
  ["a valid id beside one that is not", [GOOD, "bad"]],
  ["an id in capitals", ["A".repeat(32)]],
] as [string, string[]][]) {
  test(`${label}: the person's agreements are unknown (null), never a shorter list`, async () => {
    seed(members);
    assert.equal(await agreementsOfPerson({ sid: SID }, EMAIL), null);
  });
}

test("control: an exact index of valid ids still reads (records gone: an empty list, not unknown)", async () => {
  seed([GOOD, "b".repeat(32)]);
  assert.deepEqual(await agreementsOfPerson({ sid: SID }, EMAIL), []);
});

test("control: an exact empty index is still no agreement", async () => {
  redis.clear();
  assert.deepEqual(await agreementsOfPerson({ sid: SID }, EMAIL), []);
});
