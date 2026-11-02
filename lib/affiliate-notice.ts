/**
 * Notice to affiliates before their terms get worse (630 [HN6](2), unit 1;
 * owner's Hotmart audit): when a creator lowers the commission (the store's
 * share, or a product's) or shortens the window after a click, the creator
 * may choose to give their affiliates 3 to 90 days' notice. Until that day the
 * old terms hold; from it, the new ones. What gets better for affiliates
 * applies at once: nobody needs warning of a raise.
 *
 * Pure and browser-safe; nothing reads it yet. Unit 2 keeps the result in the
 * store's affiliate setting (no new record), reads the terms in force at the
 * moment of each sale (the rate is already stamped on the sale at checkout,
 * lib/affiliates.ts), and shows the date in the studio and on the affiliates'
 * page; unit 3 tells each affiliate by email (412 [AM7]).
 *
 * In this unit: the store's share, each product's share (0 takes a product
 * out, which is the deepest cut) and the window. Not yet: one affiliate's own
 * rate, the second tier, recurring months, bonuses and pay per lead. Switching
 * the whole program off stays immediate: the item covers lowering terms, not
 * ending the program, and an ended program pays what it already owes.
 */

/** The shortest and longest notice a creator may give, in days; 0 is none. */
export const MIN_NOTICE_DAYS = 3;
export const MAX_NOTICE_DAYS = 90;

/** The terms a notice protects. `rates` is per product id, as in lib/affiliate-setting.ts. */
export type NoticeTerms = { percent: number; rates: Record<string, number>; days: number };

/** Terms that take effect later: in full, from `from` (seconds). */
export type PendingTerms = NoticeTerms & { from: number };

/** A notice as kept: none, or 3 to 90 days. Anything else is none. */
export function readNoticeDays(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_NOTICE_DAYS && n <= MAX_NOTICE_DAYS ? n : 0;
}

/** What a product earns under these terms (a product not listed earns the store's share). */
function rateOf(terms: NoticeTerms, productId: string): number {
  const own = terms.rates[productId];
  return typeof own === "number" ? own : terms.percent;
}

/** Whether `next` is worse for an affiliate than `now` anywhere: the share, any product's share, or the window. */
export function lowers(now: NoticeTerms, next: NoticeTerms): boolean {
  if (next.percent < now.percent || next.days < now.days) return true;
  const products = new Set([...Object.keys(now.rates), ...Object.keys(next.rates)]);
  for (const id of products) if (rateOf(next, id) < rateOf(now, id)) return true;
  return false;
}

/**
 * The terms in force today after a creator saves `next` over `now`, and what
 * waits, if anything. Each term that gets better applies at once; each that
 * gets worse keeps its old value until the day, when the whole of `next`
 * takes over. `running` is a notice already under way: saving the very terms
 * it announced keeps its day; saving others replaces it, and never on an
 * earlier day than it had announced, even with no notice now.
 *
 * `noticeDays` 0, with nothing running, applies everything at once, as before
 * notice existed.
 */
export function planTerms(
  now: NoticeTerms,
  next: NoticeTerms,
  noticeDays: number,
  nowSeconds: number,
  running: PendingTerms | null = null,
): { current: NoticeTerms; pending: PendingTerms | null } {
  if (running && sameTerms(next, running)) return { current: copy(now), pending: { ...copy(running), from: running.from } };
  const notice = readNoticeDays(noticeDays);
  if (!lowers(now, next) || (!notice && !running)) return { current: copy(next), pending: null };
  const percent = Math.max(now.percent, next.percent);
  const days = Math.max(now.days, next.days);
  // Every product whose share would differ from the new store share is written out, so none moves with it unasked.
  const rates: Record<string, number> = {};
  const products = new Set([...Object.keys(now.rates), ...Object.keys(next.rates)]);
  for (const id of products) {
    const keep = Math.max(rateOf(now, id), rateOf(next, id));
    if (keep !== percent || id in next.rates) rates[id] = keep;
  }
  const from = Math.max(nowSeconds + notice * 86_400, running?.from ?? 0);
  return { current: { percent, rates, days }, pending: { ...copy(next), from } };
}

/** Whether two sets of terms say the same, whatever order the products are in. */
export function sameTerms(a: NoticeTerms, b: NoticeTerms): boolean {
  if (a.percent !== b.percent || a.days !== b.days) return false;
  const ids = new Set([...Object.keys(a.rates), ...Object.keys(b.rates)]);
  for (const id of ids) if (a.rates[id] !== b.rates[id]) return false;
  return true;
}

/** The terms in force at a moment (seconds): the pending ones from their day on. */
export function termsAt(current: NoticeTerms, pending: PendingTerms | null, atSeconds: number): NoticeTerms {
  return pending && atSeconds >= pending.from ? copy(pending) : copy(current);
}

/** A pending change as kept, or null when it does not read whole. */
export function readPending(raw: unknown, bounds: { minPercent: number; maxPercent: number; minDays: number; maxDays: number }): PendingTerms | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const whole = (n: unknown, min: number, max: number) => (typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null);
  const percent = whole(value.percent, bounds.minPercent, bounds.maxPercent);
  const days = whole(value.days, bounds.minDays, bounds.maxDays);
  const from = whole(value.from, 1, 4_102_444_800);
  if (percent === null || days === null || from === null) return null;
  const rates: Record<string, number> = {};
  if (value.rates && typeof value.rates === "object" && !Array.isArray(value.rates)) {
    for (const [id, rate] of Object.entries(value.rates as Record<string, unknown>).slice(0, 200)) {
      const n = whole(rate, 0, bounds.maxPercent);
      if (/^[a-z0-9]{6,40}$/.test(id) && n !== null) rates[id] = n;
    }
  }
  return { percent, rates, days, from };
}

/** What changes on the day, in words for the creator and the affiliates: only what gets worse. */
export function noticeLines(current: NoticeTerms, pending: PendingTerms, productName: (id: string) => string | null): string[] {
  const lines: string[] = [];
  if (pending.percent < current.percent) lines.push(`Commission: ${current.percent}% becomes ${pending.percent}%.`);
  if (pending.days < current.days) lines.push(`Days a click counts: ${current.days} becomes ${pending.days}.`);
  const products = new Set([...Object.keys(current.rates), ...Object.keys(pending.rates)]);
  for (const id of [...products].sort()) {
    const before = rateOf(current, id);
    const after = rateOf(pending, id);
    const name = productName(id);
    // A product only a store-wide change touches is said once, above.
    if (after < before && name && (id in current.rates || id in pending.rates) && !(before === current.percent && after === pending.percent)) {
      lines.push(after === 0 ? `${name}: leaves the program (was ${before}%).` : `${name}: ${before}% becomes ${after}%.`);
    }
  }
  return lines;
}

function copy(terms: NoticeTerms): NoticeTerms {
  return { percent: terms.percent, rates: { ...terms.rates }, days: terms.days };
}
