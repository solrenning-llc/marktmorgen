/**
 * The routine that says when a competitor fact is due for review (238 [CF1]):
 * every price, fee and capability quoted about another platform carries the
 * day it was read on that platform's own page, and none may go more than
 * REVIEW_DAYS without being read again. A fact past that is not shown as if
 * it were current; tests/competitor-review.test.ts fails on it, and the daily
 * run of the checks makes that failure appear by itself, so nobody has to
 * remember to look.
 *
 * Two kinds of dated fact are found:
 *   - the official sources of lib/competitor-prices.ts, each with `readOn`;
 *   - the dates written into public sentences: "read September 30, 2026",
 *     "read on October 20, 2026", "checked again on ...".
 *
 * Pure: it reads only what it is given.
 */

/** The most days a competitor fact may go without being read again on its own page. */
export const REVIEW_DAYS = 90;

export type DatedFact = { where: string; readOn: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WRITTEN = new RegExp(`\\b(?:read|checked)(?: again)?(?: on)? (${MONTHS.join("|")}) (\\d{1,2}), (20\\d{2})`, "gi");

/** Every `readOn` in a value, however deep, with the path that leads to it. */
export function datedSources(value: unknown, where = ""): DatedFact[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => datedSources(item, `${where}[${i}]`));
  const record = value as Record<string, unknown>;
  const own = typeof record.readOn === "string" ? [{ where: `${where}${typeof record.url === "string" ? ` (${record.url})` : ""}`, readOn: record.readOn }] : [];
  return [...own, ...Object.entries(record).filter(([key]) => key !== "readOn").flatMap(([key, item]) => datedSources(item, where ? `${where}.${key}` : key))];
}

/** Every date written as "read <Month> <day>, <year>" in a text, as YYYY-MM-DD. */
export function writtenDates(text: string, where: string): DatedFact[] {
  return [...text.matchAll(WRITTEN)].map((match) => {
    const month = MONTHS.findIndex((name) => name.toLowerCase() === match[1].toLowerCase()) + 1;
    return { where, readOn: `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}` };
  });
}

/** The facts read more than `days` ago, or with a date that is not a real day, oldest first. */
export function overdue(facts: DatedFact[], now = Date.now(), days = REVIEW_DAYS): DatedFact[] {
  const limit = now - days * 86_400_000;
  return facts
    .filter((fact) => {
      const at = Date.parse(`${fact.readOn}T00:00:00Z`);
      return !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== fact.readOn || at < limit;
    })
    .sort((a, b) => a.readOn.localeCompare(b.readOn));
}

/** The day each fact falls due, the soonest first: what to read again next. */
export function dueNext(facts: DatedFact[], days = REVIEW_DAYS): { readOn: string; due: string; count: number }[] {
  const by = new Map<string, number>();
  for (const fact of facts) by.set(fact.readOn, (by.get(fact.readOn) ?? 0) + 1);
  return [...by]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([readOn, count]) => ({ readOn, due: new Date(Date.parse(`${readOn}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10), count }));
}
