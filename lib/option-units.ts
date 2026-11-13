/**
 * What one unit costs within each price option, when the options' own names
 * say how many (added 9 October 2026): "1 week" at $27 and "5 weeks" at $39
 * read "$7.80 per week · save 71%" under the second. A buyer weighing a
 * bigger option sees what it is worth without doing the sum — and the sum
 * is ours, from the creator's real prices, never typed.
 *
 * Read from the names only when they leave no doubt: every option's name is
 * a whole number and the same word ("1 week", "5 weeks"; "1 semana", "4
 * semanas"), one of them is a single one (which gives the word to say "per"),
 * and the counts differ. Anything else — "Personal" and "Commercial", "3
 * calls" beside "1 course" — shows nothing more. A saving under five percent
 * is not worth a line. Browser-safe.
 */

export type UnitLine = { perUnitCents: number; unit: string; savePercent: number };

const NAME = /^\s*(\d{1,4})\s+([\p{L}][\p{L}'’-]*(?:\s[\p{L}][\p{L}'’-]*){0,2})\s*$/u;

/** The word without what usually makes it plural, so "weeks" and "week" are one word. */
function stem(word: string): string {
  return word.toLowerCase().replace(/(es|en|s|n|e)$/u, "");
}

/** The line under each option that has more than one, by option id; empty when the names do not say. */
export function unitLines(options: { id: string; label: string; priceCents: number }[]): Map<string, UnitLine> {
  const out = new Map<string, UnitLine>();
  if (options.length < 2) return out;
  const read = options.map((option) => {
    const match = option.label.match(NAME);
    return match ? { option, count: Number(match[1]), word: match[2] } : null;
  });
  if (read.some((r) => r === null || r.count < 1)) return out;
  const rows = read as { option: { id: string; priceCents: number }; count: number; word: string }[];
  if (new Set(rows.map((r) => stem(r.word))).size !== 1) return out;
  if (new Set(rows.map((r) => r.count)).size !== rows.length) return out;
  const single = rows.find((r) => r.count === 1);
  if (!single || single.option.priceCents <= 0) return out;
  for (const row of rows) {
    if (row.count === 1) continue;
    const perUnitCents = Math.round(row.option.priceCents / row.count);
    // In whole cents, so exactly 10% less says 10, never 9 from a floating-point remainder.
    const asSingles = single.option.priceCents * row.count;
    const saved = Math.floor(((asSingles - row.option.priceCents) * 100) / asSingles);
    out.set(row.option.id, { perUnitCents, unit: single.word, savePercent: saved >= 5 ? saved : 0 });
  }
  return out;
}
