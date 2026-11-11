/**
 * Rule 24 (CX-123), rule 30 sibling of takeMovedCount (lib/imports.ts): the month's imported rows (takeImportRows)
 * counted with `Number(total)` after a SET NX + INCRBY whose replies were never read exactly. A reply of another shape
 * (`true`, a one-element list, a fraction) read as a small number, under the plan's rows, and the upload was taken
 * although nothing proved the count: more rows than the plan holds could be imported (and stored, read and applied)
 * in a month. takeMovedCount, beside it, already reads the same pair exactly. Found by Claude 3 (nuvem C) in the
 * audit of imports and integrations, 11 November 2026.
 *
 * Expected: only "OK" or null for the SET NX and a whole count for the INCRBY take rows; any other shape is
 * "unavailable", never ok. Controls: exact replies still take rows under the limit and refuse them over it.
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
/** The month's rows count answers `set` and `incr` and changes nothing. */
function countAnswers(set: unknown, incr: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 2 && commands[0][0] === "SET" && String(commands[0][1]).startsWith(ROWS) && commands[1][0] === "INCRBY") return [set, incr];
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
  is("100 rows under the limit are taken", await takeImportRows(store, 100), { ok: true });
  is("a batch over what is left is refused whole", await takeImportRows(store, limit), { ok: false, reason: "rows_month", limit });

  part("A reply of another shape is never a count");
  const shapes: [string, unknown, unknown][] = [
    ["INCRBY true", null, true],
    ["INCRBY [150]", null, [150]],
    ["INCRBY [\"150\"]", null, ["150"]],
    ["INCRBY 150.5", null, 150.5],
    ["INCRBY \"abc\"", null, "abc"],
    ["INCRBY {}", null, {}],
    ["SET NX \"QUEUED\"", "QUEUED", 150],
    ["SET NX 1", 1, 150],
  ];
  for (const [label, set, incr] of shapes) {
    countAnswers(set, incr);
    try {
      const took = await takeImportRows(store, 50);
      is(`${label}: not taken, unavailable`, took, { ok: false, reason: "unavailable", limit });
    } finally {
      restore();
    }
  }

  part("Controls: the forms Redis answers in");
  countAnswers(null, 150);
  try {
    is("SET NX null, INCRBY 150: taken", await takeImportRows(store, 50), { ok: true });
  } finally {
    restore();
  }
  countAnswers("OK", "150");
  try {
    is("SET NX OK, INCRBY \"150\" as a whole number in text: taken", await takeImportRows(store, 50), { ok: true });
  } finally {
    restore();
  }
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
