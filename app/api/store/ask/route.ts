import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";
import { clientAddress, fromAnotherSite, limited, essentialLimitState } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";
import { readAbout } from "@/lib/product-about";
import { readPage } from "@/lib/sales-page-store";
import { answerQuestion, answersOn } from "@/lib/answers";
import { ASKS_PER_DAY, ASKS_PER_TEN_MINUTES, STORE_ASKS_PER_MINUTE } from "@/lib/answers-rules";
import { pageShown } from "@/lib/sales-page";

/** The model is given twenty seconds; the route a little more. */
export const maxDuration = 30;

const MAX_BODY_BYTES = 2_000;

/**
 * A visitor asks a question about a product, and is answered from what its
 * page says (lib/answers.ts). `{ handle, product, question }`.
 *
 * Public, and it reaches a model that costs money, so everything that can
 * stand in front of it does: another site is refused; one visitor gets a few
 * questions in ten minutes and a ceiling a day; one store is asked only so
 * many in a minute; the store's month has its own number, past which the
 * answer is "closed" (lib/answers-rules.ts). Nothing about the visitor is
 * kept or sent on: the address is used for the counting above and no more.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let handle = "";
  let productId = "";
  let question: unknown = "";
  try {
    const body = (await (await limited(request, MAX_BODY_BYTES)).json()) as Record<string, unknown>;
    handle = normaliseHandle(typeof body.handle === "string" ? body.handle : "");
    productId = typeof body.product === "string" ? body.product.slice(0, 40) : "";
    question = body.question;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  if (!answersOn(store) || !canSell(store)) return Response.json({ ok: false, error: "off" }, { status: 400 });

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
    const product = productId ? await readListing(store, productId) : null;
    if (!product || product.hidden) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    const [about, page] = await Promise.all([
      product.about ? readAbout(store.statsId, product.id) : Promise.resolve(""),
      // A page kept from visitors is not answered from.
      product.page ? readPage(store.statsId, product.id).then((page) => (pageShown(page) ? page : null)) : Promise.resolve(null),
    ]);
    const result = await answerQuestion({ store, product, about, page, question });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "failed" ? 502 : 400 });
    return Response.json({ ok: true, answer: result.answer, known: result.known }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("answering a question failed", error);
    return Response.json({ ok: false, error: "failed" }, { status: 502 });
  }
}
