/**
 * The one-time filling of the sales file's short copies (scripts/sales-file-fill.mjs;
 * Claude 4's option D, 7 November 2026): every PayPal sale's line
 * (lib/paypal-sale-summary.ts, fillSaleSummaries) and every product's names
 * (lib/catalog.ts, fillProductNames), for what was paid or saved before they
 * were written with it. A step reads one SCAN page of stores and fills them; it
 * only counts unless `write`. Safe to run again.
 *
 * Until a run counts no sale and no product without its copy, and no store or
 * record it could not read, the sales file still reads those whole, so its
 * honest price stays at the whole records' (tests/plan-cost-registry.ts, the
 * "studio" line). The step also counts the commands and bytes it moved, for its
 * cost (spendOf).
 */
import { type Store, storeForEmail, storeRef } from "@/lib/store";
import { fillSaleSummaries } from "@/lib/paypal-sale-summary";
import { fillProductNames } from "@/lib/catalog";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS } from "@/lib/spend-cost-table";

export type FillStep = {
  stores: number;
  unreadableStores: number;
  failedStores: number;
  sales: number;
  salesWithout: number;
  salesWritten: number;
  salesUnreadable: number;
  products: number;
  productsWithout: number;
  productsWritten: number;
  commands: number;
  bytes: number;
  next: string;
};

/** Store records one step reads: one SCAN page. */
export const FILL_STORES_PER_STEP = 200;

export const emptyFill = (): FillStep => ({
  stores: 0, unreadableStores: 0, failedStores: 0, sales: 0, salesWithout: 0, salesWritten: 0, salesUnreadable: 0,
  products: 0, productsWithout: 0, productsWritten: 0, commands: 0, bytes: 0, next: "0",
});

/**
 * One step from `cursor` ("0" to begin; "0" comes back once every store was
 * read): the stores of one SCAN page, read exactly, each filled. A store whose
 * record does not read, or whose filling fails, is counted, never taken as
 * having nothing to fill.
 */
export async function fillSalesFileStep(cursor: string, write: boolean): Promise<FillStep> {
  const out = emptyFill();
  if (!isRedisConfigured()) return out;
  const [page] = repliesFor(await redisPipeline([["SCAN", cursor, "MATCH", "nl:store:owner:*", "COUNT", FILL_STORES_PER_STEP]]), 1) ?? [undefined];
  const scanned = repliesFor(page, 2);
  const keys = scanned ? stringList(scanned[1]) : null;
  if (!scanned || typeof scanned[0] !== "string" || !/^\d+$/.test(scanned[0]) || !keys) throw new UnknownReplyError("a page of stores");
  out.next = scanned[0];
  out.commands += 1;
  if (!keys.length) return out;
  const [values] = repliesFor(await redisPipeline([["MGET", ...keys]]), 1) ?? [undefined];
  const raws = repliesFor(values, keys.length);
  if (!raws || raws.some((raw) => raw !== null && typeof raw !== "string")) throw new UnknownReplyError("a page of store records");
  out.commands += 1;
  for (const raw of raws as (string | null)[]) {
    if (raw === null) continue;
    out.bytes += new TextEncoder().encode(raw).length;
    const store = await storeOf(raw);
    out.commands += 1;
    if (!store) {
      out.unreadableStores += 1;
      continue;
    }
    out.stores += 1;
    try {
      if (store.statsId) {
        const lines = await fillSaleSummaries(store.statsId, write);
        out.sales += lines.sales;
        out.salesWithout += lines.without;
        out.salesWritten += lines.written;
        out.salesUnreadable += lines.unreadable;
        out.commands += lines.commands;
        out.bytes += lines.bytes;
      }
      const names = await fillProductNames(store, write);
      out.products += names.products;
      out.productsWithout += names.without;
      out.productsWritten += names.written;
      out.commands += names.commands;
      out.bytes += names.bytes;
    } catch (error) {
      out.failedStores += 1;
      console.error("filling a store's sales file copies failed", error);
    }
  }
  return out;
}

/**
 * The store a record found by the walk is, read again by its own address the
 * way every page reads it (storeForEmail, storeRef), so the walk reads stores
 * exactly as the site does; null when the record names no address, or the
 * store does not read under it (counted unreadable, never skipped as empty).
 */
async function storeOf(raw: string): Promise<Store | null> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.email !== "string" || !v.email) return null;
  const ref = storeRef({ email: v.email, sid: typeof v.sid === "string" ? v.sid : "", extra: v.extra === true });
  return storeForEmail(ref);
}

/** Two steps' counts added up, the later step's cursor kept. */
export function addFill(a: FillStep, b: FillStep): FillStep {
  const out = { ...b };
  for (const key of Object.keys(a) as (keyof FillStep)[]) if (key !== "next") (out[key] as number) = (a[key] as number) + (b[key] as number);
  return out;
}

/** What a filling cost at Upstash's paid rates (lib/spend-cost-table.ts): its commands and the bytes it moved, in US dollars. */
export function spendOf(fill: Pick<FillStep, "commands" | "bytes">): number {
  return (fill.commands * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e12 + (fill.bytes * UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e15;
}

/** Whether a run that read every store found nothing left to fill and nothing it could not read. */
export function nothingLeft(fill: FillStep): boolean {
  return fill.next === "0" && fill.unreadableStores === 0 && fill.failedStores === 0 && fill.salesUnreadable === 0 && fill.salesWithout === fill.salesWritten && fill.productsWithout === fill.productsWritten;
}
