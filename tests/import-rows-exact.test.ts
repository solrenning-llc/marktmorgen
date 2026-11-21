/**
 * Rule 24 (CX-123), rule 30 sibling of takeMovedCount (lib/imports.ts): the month's imported rows (takeImportRows)
 * counted with `Number(total)` after a SET NX + INCRBY whose replies were never read exactly. A reply of another shape
 * (`true`, a one-element list, a fraction) read as a small number, under the plan's rows, and the upload was taken
 * although nothing proved the count: more rows than the plan holds could be imported (and stored, read and applied)
 * in a month. takeMovedCount, beside it, already reads the same pair exactly. Found by Claude 3 (nuvem C) in the
 * audit of imports and integrations, 11 November 2026.
 *
 * Expected: only a whole count for the INCRBY and 0 or 1 for the EXPIRE NX take rows (main's windowCountBy, which
 * replaced the SET NX + INCRBY since; merge of 15 November 2026); any other shape is "unavailable", never ok. Controls: exact replies still take rows under the limit and refuse them over it.
 * In-memory Redis double and a synthetic store only.
 */
import { takeImportRows } from "@/lib/imports";
import { importRowsFor } from "@/lib/import-limits";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ROWS = "nl:imports:rows:";
const pipeline = redis.pipeline.bind(redis);
/** The month's rows count answers `incr` and `expire` and changes nothing. */
function countAnswers(incr: unknown, expire: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 2 && commands[0][0] === "INCRBY" && String(commands[0][1]).startsWith(ROWS) && commands[1][0] === "EXPIRE") return [incr, expire];
    return pipeline(commands);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = pipeline;
};

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "rows@example.com";
  await claimHandle(OWNER, "rowsexact", "Rows Exact", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_RowsExact1", subscriptionId: "sub_RowsExact1", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const limit = importRowsFor(store);
  is("the plan has a month of rows", limit > 100, true);

  part("Controls: exact replies");
  is("100 rows under the limit are taken", await takeImportRows(store, 100), { ok: true, counted: 100 });
  is("a batch over what is left is refused whole", await takeImportRows(store, limit), { ok: false, reason: "rows_month", limit });

  part("A reply of another shape is never a count");
  const shapes: [string, unknown, unknown][] = [
    ["INCRBY true", true, 1],
    ["INCRBY [150]", [150], 1],
    ["INCRBY [\"150\"]", ["150"], 1],
    ["INCRBY 150.5", 150.5, 1],
    ["INCRBY \"abc\"", "abc", 1],
    ["INCRBY {}", {}, 1],
    ["EXPIRE NX \"QUEUED\"", 150, "QUEUED"],
    ["EXPIRE NX 2", 150, 2],
  ];
  for (const [label, incr, expire] of shapes) {
    countAnswers(incr, expire);
    try {
      const took = await takeImportRows(store, 50);
      is(`${label}: not taken, unavailable`, took, { ok: false, reason: "unavailable", limit });
    } finally {
      restore();
    }
  }

  part("Controls: the forms Redis answers in");
  countAnswers(150, 0);
  try {
    is("INCRBY 150, EXPIRE NX 0: taken", await takeImportRows(store, 50), { ok: true, counted: 50 });
  } finally {
    restore();
  }
  countAnswers("150", 1);
  try {
    is("INCRBY \"150\" as a whole number in text, EXPIRE NX 1: taken", await takeImportRows(store, 50), { ok: true, counted: 50 });
  } finally {
    restore();
  }
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
