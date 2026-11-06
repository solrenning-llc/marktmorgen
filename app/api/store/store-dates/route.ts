import type { NextRequest } from "next/server";
import { saveStoreDates } from "@/lib/store-dates-send";
import { guardStoreWrite } from "@/lib/store-request";

/** The store's own dates, each with its email, once a year (lib/store-dates-rules.ts, 283 [HG2] unit 2): `{ on, dates }`. */
export async function POST(request: NextRequest) {
  // Up to MAX_STORE_DATES dates, each with its email: room for all of them written out in full.
  const guarded = await guardStoreWrite(request, "settings", 64_000);
  if (!guarded.ok) return guarded.response;
  try {
    const result = await saveStoreDates(guarded.ref, { on: guarded.body.on, dates: guarded.body.dates });
    if (!result.ok) return Response.json({ ok: false, error: result.reason, ...(result.index !== undefined ? { index: result.index } : {}) }, { status: 400 });
    return Response.json({ ok: true, storeDates: result.store.storeDates });
  } catch (error) {
    console.error("saving the store's dates failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
