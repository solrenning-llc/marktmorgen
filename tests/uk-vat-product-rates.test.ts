/**
 * 793 [IV3] unit 4: the UK VAT rate table (lib/uk-vat-product-rates.ts) is exactly the page kept in the repository,
 * and a rate is given only for a row written "0%", "5%" or "Standard-rated"; anything else is refused, never 0%.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RELIEF_NOT_BY_PRODUCT_ITEMS, RELIEF_NOT_BY_PRODUCT_NOTES, RELIEF_NOT_BY_PRODUCT_WORDS, UK_VAT_PRODUCT_RATES, UK_VAT_PRODUCT_RATES_VALID_UNTIL, UK_VAT_RATES_FILE, type UkProductRateRow, ukProductRateBps } from "@/lib/uk-vat-product-rates";

const root = process.cwd();
const bytes = readFileSync(join(root, UK_VAT_RATES_FILE.path));

/**
 * A cell's text: its tags removed until none is left, its spaces collapsed. The kept page has no HTML entities (GOV.UK's
 * content API gives the body already decoded), so none is decoded here: a "<", a ">" or an entity left over is not plain
 * text and fails the read, never turned into markup (CodeQL's incomplete multi-character sanitization on #5045).
 */
function text(raw: string): string {
  let out = raw;
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  out = out.replace(/\s+/g, " ").trim();
  if (/[<>]|&(?:#x?[0-9a-f]+|[a-z]+);/i.test(out)) throw new Error(`a cell is not plain text: ${JSON.stringify(out.slice(0, 80))}`);
  return out;
}

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

test("a cell is read as plain text: an encoded or nested tag is refused, never decoded into markup (CodeQL on #5045)", () => {
  assert.equal(text("<a href=\"x\">VAT Notice 701/10</a>"), "VAT Notice 701/10");
  assert.equal(text("<<b>script>alert(1)"), "alert(1)", "tags are removed until none is left");
  for (const raw of ["&lt;script&gt;alert(1)&lt;/script&gt;", "Books &amp; magazines", "a &#60;b", "a < b"]) {
    assert.throws(() => text(raw), /not plain text/, raw);
  }
});

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
  // A 5% row whose rate depends only on the product (the first 5% row, "Mobility aids for the elderly", depends on the buyer).
  assert.equal(ukProductRateBps("Clothing and footwear, protective and safety equipment", "Children’s car seats, booster seats and booster cushions", day), 500);
});

const PRINT = "Printing, postage, publications — books, magazines and newspapers";
test("a row whose own note says some of its items are at another rate: refused, never 0% (Claude 6 hsz3, 7094213497)", () => {
  // "Publications ... Some items are standard-rated such as exercise books, letterheads, posters": which item is which
  // is not in this table, so the row gives no rate.
  assert.equal(ukProductRateBps(PRINT, "Publications", day), null);
  // "Houseboats — sale or let out on hire ... But holiday accommodation let in a moored houseboat is standard-rated".
  assert.equal(ukProductRateBps("Transport, freight, travel and vehicles", "Houseboats — sale or let out on hire", day), null);
  // Rows whose note only cites the notice keep their rate.
  for (const item of ["Books", "Magazines", "Newspapers"]) assert.equal(ukProductRateBps(PRINT, item, day), 0, item);
});

test("a row whose note names another rate at all: refused, never read for its meaning (Claude 1 NIT, 7094619715)", () => {
  // "Sewer and drain cleaning, unblocking or maintenance is standard-rated" may be part of the sewerage row's own
  // services; the note's form does not tell. Any note that names another rate leaves the row without a rate until a
  // person reads it with the product it is linked to.
  const named = /standard-rated|zero-rated|reduced-rated|\bexempt\b|\b\d+%/i;
  const rows = UK_VAT_PRODUCT_RATES.filter((row) => ["0%", "5%", "Standard-rated"].includes(row.rate) && named.test(row.more));
  assert.ok(rows.length >= 13, `${rows.length} rows`);
  for (const row of rows) assert.equal(ukProductRateBps(row.section, row.item, day), null, row.item);
  const sewerage = UK_VAT_PRODUCT_RATES.find((row) => row.item.startsWith("Sewerage services supplied to domestic"));
  assert.ok(sewerage);
  assert.equal(ukProductRateBps(sewerage.section, sewerage.item, day), null);
  // A note that only cites the notice keeps the page's rate.
  for (const item of ["Books", "Magazines", "Newspapers"]) assert.equal(ukProductRateBps(PRINT, item, day), 0, item);
});

test("a row that covers only \"certain\" items, which the table does not name: refused, never 0% (Claude 2 lpgvy)", () => {
  for (const row of UK_VAT_PRODUCT_RATES.filter((r) => /\bcertain\b/i.test(r.item))) {
    assert.equal(ukProductRateBps(row.section, row.item, day), null, row.item);
  }
  const fundraising = UK_VAT_PRODUCT_RATES.find((row) => row.item === "Certain goods sold at charitable fundraising events");
  const lowVision = UK_VAT_PRODUCT_RATES.find((row) => /and certain low vision aids/i.test(row.item));
  assert.ok(fundraising && lowVision);
  assert.equal(ukProductRateBps(fundraising.section, fundraising.item, day), null);
  assert.equal(ukProductRateBps(lowVision.section, lowVision.item, day), null);
  for (const item of ["Books", "Magazines", "Newspapers"]) assert.equal(ukProductRateBps(PRINT, item, day), 0, item);
});

