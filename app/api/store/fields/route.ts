import type { NextRequest } from "next/server";
import { StoreFullError, setProductFields, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readFields } from "@/lib/checkout-fields";
import { readListing } from "@/lib/catalog";
import { heldRefusal } from "@/lib/child-safety";

/**
 * Sets the questions a product asks at checkout.
 *
 * `{ id, fields: [{ label, type, optional, options }] }`, where `options` is
 * the list of choices for a "dropdown", as an array or as one choice a line.
 * The whole list is replaced each time, so removing a question is sending the
 * list without it. Every Stripe limit is checked here, before anything is
 * saved, so a buyer never meets a checkout Stripe refuses to open.
 */
export async function POST(request: NextRequest) {
  // Three lists of two hundred choices of a hundred characters, and room.
  const guarded = await guardStoreWrite(request, "products", 90_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const id = text(body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const onHold = await heldRefusal(guarded.store, id);
  if (onHold) return onHold;

  const fields = readFields(body.fields);
  if (!Array.isArray(fields)) {
    return Response.json({ ok: false, error: fields.reason, at: "at" in fields ? fields.at : undefined }, { status: 400 });
  }

  try {
    const store = await storeForEmail(ref);
    const product = store ? await readListing(store, id) : null;
    if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    // Something free never reaches Stripe's checkout, so it has nowhere to ask.
    if (product.priceCents === 0 && fields.length > 0) {
      return Response.json({ ok: false, error: "free" }, { status: 400 });
    }
    const done = await setProductFields(ref, id, fields);
    if (!done.ok) return Response.json({ ok: false, error: done.reason }, { status: 400 });
    return Response.json({ ok: true, fields: done.product.fields });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("saving checkout questions failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
