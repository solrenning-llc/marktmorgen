/**
 * The products the studio offers to choose from for the email on the
 * anniversary of a purchase (lib/anniversary-rules.ts, 283 [HG2] unit 3), in
 * the creator's order: those a buyer pays for once (never a free product, a
 * call or a membership), from one read of the store's cards (lib/catalog.ts),
 * inside the studio request that shows them. The daily job reads nothing
 * more for the choice: it is on the store record.
 */
import { KIND, readCards } from "@/lib/catalog";
import type { Store } from "@/lib/store";

export async function anniversaryChoices(store: Store): Promise<{ id: string; title: string }[]> {
  const once = store.catalog.items.filter((item) => (item.kind & KIND.paid) !== 0 && (item.kind & (KIND.call | KIND.recurring)) === 0).map((item) => item.id);
  if (!once.length) return [];
  const cards = await readCards(store);
  return once.flatMap((id) => {
    const card = cards.get(id);
    return card ? [{ id, title: card.title }] : [];
  });
}
