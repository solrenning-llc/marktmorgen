/**
 * PROPOSED / NOT EXECUTED: independent pure-math cases for #2941 fd4cd750.
 * Runtime stopped before model evaluation. These are hypotheses, not findings.
 * Copy the published files unchanged before any future execution.
 */
import assert from "node:assert/strict";
import {
  earningsByMonth, earningsMonths, monthFloor,
  type EarningsInput, type ListReading, type MoneyEvent, type MoneyKind, type ProviderReading,
} from "@/lib/earnings-by-month";

const AT = Date.UTC(2026, 10, 6, 12), FLOOR = monthFloor("2025-12"), MONTH = "2026-11";
let checks = 0, failures = 0;
function check(label: string, work: () => void): void {
  checks++;
  try { work(); console.log("PASS " + label); }
  catch (error) { failures++; console.log("FAIL " + label + ": " + String(error)); }
}
const event = (id: string, cents: number, at = AT - 1, currency = "usd"): MoneyEvent => ({ id, cents, at, currency });
const list = (kind: MoneyKind, events: MoneyEvent[], over: Partial<ListReading> = {}): ListReading =>
  ({ kind, events, since: FLOOR, complete: true, reachedBack: null, ...over }) as ListReading;
const stripe = (lists: ListReading[]): ProviderReading => ({ source: "stripe", lists });
const input = (over: Partial<EarningsInput> = {}): EarningsInput =>
  ({ at: AT, timeZone: "UTC", providers: [], manual: [], ...over });
const month = (over: Partial<EarningsInput>) => earningsByMonth(input(over))!.months.find(row => row.month === MONTH)!;
const source = (over: Partial<EarningsInput>) => month(over).sources[0];

check("complete empty source is a confirmed zero", () =>
  assert.deepEqual(month({ providers: [stripe([list("sale", [])])] }).totals, []));
check("unread source is not zero", () =>
  assert.equal(month({ providers: [stripe([{ kind: "sale", unread: true }])] }).totals, null));
check("unread manual entries suppress totals", () => assert.equal(month({ manual: null }).totals, null));
check("currencies remain apart", () =>
  assert.deepEqual(month({ providers: [stripe([list("sale", [event("usd", 200), event("eur", 300, AT - 1, "EUR")])])] })
    .totals?.map(row => [row.currency, row.netCents]), [["eur", 300], ["usd", 200]]));
check("duplicate id within one source is unknown", () =>
  assert.equal(source({ providers: [stripe([list("sale", [event("same", 200), event("same", 200)])])] }).state, "unknown"));
check("fractional cents fail closed", () =>
  assert.equal(source({ providers: [stripe([list("sale", [event("fraction", 1.5)])])] }).state, "unknown"));
check("unsafe cents fail closed", () =>
  assert.equal(source({ providers: [stripe([list("sale", [event("unsafe", Number.MAX_SAFE_INTEGER + 1)])])] }).state, "unknown"));
check("invalid currency fails closed", () =>
  assert.equal(source({ providers: [stripe([list("sale", [event("currency", 100, AT - 1, "US")])])] }).state, "unknown"));
check("unknown zone gives no result", () =>
  assert.equal(earningsByMonth(input({ timeZone: "Mars/Olympus" })), null));
check("NaN reading time gives no result", () =>
  assert.equal(earningsByMonth(input({ at: Number.NaN })), null));
check("finite out-of-Date-range reading time gives no result rather than throwing", () =>
  assert.equal(earningsByMonth(input({ at: Number.MAX_SAFE_INTEGER })), null));
check("finite out-of-Date-range event makes its source unknown", () =>
  assert.equal(source({ providers: [stripe([list("sale", [event("bad-date", 100, Number.MAX_SAFE_INTEGER)])])] }).state, "unknown"));
check("Tokyo changes month before UTC", () =>
  assert.equal(earningsMonths(Date.UTC(2026, 9, 31, 16), "Asia/Tokyo", 1)[0], "2026-11"));
check("New York is October at UTC November midnight", () =>
  assert.equal(earningsMonths(Date.UTC(2026, 10, 1, 1), "America/New_York", 1)[0], "2026-10"));
check("Kiritimati UTC+14 boundary is included", () =>
  assert.equal(earningsMonths(Date.UTC(2026, 9, 31, 10), "Pacific/Kiritimati", 1)[0], "2026-11"));
check("reached exactly at a month floor is not complete", () =>
  assert.equal(source({ providers: [stripe([list("sale", [], { complete: false, reachedBack: monthFloor(MONTH) })])] }).state, "unknown"));
check("strictly before the floor is complete", () =>
  assert.equal(source({ providers: [stripe([list("sale", [], { complete: false, reachedBack: monthFloor(MONTH) - 1 })])] }).state, "read"));
const max = Number.MAX_SAFE_INTEGER, exact = BigInt(max) + BigInt(2) - BigInt(2);
check("cross-field intermediate overflow is exact or explicitly unknown", () => {
  const row = source({ providers: [stripe([list("sale", [event("s", max)]), list("renewal", [event("n", 2)]), list("refund", [event("r", 2)])])] });
  console.log("PROPOSED_SOURCE_OVERFLOW_OBSERVATION", JSON.stringify(row));
  assert.ok(row.state === "unknown" || row.lines.every(line => BigInt(line.netCents) === exact));
});
check("cross-source total overflow is exact or explicitly unknown", () => {
  const row = month({ providers: [stripe([list("sale", [event("s", max)]), list("refund", [event("r", 2)])])],
    manual: [{ id: "m", date: "2026-11-05", cents: 2, currency: "usd" }] });
  console.log("PROPOSED_TOTAL_OVERFLOW_OBSERVATION", JSON.stringify(row.totals));
  assert.ok(row.totals === null || row.totals.every(line => BigInt(line.netCents) === exact));
});
check("same Stripe event repeated in two source wrappers is not counted twice", () => {
  const row = month({ providers: [stripe([list("sale", [event("same", 200)])]), stripe([list("sale", [event("same", 200)])])] });
  console.log("PROPOSED_DUPLICATE_WRAPPER_OBSERVATION", JSON.stringify(row));
  assert.ok(row.totals === null || row.totals.every(line => line.netCents === 200));
});
check("event after reading instant is not current-month money so far", () =>
  assert.equal(source({ providers: [stripe([list("sale", [event("after", 200, AT + 1)])])] }).state, "unknown"));
check("future manual day is not current-month money so far", () =>
  assert.equal(month({ manual: [{ id: "future", date: "2026-11-07", cents: 200, currency: "usd" }] })
    .sources.find(row => row.source === "manual")!.state, "unknown"));
console.log("J2941 " + checks + " checks, " + failures + " failures.");
if (failures) process.exitCode = 1;