test("a relief that depends on who buys, who sells or what the goods are used for: refused, never 0% (Claude 6 UoHAG, coordinator re-audit #5045)", () => {
  // The condition is a fact about the buyer, the seller or the use, not about the product: a product mapped once to
  // such a row would be sold at the reduced rate to every buyer, and Solrenning LLC would owe the standard rate.
  const probed: [string, string][] = [
    ["Health, education, welfare and charities", "Equipment for disabled people"],
    ["Health, education, welfare and charities", "Mobility aids for the elderly"],
    ["Health, education, welfare and charities", "Advertising services for charities"],
    ["Health, education, welfare and charities", "Incontinence products"],
    ["Clothing and footwear, protective and safety equipment", "Protective boots and helmets for industrial use"],
    ["Health, education, welfare and charities", "Equipment for blind or partially sighted people"],
    ["Health, education, welfare and charities", "Low vision aids"],
    ["Health, education, welfare and charities", "Building services for disabled people"],
    ["Health, education, welfare and charities", "Charity shops — selling donated goods"],
    ["Health, education, welfare and charities", "Dispensing of prescriptions by a registered pharmacist"],
    ["Health, education, welfare and charities", "Construction and sale of new buildings for a relevant charitable purpose"],
    ["Power, utilities, energy and energy saving, heating", "Solar panels"],
    ["Power, utilities, energy and energy saving, heating", "Gas-fired boilers"],
    ["Transport, freight, travel and vehicles", "Freight containers — sale, lease or hire to a place outside the UK and the EU"],
    ["Transport, freight, travel and vehicles", "International freight transport that takes place in the UK and its territorial waters"],
    ["Transport, freight, travel and vehicles", "Ship repairs and maintenance"],
    ["Building and construction, land and property", "Renovating a dwelling that has been empty for at least 2 years"],
  ];
  for (const [section, item] of probed) {
    assert.ok(UK_VAT_PRODUCT_RATES.some((row) => row.section === section && row.item === item), `${item} is a row of the page`);
    assert.equal(ukProductRateBps(section, item, day), null, item);
  }
  // The words alone catch the rows that say who buys, who sells or the use in the item, whatever their note.
  for (const item of ["Equipment for disabled people", "Mobility aids for the elderly", "Advertising services for charities", "Protective boots and helmets for industrial use", "Charity shops — selling donated goods", "Dispensing of prescriptions by a registered pharmacist", "Freight containers — sale, lease or hire to a place outside the UK and the EU"]) {
    assert.ok(RELIEF_NOT_BY_PRODUCT_WORDS.test(item), item);
  }
  // ... and leave every row that depends only on the product.
  for (const item of ["Books", "Children’s clothes and footwear", "Cycle helmets — CE marked", "Motorcycle helmets that meet safety standards", "Passenger transport in a vehicle, boat or aircraft that carries not less than 10 passengers", "Sanitary protection products"]) {
    assert.equal(RELIEF_NOT_BY_PRODUCT_WORDS.test(item), false, item);
  }
  // Every note and item the module refuses this way is one the page has, so the list never goes stale unseen.
  for (const note of Object.keys(RELIEF_NOT_BY_PRODUCT_NOTES)) assert.ok(UK_VAT_PRODUCT_RATES.some((row) => row.more.trim() === note), `note ${note} is on the page`);
  for (const item of Object.keys(RELIEF_NOT_BY_PRODUCT_ITEMS)) assert.ok(UK_VAT_PRODUCT_RATES.some((row) => row.item === item), `item ${item} is on the page`);
  // A rate that depends only on the product stays as the page writes it.
  assert.equal(ukProductRateBps(PRINT, "Books", day), 0);
  assert.equal(ukProductRateBps("Clothing and footwear, protective and safety equipment", "Children’s clothes and footwear", day), 0);
  assert.equal(ukProductRateBps("Clothing and footwear, protective and safety equipment", "Cycle helmets — CE marked", day), 0);
  // Every row that still gives a rate, read one by one: each depends only on what the product is.
  const rated = UK_VAT_PRODUCT_RATES.filter((row) => ukProductRateBps(row.section, row.item, day) !== null).map((row) => row.item);
  assert.deepEqual(rated, [
    "Smoking cessation products — nicotine patches and gum",
    "Maternity pads",
    "Sanitary protection products",
    "Passenger transport in a vehicle, boat or aircraft that carries not less than 10 passengers",
    "Brochures",
    "Leaflets",
    "Pamphlets",
    "Other postal services that are not subject to a universal service obligation",
    "Books",
    "Children’s painting and picture books",
    "Maps and charts",
    "Magazines",
    "Newspapers",
    "Printed or copied music",
    "Babywear",
    "Children’s clothes and footwear",
    "Carrycots with restraint straps",
    "Children’s car seats, booster seats and booster cushions",
    "Cycle helmets — CE marked",
    "Motorcycle helmets that meet safety standards",
  ]);
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
