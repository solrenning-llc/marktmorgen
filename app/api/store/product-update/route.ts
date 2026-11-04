import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readListing } from "@/lib/catalog";
import { MAX_UPDATE_NOTE, startUpdate } from "@/lib/product-updates";

/**
 * Tells the buyers of a product that it was updated (lib/product-updates.ts):
 * `{ id, note }`. Who may is who may send email from the store.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", MAX_UPDATE_NOTE * 4 + 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const product = await readListing(store, text(body.id, 40));
  if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const started = await startUpdate(store, product, typeof body.note === "string" ? body.note.slice(0, MAX_UPDATE_NOTE * 2) : "");
  // The store's readings of its sales are used for today (lib/store-readings.ts): said in the store's own words.
  if (!started.ok && started.reason === "used") return Response.json({ ok: false, error: "readings_used", message: started.message }, { status: 429 });
  if (!started.ok) return Response.json({ ok: false, error: started.reason, until: started.until ?? null }, { status: started.reason === "stripe" ? 502 : 400 });
  return Response.json({ ok: true, total: started.job.total });
}
