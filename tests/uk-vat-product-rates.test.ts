/**
 * 793 [IV3] unit 4: the UK VAT rate table (lib/uk-vat-product-rates.ts) is exactly the page kept in the repository,
 * and a rate is given only for a row written "0%", "5%" or "Standard-rated"; anything else is refused, never 0%.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { UK_VAT_PRODUCT_RATES, UK_VAT_PRODUCT_RATES_VALID_UNTIL, UK_VAT_RATES_FILE, type UkProductRateRow, ukProductRateBps } from "@/lib/uk-vat-product-rates";

const root = process.cwd();
const bytes = readFileSync(join(root, UK_VAT_RATES_FILE.path));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const text = (raw: string): string =>
  raw
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
      name[0] === "#" ? String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? whole))
    .replace(/\s+/g, " ")
    .trim();

/**
 * The page's own tables, body row by body row, under the section heading each sits in. A table's header is its
 * <thead> (whatever its first column is called, "Goods or services" or "Installed goods"), never data: only the rows
 * of each <tbody>, whose cells are <td>, are read (Claude 1's LEVE on #5045, 7070733228).
 */
function rowsOfThePage(): UkProductRateRow[] {
  const page = JSON.parse(bytes.toString("utf8")) as { details: { body: string } };
  const rows: UkProductRateRow[] = [];
  let section = "";
  for (const match of page.details.body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>|<tbody>([\s\S]*?)<\/tbody>/g)) {
    if (match[1] !== undefined) {
      section = text(match[1]);
      continue;
    }
    for (const row of match[2].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      assert.doesNotMatch(row[1], /<th[\s>]/, "a header cell inside a table body");
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => text(cell[1]));
      rows.push({ section, item: cells[0] ?? "", rate: cells[1] ?? "", more: cells[2] ?? "" });
    }
  }
  return rows;
}

test("the kept page is the file that was read: its SHA-256, address and dates", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), UK_VAT_RATES_FILE.sha256);
  const page = JSON.parse(bytes.toString("utf8")) as { base_path: string; public_updated_at: string; title: string };
  assert.equal(page.title, "VAT rates on different goods and services");
  assert.equal(`https://www.gov.uk${page.base_path}`, UK_VAT_RATES_FILE.page);
  assert.equal(UK_VAT_RATES_FILE.source, `https://www.gov.uk/api/content${page.base_path}`);
  assert.equal(page.public_updated_at.slice(0, 10), UK_VAT_RATES_FILE.pageUpdatedOn);
});

test("every row of the table is exactly a row of the page, in the page's order, and none is missing", () => {
  const page = rowsOfThePage();
  assert.ok(page.length > 100, `${page.length} rows read`);
  assert.deepEqual([...UK_VAT_PRODUCT_RATES], page);
});

test("no row is a table header: no rate or item is a column title", () => {
  const titles = new Set(["VAT rate", "More information", "More\u00a0information", "Goods or services", "Installed goods"]);
  for (const row of UK_VAT_PRODUCT_RATES) {
    assert.ok(!titles.has(row.rate), `${row.item}: rate "${row.rate}" is a column title`);
    assert.ok(!titles.has(row.item), `item "${row.item}" is a column title`);
  }
});

const day = "2026-11-21";
test("a rate only where the page writes one", () => {
  assert.equal(ukProductRateBps("Printing, postage, publications — books, magazines and newspapers", "Books", day), 0);
  assert.equal(ukProductRateBps("Printing, postage, publications — books, magazines and newspapers", "Other postal services that are not subject to a universal service obligation", day), 2000);
  const fivePercent = UK_VAT_PRODUCT_RATES.find((row) => row.rate === "5%");
  assert.ok(fivePercent);
  assert.equal(ukProductRateBps(fivePercent.section, fivePercent.item, day), 500);
});

test("exempt, conditional, outside the scope, unknown, disagreeing or out of date: refused, never 0%", () => {
  for (const row of UK_VAT_PRODUCT_RATES.filter((r) => !["0%", "5%", "Standard-rated"].includes(r.rate))) {
    const same = UK_VAT_PRODUCT_RATES.filter((r) => r.section === row.section && r.item === row.item);
    assert.equal(ukProductRateBps(row.section, row.item, day), null, `${row.item}: ${row.rate} (${same.length} rows)`);
  }
  assert.equal(ukProductRateBps("Printing, postage, publications — books, magazines and newspapers", "E-books", day), null);
  assert.equal(ukProductRateBps("Somewhere else", "Books", day), null);
  const books = { section: "S", item: "Books", rate: "0%", more: "" };
  assert.equal(ukProductRateBps("S", "Books", day, [books, { ...books, rate: "Standard-rated" }]), null);
  assert.equal(ukProductRateBps("S", "Books", day, [books, books]), 0);
  const after = new Date(Date.parse(`${UK_VAT_PRODUCT_RATES_VALID_UNTIL}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  assert.equal(ukProductRateBps("Printing, postage, publications — books, magazines and newspapers", "Books", after), null);
  for (const bad of ["2026-11-20", "2026-02-30", "21/11/2026", ""]) {
    assert.equal(ukProductRateBps("Printing, postage, publications — books, magazines and newspapers", "Books", bad), null, bad);
  }
});
