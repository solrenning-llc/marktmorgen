import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinEssentialLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE, MAX_AI_NOTES } from "@/lib/ai-rules";
import { idsOfKind, productIds, readListings } from "@/lib/catalog";
import { priceWords } from "@/lib/answers";
import { storeBase } from "@/lib/purchase-email";
import { productLink } from "@/lib/checkout-recovery";
import { LANGUAGES, isLanguage } from "@/lib/store-language";
import { MAX_DRAFT_PRODUCTS } from "@/lib/automation-draft";
import { writeAutomationDraft } from "@/lib/automation-draft-ai";

/**
 * A workflow drafted with AI from the creator's goal (20 [E3],
 * lib/automation-draft-ai.ts): `{ notes }`, the goal in their words.
 * Drafting one needs what saving one needs (the Email Studio's "flow":
 * "send"), and it shares the writing help's per-minute limit. What the store
 * sells is read here, from its own records, in its own order: names,
 * prices, links and whether each is a course, never sent by the page.
 * Nothing is saved here: the draft goes back to the studio, which saves it
 * paused through the Email Studio's own route when the creator asks.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, () => "send", 16_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  if (!(await withinEssentialLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return fail("slow", 429);
  const goal = text(body.notes, MAX_AI_NOTES + 100);

  const hidden = new Set(idsOfKind(store, "hidden"));
  const paid = new Set(idsOfKind(store, "paid"));
  const courses = new Set(idsOfKind(store, "course"));
  const listings = await readListings(store, productIds(store).filter((id) => !hidden.has(id)).slice(0, MAX_DRAFT_PRODUCTS));
  const base = storeBase(store);
  const done = await writeAutomationDraft(
    store,
    {
      storeName: store.name,
      creator: store.mail?.fromName || store.name,
      storeLink: base,
      ordersLink: `${base}/orders`,
      language: isLanguage(store.language) ? LANGUAGES[store.language].english : "English",
      products: listings.map((p) => ({ id: p.id, title: p.title, summary: p.summary, price: priceWords(p, store.currency, store.tiers), link: productLink(store, p.id), paid: paid.has(p.id), course: courses.has(p.id) })),
    },
    goal,
  );
  if (!done.ok) return fail(done.reason, done.reason === "failed" ? 502 : 400);
  return Response.json({ ok: true, value: done.value, left: done.left });
}
