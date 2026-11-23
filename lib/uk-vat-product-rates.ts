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
 *     whose condition this table does not hold; a row whose own note says some of its items are at another rate
 *     ("Some items are ...", "But ...") or whose note names another rate at all; a row that covers only "certain"
 *     goods it does not name; a row whose relief depends on who buys, who sells or the use, not on the product
 *     (RELIEF_NOT_BY_PRODUCT_WORDS in the item, RELIEF_NOT_BY_PRODUCT_NOTES by its notice, _ITEMS); a row the table does not have; two rows that disagree; and any day
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

/**
 * A note that says some of the row's own goods or services are at another rate ("Some items are standard-rated such as
 * exercise books ...", "But holiday accommodation let in a moored houseboat is standard-rated"): which item is which is
 * not in this table, so the row gives no rate. A note about other goods than the row's (industrial water, gliders) does
 * not start this way and leaves the row's rate as the page writes it (Claude 6 hsz3 on #5045, 7094213497).
 */
const PART_AT_ANOTHER_RATE = /^(?:some items\b|but\b)/i;

/**
 * A note that names another rate at all ("... is standard-rated", "exempt", "0%"): whether the goods it names are part
 * of the row's own (the sewerage row's "Sewer and drain cleaning ... is standard-rated") is a reading of meaning, not of
 * form, so the row gives no rate until a person reads it with the product it is linked to (Claude 1's NIT on #5045,
 * 7094619715). Refused, never 0%.
 */
const NAMES_ANOTHER_RATE = /standard-rated|zero-rated|reduced-rated|\bexempt\b|\b\d+%/i;

/**
 * A row that covers only "certain" goods ("Certain goods sold at charitable fundraising events", "... and certain low
 * vision aids"): which ones is not in this table, so the row gives no rate (Claude 2 lpgvy on #5045).
 */
const ONLY_CERTAIN_ITEMS = /\bcertain\b/i;

/**
 * The rows whose relief is a fact about who buys, who sells or what the goods or services are used for, never about the
 * product alone (Claude 6 UoHAG, coordinator re-audit of #5045): a product mapped once to such a row would be sold at
 * the reduced rate to every buyer, and Solrenning LLC would owe the standard rate it never collected. The next step maps
 * products, not sales, so it cannot hold the condition either: these rows give no rate. Keyed by the page's own note,
 * which names the HMRC notice that sets the condition, each with the reason; every key is a note the table has.
 */
export const RELIEF_NOT_BY_PRODUCT_NOTES: Readonly<Record<string, string>> = {
  "Charitable donations and VAT": "the seller: a charity selling donated goods",
  "Equipment for blind or partially sighted people": "the buyer: supplied to a blind or partially sighted person or a charity",
  "Equipment for disabled people": "the buyer: supplied to a disabled person or a charity for their use",
  "Mobility aids for older people": "the buyer: installed in the home of a person aged 60 or over",
  "Notice 701/7 VAT reliefs for disabled people": "the buyer: a disabled person, in their own home",
  "Building services for disabled people": "the buyer: a disabled person, in their own home",
  "VAT Notice 701/7": "the buyer: supplied to a disabled person or a charity",
  "VAT Notice 701/57": "the seller and the buyer: a registered pharmacist dispensing a prescription",
  "VAT Notice 701/58": "the buyer: a charity",
  "VAT Notice 703/1": "the place: goods sent outside the UK and the EU",
  "VAT Notice 708": "the building and its use: a dwelling, a relevant residential or charitable purpose, a first sale",
  "VAT Notice 708/6": "the place and the buyer: installed in residential or charitable buildings, or grant-funded for a qualifying person",
  "VAT Notice 744B": "the route: freight to or from a place outside the UK",
  "VAT Notice 744C": "the use: a qualifying ship or aircraft",
};

/**
 * The same rule read in the row's own words, so a row the page adds later is caught before anyone reviews its note: an
 * item that names who buys or who sells ("for disabled people", "for the elderly", "for charities", "by a registered
 * pharmacist", "Charity shops") or a use or a place ("for industrial use", "for a relevant charitable purpose", "to a
 * place outside the UK", "a dwelling", "used as"). Some rows say none of it in the item (Incontinence products, Low
 * vision aids, the energy-saving rows): their note names the notice that sets the condition, read just above.
 */
export const RELIEF_NOT_BY_PRODUCT_WORDS =
  /\bfor (?:disabled|blind|partially sighted|the elderly|older|charit|industrial use|a relevant|relevant)|\bcharit(?:y|ies|able)\b|\bby a registered\b|\boutside the UK\b|\bdwellings?\b|\bresidential\b|\bused as\b|\bin their own home\b/i;

/** The same, for a row whose note it shares with rows that depend on the product alone (VAT Notice 701/23). */
export const RELIEF_NOT_BY_PRODUCT_ITEMS: Readonly<Record<string, string>> = {
  "Protective boots and helmets for industrial use": "the buyer: not supplied to an employer for its employees",
};

function basisPointsOf(rate: string, more: string, item: string): number | null {
  if (typeof more !== "string" || PART_AT_ANOTHER_RATE.test(more.trim()) || NAMES_ANOTHER_RATE.test(more)) return null;
  if (typeof item !== "string" || ONLY_CERTAIN_ITEMS.test(item)) return null;
  if (RELIEF_NOT_BY_PRODUCT_WORDS.test(item) || Object.hasOwn(RELIEF_NOT_BY_PRODUCT_NOTES, more.trim()) || Object.hasOwn(RELIEF_NOT_BY_PRODUCT_ITEMS, item)) return null;
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
  const rates = new Set(rows.map((row) => basisPointsOf(row.rate, row.more, row.item)));
  if (rates.size !== 1) return null;
  const [rate] = rates;
  return rate ?? null;
}
