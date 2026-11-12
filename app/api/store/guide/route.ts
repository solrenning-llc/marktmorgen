import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";
import { clientAddress, fromAnotherSite, limited, essentialLimitState } from "@/lib/request-guard";
import { productIds, readListings } from "@/lib/catalog";
import { ASKS_PER_DAY, ASKS_PER_TEN_MINUTES, STORE_ASKS_PER_MINUTE } from "@/lib/answers-rules";
import { GUIDE_PRODUCTS, guideVisitor } from "@/lib/store-guide";
import { pricePill, productPath } from "@/components/store-product";

/** The model is given twenty seconds; the route a little more. */
export const maxDuration = 30;

const MAX_BODY_BYTES = 2_000;

/**
 * A visitor on the store page says what they are looking for, and is shown
 * which products fit (lib/store-guide.ts). `{ handle, goal }`. Public and
 * paid for by the store, so it stands behind the same limits as a question
 * about a product: per visitor, per store a minute, and the store's month.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let handle = "";
  let goal: unknown = "";
  try {
    const body = (await (await limited(request, MAX_BODY_BYTES)).json()) as Record<string, unknown>;
    handle = normaliseHandle(typeof body.handle === "string" ? body.handle : "");
    goal = body.goal;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  if (!canSell(store)) return Response.json({ ok: false, error: "off" }, { status: 400 });

  const who = `${clientAddress(request)}|${store.handle}`;
  for (const check of [
    () => essentialLimitState("ask", who, ASKS_PER_TEN_MINUTES, 600),
    () => essentialLimitState("ask-day", who, ASKS_PER_DAY, 86_400),
    () => essentialLimitState("ask-store", store.handle, STORE_ASKS_PER_MINUTE, 60),
  ]) {
    const state = await check();
    if (state === "unknown") return Response.json({ ok: false, error: "try again in a moment" }, { status: 503 });
    if (state === "exceeded") return Response.json({ ok: false, error: "slow" }, { status: 429 });
  }

  try {
    const products = (await readListings(store, productIds(store).slice(0, GUIDE_PRODUCTS * 2))).filter((p) => !p.hidden).slice(0, GUIDE_PRODUCTS);
    const result = await guideVisitor({ store, products, goal });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "failed" ? 502 : 400 });
    const byId = new Map(products.map((p) => [p.id, p]));
    const picks = result.picks.flatMap((pick) => {
      const product = byId.get(pick.id);
      return product ? [{ title: product.title, href: productPath(store, product), price: pricePill(store, product), why: pick.why }] : [];
    });
    return Response.json({ ok: true, picks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("guiding a visitor failed", error);
    return Response.json({ ok: false, error: "failed" }, { status: 502 });
  }
}
