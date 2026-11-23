/**
 * What "What buyers say" on the store page keeps (lib/store-quotes.ts), and
 * how a kept list is read. Import-free, so the store's record and the page
 * can both use it.
 */

export const MAX_STORE_QUOTES = 3;
/** Long enough for a sentence or two; the whole review is on its product's page. */
export const QUOTE_CHARS = 280;

/** p: the product, ti: its title then, r: the stars, t: the words, n: the buyer's chosen name, at: when. */
export type StoreQuote = { p: string; ti: string; r: number; t: string; n: string; at: number };

/** A kept list, made safe. Browser-safe. */
export function parseQuotes(raw: unknown): StoreQuote[] {
  if (!Array.isArray(raw)) return [];
  const out: StoreQuote[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const v = entry as Record<string, unknown>;
    if (typeof v.p !== "string" || typeof v.t !== "string" || !v.t) continue;
    const r = typeof v.r === "number" && Number.isInteger(v.r) && v.r >= 1 && v.r <= 5 ? v.r : 0;
    if (!r) continue;
    out.push({ p: v.p.slice(0, 40), ti: typeof v.ti === "string" ? v.ti.slice(0, 200) : "", r, t: v.t.slice(0, QUOTE_CHARS + 1), n: typeof v.n === "string" ? v.n.slice(0, 40) : "", at: typeof v.at === "number" ? v.at : 0 });
    if (out.length >= MAX_STORE_QUOTES) break;
  }
  return out;
}

/** A review's words, cut at a word near the limit when long. */
export function quoteText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= QUOTE_CHARS) return flat;
  const cut = flat.slice(0, QUOTE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > QUOTE_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The least time between two refreshes of a store's quotes after review writes (refreshStoreQuotesHourly). */
export const QUOTES_REFRESH_SECONDS = 3_600;
