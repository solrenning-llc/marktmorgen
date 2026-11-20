import type { NextRequest } from "next/server";
import { fairProductsOverCap } from "@/lib/fair-price";
import { setFair } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * Fair prices by country (lib/fair-price.ts), from the studio:
 * `{ on, auto, maxOff, levels }`: on or off, by itself from the World
 * Bank's numbers or only for the countries listed, the deepest discount the
 * suggestion gives, the creator's own level for any country, and every
 * product it can cover or only those in `products`. Prices are the "settings" permission, as a sale is.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 8_000);
  if (!guarded.ok) return guarded.response;
  // More products than it can be limited to: refused whole, the setting saved before kept as it is, never saved cut
  // to the first MAX_FAIR_PRODUCTS (Claude 1's order C1-20261117-1449-c6c3-2).
  if (fairProductsOverCap(guarded.body)) return Response.json({ ok: false, error: "fair_products" }, { status: 400 });
  try {
    const store = await setFair(guarded.ref, {
      on: guarded.body.on === true,
      auto: guarded.body.auto !== false,
      maxOff: guarded.body.maxOff,
      levels: guarded.body.levels,
      all: guarded.body.all !== false,
      products: guarded.body.products,
    });
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
    return Response.json({ ok: true, fair: store.fair });
  } catch (error) {
    console.error("saving fair prices failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
