/**
 * Issue #4804 (Codex X5, reproduced by Claude 2): forgetAgreementsPerson dropped a member of the person's agreement index
 * that is not an id, deleted the whole index and said done, losing the only way back to that record.
 */
// Synthetic Redis only.
import { forgetAgreementsPerson } from "@/lib/agreement-store";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "s".repeat(32);
const EMAIL = "person@example.test";
const person = `nl:agree:p:${SID}:${personKey(SID, EMAIL)}`;

async function main(): Promise<void> {
  part("a malformed member of the person's agreement index keeps the erasure retryable");
  redis.clear();
  redis.run(["SADD", person, "bad"]);
  redis.run(["SET", "nl:agree:r:bad", JSON.stringify({ email: EMAIL, name: "Person" })]);
  redis.run(["SET", "nl:agree:v:bad:1", JSON.stringify({ text: "Private agreement" })]);
  const outcome = await forgetAgreementsPerson(SID, EMAIL).then((n) => `resolved ${n}`, () => "threw");
  is("the erasure does not say done", outcome, "threw");
  is("the person's index is kept", redis.run(["SMEMBERS", person]), ["bad"]);
  is("the record is still stored", typeof redis.run(["GET", "nl:agree:r:bad"]), "string");
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
