/**
 * Issue #4804 (Codex X5, reproduced by Claude 2) and the 51LL review of its first fix. A member of the person's
 * agreement index that is not an agreement id names no record: the index is only ever written with a record's own id
 * (lib/agreement-store.ts, SADD agreement.id, which ID_PATTERN holds). So the erasure deletes the records of the ids,
 * takes the stray member out with the index, and finishes: a stray member never stops a person's erasure for good.
 * Only a reply that is not a list of texts is unknown, and then the erasure says it is not finished.
 */
// Synthetic Redis only.
import { forgetAgreementsPerson } from "@/lib/agreement-store";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "s".repeat(32);
const EMAIL = "person@example.test";
const person = `nl:agree:p:${SID}:${personKey(SID, EMAIL)}`;
const ID = "a".repeat(32);

async function main(): Promise<void> {
  part("a stray member beside a real agreement: the erasure finishes");
  redis.clear();
  redis.run(["SADD", person, "bad", ID]);
  redis.run(["SET", `nl:agree:r:${ID}`, JSON.stringify({ id: ID, sid: SID, email: EMAIL })]);
  redis.run(["SET", `nl:agree:v:${ID}:1`, JSON.stringify({ text: "Private agreement" })]);
  redis.run(["ZADD", `nl:agree:s:${SID}`, 1, ID]);
  const outcome = await forgetAgreementsPerson(SID, EMAIL).then((n) => `resolved ${n}`, () => "threw");
  is("the erasure says done, with the one agreement", outcome, "resolved 1");
  is("the agreement's record is gone", redis.run(["GET", `nl:agree:r:${ID}`]), null);
  is("its text is gone", redis.run(["GET", `nl:agree:v:${ID}:1`]), null);
  is("the person's index is gone, stray member included", redis.run(["EXISTS", person]), 0);

  part("only a stray member: the erasure finishes with nothing to delete");
  redis.clear();
  redis.run(["SADD", person, "bad"]);
  is("the erasure says done", await forgetAgreementsPerson(SID, EMAIL).then((n) => `resolved ${n}`, () => "threw"), "resolved 0");
  is("the index is gone", redis.run(["EXISTS", person]), 0);

  part("an index that does not read as a list of texts: not finished");
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  for (const [what, reply] of [["a number", [7]], ["a list with a number in it", [["bad", 7]]], ["no reply", []]] as [string, unknown[]][]) {
    redis.clear();
    redis.run(["SADD", person, ID]);
    redis.pipeline = (async (batch) => (batch[0][0] === "SMEMBERS" ? reply : original(batch))) as typeof redis.pipeline;
    try {
      is(`${what}: the erasure throws`, await forgetAgreementsPerson(SID, EMAIL).then((n) => `resolved ${n}`, () => "threw"), "threw");
    } finally {
      redis.pipeline = original;
    }
    is(`${what}: the index is kept`, redis.run(["EXISTS", person]), 1);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
