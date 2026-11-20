/**
 * An import's rows go to the server in batches cut by rows and by weight (lib/import-batches.ts), so a file inside
 * every limit an import states is never refused whole for a request too heavy. The page cut batches by a thousand
 * rows alone: 500 products with descriptions of 2,500 characters made one request of more than BATCH_BYTES, the
 * server refused it (413) and the page said "try again", which failed the same way. Synthetic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BATCH_BYTES, BATCH_ROWS, importBatches } from "@/lib/import-batches";
import { BATCH_BYTES as SERVER_BYTES, BATCH_ROWS as SERVER_ROWS, IMPORT_LIMITS, readBatch } from "@/lib/imports";
import { done, is, part } from "./check";

const weigh = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

part("One limit, on the page and on the server");
is("the server reads the same limits the page cuts by", [SERVER_BYTES, SERVER_ROWS], [BATCH_BYTES, BATCH_ROWS]);

part("A file of long product descriptions goes in batches the server takes");
const products = Array.from({ length: IMPORT_LIMITS.products }, (_, i) => [String(i + 2), `Guide ${i}`, "19", "Lesson notes, \"quoted\" and ünïcode. ".repeat(70).slice(0, 2_500), "paid", "https://example.com/guide"]);
const body = (slice: string[][]) => ({ action: "rows", id: "imp_synthetic", rows: slice });
is("setup: as one batch of a thousand rows, as the page sent it, it is heavier than the server takes", weigh(body(products)) > BATCH_BYTES, true);
const ranges = importBatches(products, body);
is("it is cut into more than one batch", (ranges?.length ?? 0) > 1, true);
is("every batch weighs no more than the server takes", (ranges ?? []).every(([from, to]) => weigh(body(products.slice(from, to))) <= BATCH_BYTES), true);
is("every batch is read by the server as it is", (ranges ?? []).every(([from, to]) => readBatch("products", products.slice(from, to))?.length === to - from), true);
is("the batches cover every row once, in order", (ranges ?? []).flatMap(([from, to]) => products.slice(from, to).map((row) => row[0])), products.map((row) => row[0]));

part("Rows and edges");
const contacts = Array.from({ length: 2_500 }, (_, i) => [String(i + 2), `p${i}@example.com`, "", "", ""]);
is("light rows still go a thousand at a time", importBatches(contacts, body)?.map(([from, to]) => to - from), [1_000, 1_000, 500]);
is("no rows, no batch", importBatches([], body), []);
is("a row that cannot fit alone is said, never sent", importBatches([["2", "x".repeat(BATCH_BYTES)]], body), null);

part("The page sends what is cut here");
const page = readFileSync(join(process.cwd(), "components/import-tool.tsx"), "utf8");
is("both the dry run and the upload are cut by importBatches, with no fixed thousand-row slice left", [(page.match(/importBatches\(rows,/g) ?? []).length, /from \+= BATCH|from \+ BATCH/.test(page)], [2, false]);
done();
