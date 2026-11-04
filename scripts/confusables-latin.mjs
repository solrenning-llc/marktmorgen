/**
 * Writes lib/confusables-latin.ts from the committed copy of Unicode's
 * confusables.txt (scripts/confusables-latin-table.mjs has what is kept and
 * why). tests/deal-words.test.ts fails when the file on disk is not what
 * this writes. No network: run it again after replacing the copy. The copy
 * and the data made from it are under the Unicode License v3, whose text is
 * tooling/unicode/LICENSE.
 *
 *   node scripts/confusables-latin.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTable } from "./confusables-latin-table.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "lib/confusables-latin.ts"), renderTable(readFileSync(join(root, "tooling/unicode/confusables-18.0.0.txt"), "utf8")));
