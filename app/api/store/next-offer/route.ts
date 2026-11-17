import type { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { StoreFullError, setProductFunnel } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { guardStoreWrite, text } from "@/lib/store-request";
import { heldRefusalAmong } from "@/lib/child-safety";

/**
 * One press from "What buyers get next" (lib/next-bought.ts): the product its
 * buyers most often bought later is offered in one click after paying for
 * this one, at its own price, with its own picture. `{ from, to }`.
 *
 * Only where nothing is offered after this product yet: a creator who built
 * offers by hand keeps them, and is sent to change them instead
 * ("has_funnel"). Every rule an offer after paying has is checked by
 * setProductFunnel, as when the creator builds one (lib/funnel.ts).
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 1_000);
  if (!guarded.ok) return guarded.response;
  const from = text(guarded.body.from, 40);
  const to = text(guarded.body.to, 40);
  if (!from || !to || from === to) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  try {
    const store = guarded.store;
    const [owner, offered] = await Promise.all([readProduct(store, from), readListing(store, to)]);
    if (!owner || !offered) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    // Neither a product kept for a report nor an offer of one (lib/child-safety.ts): its funnel stays as it is.
    const held = await heldRefusalAmong(store, [owner.id, offered.id]);
    if (held) return held;
    if (owner.funnel) return Response.json({ ok: false, error: "has_funnel" }, { status: 409 });
    const step = {
      id: randomBytes(4).toString("hex"),
      productId: offered.id,
      priceCents: offered.priceCents,
      headline: "",
      text: "",
      imageFrom: offered.id,
      yes: null,
      no: null,
    };
    const result = await setProductFunnel(guarded.ref, owner.id, { steps: [step] });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("offering what buyers get next failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
