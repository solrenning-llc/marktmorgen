/** Independent numeric-domain oracle for the comparison review clock. */
import { overdue, type DatedFact } from "@/lib/competitor-review";
import { done, is } from "./check";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 5), MAX_DATE = 8_640_000_000_000_000;
const readings: { fact: DatedFact; at: number | null }[] = [
  { fact: { where: "future", readOn: "2026-11-06" }, at: NOW + DAY },
  { fact: { where: "today", readOn: "2026-11-05" }, at: NOW },
  { fact: { where: "ninety days", readOn: "2026-08-07" }, at: Date.UTC(2026, 7, 7) },
  { fact: { where: "epoch", readOn: "1970-01-01" }, at: 0 },
  { fact: { where: "invalid calendar", readOn: "2026-02-30" }, at: null },
];
const facts = readings.map(row => Object.freeze(row.fact));
const snapshot = JSON.stringify(facts);
for (const now of [NOW, NOW + 1, NOW - 1, 0, -1, MAX_DATE, -MAX_DATE, MAX_DATE + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity]) {
  for (const days of [0, 1, 90, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Math.floor(Number.MAX_SAFE_INTEGER / DAY)]) {
    const clockKnown = Number.isFinite(now) && Math.abs(now) <= MAX_DATE;
    const windowKnown = Number.isSafeInteger(days) && days >= 0 && days <= Math.floor(Number.MAX_SAFE_INTEGER / DAY);
    const expected = readings.filter(row => !clockKnown || !windowKnown || row.at === null || (now - row.at) / DAY < 0 || (now - row.at) / DAY > days)
      .map(row => row.fact).sort((a, b) => a.readOn.localeCompare(b.readOn));
    const got = overdue(facts, now, days);
    is("the numeric clock/window matrix agrees with elapsed-day evidence", got, expected);
  }
}
is("the oracle leaves source facts and their order intact", JSON.stringify(facts), snapshot);
done();
