import type { NextRequest } from "next/server";
import { setProductExtras } from "@/lib/store";
import { MAX_BUMPS, MAX_STOCK, parsePlan, parseStock } from "@/lib/product-extras";
import { MAX_OPTIONS } from "@/lib/product-option";
import { guardStoreWrite, text } from "@/lib/store-request";
import { StoreFullError } from "@/lib/store";
import { currencyRule, readMoney } from "@/lib/money";
import { heldRefusal } from "@/lib/child-safety";

/**
 * Sets or clears a product's limited quantity or its order bump.
 *
 * `{ id, stock: 50 }` or `{ id, stock: null }`;
 * `{ id, bump: { productId, price: "9", pitch }, slot: 0 }` or `{ id, bump: null, slot: 0 }`:
 * the box at that place, 0 to 2 (lib/product-extras.ts, MAX_BUMPS); one
 * past the last adds a box, and taking one away moves the next ones up;
 * `{ id, plan: { payments: 3, interval: "month", price: "110" } }` or `{ id, plan: null }`;
 * on a product with several prices, `options: { optionId: "37", … }` instead of `price`.
 * The price is read as text, like every other price the studio sends, in the
 * store's own currency (lib/money.ts).
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 4_000);
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const id = text(body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const onHold = await heldRefusal(guarded.store, id);
  if (onHold) return onHold;

  // Prices are typed in the store's currency; the smallest charge is its own.
  const currency = guarded.store.currency;
  const least = currencyRule(currency).minCharge;

  const change: Parameters<typeof setProductExtras>[2] = {};
  if ("stock" in body) {
    if (body.stock === null) change.stock = null;
    else {
      const stock = parseStock(body.stock);
      if (stock === null) return Response.json({ ok: false, error: "stock", max: MAX_STOCK }, { status: 400 });
      change.stock = stock;
    }
  }
  if ("bump" in body) {
    const slot = body.slot === undefined ? 0 : Number(body.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_BUMPS) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
    change.slot = slot;
    if (body.bump === null) change.bump = null;
    else {
      const raw = body.bump && typeof body.bump === "object" ? (body.bump as Record<string, unknown>) : {};
      const productId = text(raw.productId, 40);
      const cents = readMoney(text(raw.price, 12), currency);
      if (!productId) return Response.json({ ok: false, error: "target" }, { status: 400 });
      if (cents === null || cents < least) return Response.json({ ok: false, error: "price" }, { status: 400 });
      const pitch = text(raw.pitch, 400).replace(/\s+/g, " ").trim().slice(0, 140);
      change.bump = { productId, priceCents: cents, pitch };
    }
  }
  if ("plan" in body) {
    if (body.plan === null) change.plan = null;
    else {
      const raw = body.plan && typeof body.plan === "object" ? (body.plan as Record<string, unknown>) : {};
      // On a product with several prices, one payment for each: `{ optionId: "37" }`.
      let options: Record<string, number> | undefined;
      if (raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)) {
        options = {};
        for (const [option, price] of Object.entries(raw.options as Record<string, unknown>).slice(0, MAX_OPTIONS)) {
          const each = readMoney(text(price, 12), currency);
          if (each === null || each < least) return Response.json({ ok: false, error: "plan" }, { status: 400 });
          options[option] = each;
        }
      }
      const cents = options ? null : readMoney(text(raw.price, 12), currency);
      const plan = parsePlan({ payments: Number(raw.payments), interval: raw.interval, amountCents: cents ?? NaN, options });
      if (!plan || plan.amountCents < least) return Response.json({ ok: false, error: "plan" }, { status: 400 });
      if (options && Object.keys(plan.options ?? {}).length !== Object.keys(options).length) return Response.json({ ok: false, error: "plan" }, { status: 400 });
      change.plan = plan;
    }
  }
  if (change.stock === undefined && change.bump === undefined && change.plan === undefined) {
    return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  }

  try {
    const result = await setProductExtras(guarded.ref, id, change);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    return Response.json({ ok: true, product: result.product });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("saving product extras failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
