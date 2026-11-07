/** Independent pure cell-encoding boundaries; no provider, network or database. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cutToBytes, csvRow, SALES_FILE_COLUMNS } from "@/lib/stats";

const samples = [
  ["ASCII", "a".repeat(4000)],
  ["CJK", "名".repeat(1500)],
  ["astral", "😀".repeat(1500)],
  ["quotes", '"'.repeat(2000)],
  ["backslashes", "\\".repeat(4000)],
  ["formula", "=" + "名".repeat(1500)],
  ["unpaired surrogate", String.fromCharCode(0xd800).repeat(2000)],
  ["combining", "e\u0301".repeat(2000)],
] as const;
for (const [name, input] of samples) {
  test(`pure UTF-8 and CSV ceilings: ${name}`, () => {
    for (const [, max] of SALES_FILE_COLUMNS) {
      const cut = cutToBytes(input, max);
      const bytes = Buffer.byteLength(cut.replace(/"/g, '""'), "utf8");
      assert.ok(bytes <= max, `${name}: ${bytes} > ${max}`);
      assert.ok(Buffer.byteLength(csvRow([cut]), "utf8") <= max + 3);
      if (max >= 3) assert.ok(cut.endsWith("…"));
    }
  });
}
