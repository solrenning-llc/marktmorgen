import type { NextRequest } from "next/server";
import { setAnniversary } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * The email on the anniversary of a purchase (lib/anniversary-rules.ts, 283 [HG2]):
 * `{ on, message, address, products }`, products "all" or a list of the store's product ids;
 * left out, the saved choice is kept.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  try {
    const result = await setAnniversary(guarded.ref, { on: guarded.body.on, message: guarded.body.message, address: guarded.body.address, products: guarded.body.products });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    return Response.json({ ok: true, anniversary: result.store.anniversary });
  } catch (error) {
    console.error("saving the anniversary email failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
