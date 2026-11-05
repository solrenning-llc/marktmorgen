import assert from "node:assert/strict";
import { listAsCsv } from "@/lib/free";
import { MAX_CRM_FIELDS, MAX_FIELD_VALUE, type CrmField } from "@/lib/crm-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

/** Report-only proof for main's reader, which is occupied by other PRs.
 * app/api/store/leads -> creatorFrom("export") -> countStudio consumes one
 * essential request. The studio line prices that at 40 commands / 200 KB.
 * This exercises the real CSV and CRM reader after that admission boundary;
 * it does not replace authentication or claim a real provider invoice.
 */
async function main() {
  const statsId = "a".repeat(32);
  const listId = "b".repeat(32);
  const fields: CrmField[] = Array.from({ length: MAX_CRM_FIELDS }, (_, i) => ({ id: `f${String(i).padStart(5, "0")}`, name: `Field ${i}`, type: "text", options: [] }));
  const pipeline = redis.pipeline.bind(redis);
  await pipeline([["SET", `nl:crm:fields:${statsId}`, JSON.stringify(fields)]]);
  for (const field of fields) {
    const pairs = Array.from({ length: 500 }, (_, i) => [i.toString(16).padStart(32, "0"), "界".repeat(MAX_FIELD_VALUE)]).flat();
    await pipeline([["HSET", `nl:crm:v:${statsId}:${field.id}`, ...pairs]]);
  }
  const commands: (string | number)[][] = [];
  let bytes = 0;
  redis.pipeline = async (batch) => {
    commands.push(...batch);
    const result = await pipeline(batch);
    bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(result));
    return result;
  };
  globalThis.fetch = async () => { throw new Error("No real supplier calls in this proof"); };
  try {
    const csv = await listAsCsv({ statsId, listId } as Store, false);
    assert.ok(csv.includes('"Field 0"'), "the real CSV has read the field schema");
    assert.equal(commands.filter((command) => command[0] === "HGETALL").length, MAX_CRM_FIELDS);
    console.log(`MEASURE essential CSV export: ${commands.length} commands, ${bytes} JSON bytes; priced ceiling 40 commands / 200000 bytes`);
    assert.ok(bytes <= 200_000, `CRM reader transferred ${bytes} bytes against the essential export's 200000-byte envelope`);
  } finally { redis.pipeline = pipeline; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
