/**
 * Keeping what a creator chose from the AI's first draft of their store
 * (lib/ai.ts, writeStoreSetup; added 10 October 2026). The line goes under
 * the name; the questions go onto the page only when it has none yet; each
 * product is put up as a draft — never on sale until the creator adds what
 * it hands over and publishes it. A membership is made monthly; a course or
 * a call starts as a draft the creator turns into one from its own editor.
 *
 * Each draft product also gets its sales page (219 [OP5] unit 4): the page
 * template for its kind (lib/sales-page.ts, blocksFromTemplate), with the
 * product's own title and summary in the headline and every other sentence
 * left for the creator. Nothing is invented and no AI is asked, so it costs
 * no writing job; it takes the store's data room like any page, and a page
 * that does not fit is simply not made (the product is kept all the same).
 */
import { MAX_BIO_LENGTH, type Store, addProduct, setFaq, setProductPage, updateDetails } from "@/lib/store";
import { parseFaq } from "@/lib/store-faq";
import { EMPTY_PAGE, blocksFromTemplate, parsePage } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";

export type SetupKept = { bio: boolean; products: number; pages: number; faq: boolean; refused: string[] };

/** The page template for a drafted product's kind: what a buyer of that kind of product is shown. */
export function setupTemplate(kind: unknown, free: boolean): string {
  if (free) return "free";
  return kind === "course" ? "course" : kind === "call" ? "coaching" : kind === "membership" ? "membership" : "guide";
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

export async function keepStoreSetup(ref: string, store: Store, body: Record<string, unknown>): Promise<SetupKept> {
  const done: SetupKept = { bio: false, products: 0, pages: 0, faq: false, refused: [] };
  const bio = text(body.bio, MAX_BIO_LENGTH * 2).trim().slice(0, MAX_BIO_LENGTH);
  if (bio) done.bio = (await updateDetails(ref, store.name, bio)).ok;
  for (const raw of Array.isArray(body.products) ? body.products.slice(0, 3) : []) {
    const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const title = text(p.title, 120);
    if (!title.trim()) continue;
    const membership = p.kind === "membership";
    const made = await addProduct(ref, title, text(p.summary, 200), text(p.price, 20), membership ? { interval: "month", trialDays: 0, payments: 0 } : null, null, true);
    if (!made.ok) {
      done.refused.push(title.trim());
      continue;
    }
    done.products += 1;
    // Its sales page, from the template for its kind, held to every rule a saved page is (parsePage), in the
    // store's data room. As the page route does: the product is marked as having a page, then the page is
    // written; a page that does not fit is left out and the mark taken back, so nothing is shown or kept half-made.
    const page = parsePage({ ...EMPTY_PAGE, blocks: blocksFromTemplate(setupTemplate(p.kind, made.product.priceCents === 0), { title: made.product.title, summary: made.product.summary ?? "", picture: false }) });
    const marked = await setProductPage(ref, made.product.id, true).catch(() => null);
    if (marked?.ok && marked.store.statsId) {
      try {
        await writePage(marked.store.statsId, made.product.id, page, marked.store);
        done.pages += 1;
      } catch (error) {
        console.error("a drafted product's page was not made", error);
        await setProductPage(ref, made.product.id, false).catch(() => null);
      }
    }
  }
  const faq = parseFaq(body.faq);
  if (faq.length && store.faq.length === 0) done.faq = Boolean(await setFaq(ref, faq));
  return done;
}
