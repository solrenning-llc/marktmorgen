import assert from "node:assert/strict";
import { normaliseEmail } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { BENEFIT_MARK_VALUE_BYTES } from "./plan-cost-registry";

/**
 * BENEFIT_MARK_VALUE_BYTES is what one mark costs on the wire when readOwedMarks reads it back with HMGET
 * (lib/tier-benefits.ts): the stored `{"at":<seconds>,"by":"<address>"}`, sent back by the database as a JSON string
 * inside its JSON reply, so every character is escaped twice. The address is giveBenefit's
 * `normaliseEmail(by).slice(0, 320)`, and parseGiven reads back any address of up to 320 characters, so the worst
 * mark has 320 characters of the dearest kind that normaliseEmail keeps. A control character such as U+0001 (not
 * whitespace, so trim() keeps it) is stored as `\u0001` and comes back as `\\u0001`: 7 bytes. A quote comes back as 4
 * bytes and an ideograph as 3. The seconds are counted at 11 digits, past the year 5000.
 */
const at = 99_999_999_999;
const kinds: [string, string][] = [["control U+0001", "\u0001"], ["quote", '"'], ["backslash", "\\"], ["ideograph", "中"], ["ascii", "a"]];
let checks = 0;
let worst = 0;

async function main() {
  for (const [name, ch] of kinds) {
    const by = normaliseEmail(ch.repeat(400)).slice(0, 320);
    assert.equal(by.length, 320, `normaliseEmail keeps the ${name} character`);
    const key = `nl:tben:marks:test:${name}`;
    await redis.pipeline([["HSET", key, "f", JSON.stringify({ at, by })]]);
    const [reply] = await redis.pipeline([["HMGET", key, "f"]]);
    const value = (reply as unknown[])[0];
    const bytes = Buffer.byteLength(JSON.stringify(value));
    worst = Math.max(worst, bytes);
    console.log(`MEASURE ${name}: ${bytes} bytes on the wire`);
    assert.ok(bytes <= BENEFIT_MARK_VALUE_BYTES, `a mark of 320 ${name} characters is ${bytes} bytes on the wire, above BENEFIT_MARK_VALUE_BYTES (${BENEFIT_MARK_VALUE_BYTES})`);
    checks += 1;
  }
  console.log(`MEASURE worst mark: ${worst} bytes; declared ${BENEFIT_MARK_VALUE_BYTES}`);
  console.log(`${checks} checks, all passing.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
