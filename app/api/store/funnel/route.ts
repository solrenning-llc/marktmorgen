import type { NextRequest } from "next/server";
import { StoreFullError, setProductFunnel } from "@/lib/store";
import { currencyRule, readMoney } from "@/lib/money";
import { MAX_FUNNEL_STEPS, parseFunnel } from "@/lib/funnel";
import { guardStoreWrite, text } from "@/lib/store-request";
import { brandImitation, imitationWhy } from "@/lib/brand-imitation-rules";

/**
 * Sets or clears what is offered after paying for one product.
 *
 * `{ id, funnel: { steps: [{ id, productId, price: "19", headline, text,
 * imageFrom, yes, no }] } }` or `{ id, funnel: null }`. Prices are read as
 * text, like every other price the studio sends, and every rule a buyer's
 * page applies is checked again here (lib/funnel.ts) before it is saved.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 8_000);
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const id = text(body.id, 40);
  if (!id || !("funnel" in body)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });

  let funnel = null;
  if (body.funnel !== null) {
    // Typed in the store's own currency (lib/money.ts).
    const currency = guarded.store.currency;
    const raw = body.funnel && typeof body.funnel === "object" ? (body.funnel as { steps?: unknown }) : {};
    const list = Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_FUNNEL_STEPS + 1) : [];
    if (list.length === 0 || list.length > MAX_FUNNEL_STEPS) return Response.json({ ok: false, error: "shape" }, { status: 400 });
    const steps = [];
    for (const entry of list) {
      const step = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const cents = readMoney(text(step.price, 12), currency);
      if (cents === null) return Response.json({ ok: false, error: "price" }, { status: 400 });
      steps.push({
        id: text(step.id, 12),
        productId: text(step.productId, 40),
        priceCents: cents,
        headline: text(step.headline, 400),
        text: text(step.text, 2_000),
        imageFrom: typeof step.imageFrom === "string" && step.imageFrom ? step.imageFrom : null,
        yes: typeof step.yes === "string" && step.yes ? step.yes : null,
        no: typeof step.no === "string" && step.no ? step.no : null,
      });
    }
    // An offer is shown to a buyer who has just paid, the moment a fake "verify your card" works best: its headline
    // and text may not pose as Marktmorgen itself (568 [GD2] (c), lib/brand-imitation-rules.ts). Nothing is saved.
    for (const [index, step] of steps.entries()) {
      const posing = brandImitation({ title: step.headline, summary: step.text, about: "" });
      if (posing) {
        const passage = { field: posing.field === "title" ? "headline" : "text", offer: index + 1, excerpt: posing.excerpt, why: imitationWhy("the offer cannot be shown with it"), fix: posing.fix };
        return Response.json({ ok: false, error: "brand_imitation", passage }, { status: 409 });
      }
    }
    funnel = parseFunnel({ steps });
    // A price too low for Stripe reads as a price problem, not a shape one.
    if (!funnel) {
      const low = steps.some((s) => s.priceCents < currencyRule(currency).minCharge);
      return Response.json({ ok: false, error: low ? "price" : "shape" }, { status: 400 });
    }
  }

  try {
    const result = await setProductFunnel(guarded.ref, id, funnel);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("saving a funnel failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
