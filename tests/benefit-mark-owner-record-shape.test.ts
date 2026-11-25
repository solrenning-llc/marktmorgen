/**
 * An owner's record that is not a JSON object is unknown (-3), never "erased" (-2), in BENEFIT_MARK as in its mirror
 * (Claude 3 yaQt's LEVE on #4880 @9cd65e7197). On a real Redis, cjson decodes a JSON list ("[1]", "[]") to a table, so
 * v3 passed its `type(record) ~= "table"` check, failed the statsId compare and returned -2: giveBenefit then answered
 * "erased" for a store that is not erased. lib/redis-memory.ts returned -3 for it (Array.isArray), so the tests, which
 * run only the mirror, held a -3 the script never gave. v4 refuses, before decoding, any record that does not start
 * as a JSON object; the mirror's -3 for a list, a string, a number or null is now the script's too.
 *
 * Synthetic only: the script's own text, and the mirror on the repository's in-memory Redis.
 */
import { BENEFIT_MARK } from "@/lib/tier-benefits";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const KEYS = ["t:marks", "t:who", "t:prints", "t:owner", "t:erasing"];
const mark = async (record: string | null, statsId = "s1") => {
  redis.clear();
  if (record !== null) await redis.pipeline([["SET", "t:owner", record]]);
  return (await redis.pipeline([["EVAL", BENEFIT_MARK, 5, ...KEYS, "print1", "person1", "field1", statsId, "b1", "1"]]))[0];
};

async function main(): Promise<void> {
  part("The script refuses, before decoding, an owner's record that is not a JSON object");
  is("its version is v4", BENEFIT_MARK.startsWith("-- marktmorgen:benefit-mark:v4\n"), true);
  const guard = BENEFIT_MARK.indexOf('if not string.find(raw, "^%s*{") then return -3 end');
  is("a record that does not start as a JSON object returns -3", guard > 0, true);
  is("and it is checked before cjson decodes the record", guard > 0 && guard < BENEFIT_MARK.indexOf("pcall(cjson.decode, raw)"), true);

  part("The mirror gives the same answers (lib/redis-memory.ts)");
  for (const [label, record] of [["a list", "[1]"], ["an empty list", "[]"], ["a string", '"s1"'], ["a number", "7"], ["null", "null"], ["not JSON", "{oops"]] as const) {
    is(`an owner's record that is ${label}: unknown (-3)`, await mark(record), -3);
  }
  is("another store's record: erased (-2)", await mark('{"statsId":"s2"}'), -2);
  is("no record: erased (-2)", await mark(null), -2);
  is("control: its own record, with spaces before it: the mark is written", await mark('  {"statsId":"s1"}'), [1, 1]);
  done();
}

void main();
