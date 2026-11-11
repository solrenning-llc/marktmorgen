/** The site page's stored body for its admission test: one text block, read with a GET counted like the real one. */
import { EMPTY_PAGE, type SalesPage } from "../lib/sales-page";
import { redisPipeline } from "./redis-stub";
export * from "../lib/sales-page-store";
export async function readPage(statsId: string | null, key: string): Promise<SalesPage> {
  await redisPipeline([["GET", `nl:product:page:${statsId}:${key}`]]);
  return { ...EMPTY_PAGE, blocks: [{ id: "b1", kind: "text", heading: "Synthetic heading", body: "Synthetic body." }] };
}
