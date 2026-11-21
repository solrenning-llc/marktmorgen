/**
 * 793 [IV3] unit 4: the UK VAT rate of each kind of goods or services, read from HMRC's public guidance "VAT rates on
 * different goods and services" under the owner's authorization (OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 1:
 * the public page only, no account, no API key, no terms).
 *
 *   - The page was read through GOV.UK's public content API on 21/11/2026 and is kept byte for byte at
 *     `UK_VAT_RATES_FILE.path`, with its SHA-256; its last update is 10 July 2026. `tests/uk-vat-product-rates.test.ts`
 *     checks the file against the SHA-256 and every row below against the file's own tables.
 *   - Each row is exactly as the page writes it (the page's section, the goods or services, the rate and the notice),
 *     kept in `docs/gov-uk-vat-rates/vat-rates-rows.json`.
 *   - `ukProductRateBps` gives a rate only for a row written "0%", "5%" or "Standard-rated" (the standard rate is
 *     `UK_VAT_RATE` in lib/uk-vat.ts, read on gov.uk/vat-rates). Anything else is refused, never 0%: "Exempt", a rate
 *     with a condition ("0% or 5%", "Exempt if ..."), "Outside the scope of VAT" and "The same rate as the goods ...",
 *     whose condition this table does not hold; a row the table does not have; two rows that disagree; and any day
 *     past `UK_VAT_PRODUCT_RATES_VALID_UNTIL`, before which the page is read again at the source, with the date.
 *
 * Pure. Nothing calls it yet: which row a store's product falls under is the next step, and collecting UK VAT stays off
 * (UK_VAT_COLLECT_REVIEWED, lib/vat-registrations.ts).
 */
import rows from "@/docs/gov-uk-vat-rates/vat-rates-rows.json";
import { UK_VAT_RATE } from "@/lib/uk-vat";

export const UK_VAT_RATES_FILE = {
  path: "docs/gov-uk-vat-rates/vat-rates-on-different-goods-and-services.json",
  source: "https://www.gov.uk/api/content/guidance/vat-rates-on-different-goods-and-services",
  page: "https://www.gov.uk/guidance/vat-rates-on-different-goods-and-services",
  readOn: "2026-11-21",
  pageUpdatedOn: "2026-07-10",
  sha256: "00778c28b854cd47f63c3feac8bee3aa1c7d80ce0bf051791960b8ee2e18ee23",
} as const;

/** The page is read again at the source before this day; past it no row gives a rate. */
export const UK_VAT_PRODUCT_RATES_VALID_UNTIL = "2026-12-31";

export type UkProductRateRow = { section: string; item: string; rate: string; more: string };

/**
 * The page's rows, kept as data in `docs/gov-uk-vat-rates/vat-rates-rows.json`, never retyped: the page's own British
 * wording ("licence") is quoted source text, not Marktmorgen's prose, and the test re-reads every row from the page.
 */
export const UK_VAT_PRODUCT_RATES: readonly UkProductRateRow[] = rows as UkProductRateRow[];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};

function basisPointsOf(rate: string): number | null {
  if (rate === "0%") return 0;
  if (rate === "5%") return 500;
  if (rate === "Standard-rated") return UK_VAT_RATE.basisPoints;
  return null;
}

/**
 * The UK VAT rate, in basis points, of the goods or services the page writes as `item` under `section`, on `day`
 * (YYYY-MM-DD); null when the table cannot give one: unknown is refused, never 0%.
 */
export function ukProductRateBps(section: string, item: string, day: string, table: readonly UkProductRateRow[] = UK_VAT_PRODUCT_RATES): number | null {
  if (!realDay(day) || day > UK_VAT_PRODUCT_RATES_VALID_UNTIL || day < UK_VAT_RATES_FILE.readOn) return null;
  if (typeof section !== "string" || typeof item !== "string" || !Array.isArray(table)) return null;
  const rows = table.filter((row) => row && row.section === section && row.item === item);
  if (rows.length === 0) return null;
  const rates = new Set(rows.map((row) => basisPointsOf(row.rate)));
  if (rates.size !== 1) return null;
  const [rate] = rates;
  return rate ?? null;
}
