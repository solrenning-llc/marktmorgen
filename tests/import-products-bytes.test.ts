/**
 * #5010 row 150 (Claude 6 z5v4's route sweep 2f36): a products import moved about 15.5 KB through the database for
 * each row it counted, against IMPORT_WORST_BYTES_PER_ROW of 3,000 that the imports line priced every row at. A
 * description of MAX_ABOUT_LENGTH characters that JSON escapes (a quote or a backslash, two bytes each) is uploaded,
 * kept in its batch, read back once for each CHUNK of the batch, charged to the data room and written as the product's
 * long description: its bytes go through several times, while the upload counts one row for every IMPORT_ROW_BYTES it
 * carries. Measured here end to end, as Upstash bills a request's bytes and its answer's, for the worst cells and two
 * controls; the per-row figures hold them. Synthetic store and rows only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, readBatch, readJob, runImport, startImport, takeImportRows } from "@/lib/imports";
import { IMPORT_MIN_ROWS_PER_UPLOAD, IMPORT_ROW_BYTES, IMPORT_WORST_BYTES_PER_ROW, IMPORT_WORST_COMMANDS_PER_ROW } from "@/lib/import-limits";
import { MAX_ABOUT_LENGTH } from "@/lib/product-about";
import { MAX_TITLE_LENGTH } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const ROWS = 100;
const UPLOAD = 100;

/** One products import of ROWS rows with `about` as each description, from its first upload to done. */
async function measure(about: string): Promise<{ counted: number; commands: number; bytes: number; added: number }> {
  redis.clear();
  const owner = "import-bytes@example.test";
  await claimHandle(owner, "importbytes", "Import bytes", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_ImportBytes01", subscriptionId: "sub_ImportBytes01", active: true, tier: "scale", cycle: "month", period: paidPeriod() } as never);
  const store = (await storeForEmail(owner))!;
  const started = await startImport(store, owner, "products", { expected: ROWS, file: "products.csv", source: "csv" } as never);
  assert.ok(started.ok, "the import starts");
  const id = started.job.id;
  let commands = 0;
  let bytes = 0;
  let counted = 0;
  const plainRun = redis.run.bind(redis);
  const plainPipeline = redis.pipeline;
  (redis as { run: typeof plainRun }).run = (command) => { commands += 1; return plainRun(command); };
  redis.pipeline = (async (batch: Batch) => {
    const answer = await plainPipeline(batch);
    bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(answer ?? null));
    return answer;
  }) as typeof redis.pipeline;
  try {
    for (let first = 0; first < ROWS; first += UPLOAD) {
      const cells = Array.from({ length: Math.min(UPLOAD, ROWS - first) }, (_, i) => [first + i + 2, `${"T".repeat(MAX_TITLE_LENGTH - 6)}${String(first + i).padStart(6, "0")}`, "19", about, "", ""]);
      const rows = readBatch("products", cells as never)!;
      const size = Buffer.byteLength(JSON.stringify(rows));
      // As the route counts an upload (app/api/store/import/route.ts), and as takeImportRows rounds it up.
      assert.ok((await takeImportRows(store, rows.length, Date.now(), size)).ok, "the rows are taken");
      counted += Math.max(rows.length, IMPORT_MIN_ROWS_PER_UPLOAD, Math.ceil(size / IMPORT_ROW_BYTES));
      assert.ok((await addRows(store, id, rows)).ok, "the rows are kept");
    }
    assert.ok((await finishUpload((await storeForEmail(owner))!, id)).ok, "the upload is finished");
    for (let run = 0; run < 100; run += 1) {
      const job = await runImport(id, Date.now() + 50_000);
      if (!job || job.state === "done" || job.state === "failed" || job.state === "canceled") break;
    }
  } finally {
    (redis as { run: typeof plainRun }).run = plainRun;
    redis.pipeline = plainPipeline;
  }
  const job = await readJob(id);
  return { counted, commands, bytes, added: job?.counts.added ?? 0 };
}

for (const [name, about] of [
  ["descriptions of quotes, escaped to two bytes each (the worst found)", "\"".repeat(MAX_ABOUT_LENGTH)],
  ["descriptions of backslashes", "\\".repeat(MAX_ABOUT_LENGTH)],
  ["descriptions of ampersands", "&".repeat(MAX_ABOUT_LENGTH)],
  ["no descriptions", ""],
] as const) {
  test(`a products import with ${name} stays inside the imports line's per-row figures`, async () => {
    const { counted, commands, bytes, added } = await measure(about);
    assert.equal(added, ROWS, "every row became a product, so the whole write is counted");
    assert.ok(bytes <= counted * IMPORT_WORST_BYTES_PER_ROW, `${bytes} bytes for ${counted} counted rows: ${Math.round(bytes / counted)} a row, over IMPORT_WORST_BYTES_PER_ROW ${IMPORT_WORST_BYTES_PER_ROW}`);
    assert.ok(commands <= counted * IMPORT_WORST_COMMANDS_PER_ROW, `${commands} commands for ${counted} counted rows, over IMPORT_WORST_COMMANDS_PER_ROW ${IMPORT_WORST_COMMANDS_PER_ROW}`);
  });
}
