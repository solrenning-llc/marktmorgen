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
import { IMPORT_LIMITS, addRows, finishUpload, readBatch, readJob, runImport, startImport, takeImportRows } from "@/lib/imports";
import { BATCH_BYTES } from "@/lib/import-batches";
import { IMPORT_ALLOWANCES, IMPORT_MIN_ROWS_PER_UPLOAD, IMPORT_ROW_BYTES, IMPORT_WORST_BYTES_PER_ROW, IMPORT_WORST_COMMANDS_PER_ROW } from "@/lib/import-limits";
import { MAX_ABOUT_LENGTH } from "@/lib/product-about";
import { MAX_TITLE_LENGTH } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { jsonBytes } from "@/lib/list-download";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
/** The most rows one upload request may carry for products (IMPORT_LIMITS.products), all in one batch. */
const ROWS = IMPORT_LIMITS.products;
const UPLOAD = IMPORT_LIMITS.products;

/** The cells of one upload: titles of `titleChar` at MAX_TITLE_LENGTH, and `about` as each description. */
function cellsOf(first: number, count: number, titleChar: string, about: string): (string | number)[][] {
  return Array.from({ length: count }, (_, i) => [first + i + 2, `${titleChar.repeat(MAX_TITLE_LENGTH - 6)}${String(first + i).padStart(6, "0")}`, "19", about, "", ""]);
}

/**
 * The longest description of `ch` that lets ROWS rows still go in one upload request (BATCH_BYTES, the route's body
 * cap): the batch is read back whole once for every CHUNK of its rows, so the fullest batch is the dearest per row
 * (Claude 1's MEDIUM on #5259, 7090896192).
 */
function fullestAbout(ch: string, titleChar: string): string {
  let low = 0;
  let high = MAX_ABOUT_LENGTH;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const body = Buffer.byteLength(JSON.stringify({ rows: cellsOf(0, ROWS, titleChar, ch.repeat(mid)) }));
    if (body <= BATCH_BYTES - 4_096) low = mid;
    else high = mid - 1;
  }
  return ch.repeat(low);
}

/** One products import of ROWS rows with `about` as each description, from its first upload to done. */
async function measure(about: string, titleChar = "T"): Promise<{ counted: number; commands: number; bytes: number; added: number }> {
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
    // The request as this client writes it; the answer as the database may write it, every character at its widest
    // (lib/list-download.ts jsonBytes: <, > and & in six bytes; Claude 2 lpgvy's MEDIUM on #5259, 7091806924).
    bytes += Buffer.byteLength(JSON.stringify(batch)) + jsonBytes(answer ?? null);
    return answer;
  }) as typeof redis.pipeline;
  try {
    for (let first = 0; first < ROWS; first += UPLOAD) {
      const cells = cellsOf(first, Math.min(UPLOAD, ROWS - first), titleChar, about);
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

for (const [name, about, titleChar] of [
  ["the fullest upload of ampersands, titles and descriptions both (the worst found: six bytes each in an answer)", fullestAbout("&", "&"), "&"],
  ["the fullest upload of less-than signs, titles and descriptions both", fullestAbout("<", "<"), "<"],
  ["the fullest upload of quotes, titles and descriptions both", fullestAbout("\"", "\""), "\""],
  ["the fullest upload of quote descriptions", fullestAbout("\"", "T"), "T"],
  ["the fullest upload of backslash descriptions", fullestAbout("\\", "T"), "T"],
  ["the fullest upload of ampersand descriptions", fullestAbout("&", "T"), "T"],
  ["no descriptions", "", "T"],
] as const) {
  test(`a products import with ${name} stays inside the imports line's per-row figures`, async () => {
    const { counted, commands, bytes, added } = await measure(about, titleChar);
    assert.equal(added, ROWS, "every row became a product, so the whole write is counted");
    console.log(`IMPORT_BYTES ${name}: ${Math.round(bytes / counted)} bytes and ${(commands / counted).toFixed(2)} commands a counted row (${counted} counted)`);
    assert.ok(bytes <= counted * IMPORT_WORST_BYTES_PER_ROW, `${bytes} bytes for ${counted} counted rows: ${Math.round(bytes / counted)} a row, over IMPORT_WORST_BYTES_PER_ROW ${IMPORT_WORST_BYTES_PER_ROW}`);
    assert.ok(commands <= counted * IMPORT_WORST_COMMANDS_PER_ROW, `${commands} commands for ${counted} counted rows, over IMPORT_WORST_COMMANDS_PER_ROW ${IMPORT_WORST_COMMANDS_PER_ROW}`);
  });
}

test("the rows each plan prints are the same: only the price of a counted row changed", () => {
  // Claude 1 coord (bf13): IMPORT_WORST_BYTES_PER_ROW prices the imports line and never decides how many rows a creator
  // may bring in. The printed figures, as on main before this change.
  assert.deepEqual(
    Object.fromEntries(Object.entries(IMPORT_ALLOWANCES).map(([tier, a]) => [tier, a.rows])),
    { creator: 1_000, pro: 8_000, scale: 20_000 },
  );
  assert.equal(IMPORT_ROW_BYTES, 2_000, "an upload still counts a row for every 2,000 bytes it carries");
  assert.equal(IMPORT_MIN_ROWS_PER_UPLOAD, 50);
});
