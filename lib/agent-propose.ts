/**
 * What the agent's tools that prepare a change do (631 [AA1] (c)): read what
 * the store holds now, and put a proposal in the store's book
 * (lib/agent-book.ts) for the creator to confirm in the studio. Nothing on
 * the store changes here.
 */
import type { Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { MAX_ABOUT_LENGTH, cleanAbout } from "@/lib/product-about";
import { DataRoomError } from "@/lib/store-data";
import { BookBusy, addProposal } from "@/lib/agent-book";
import { PRODUCT_DESCRIPTION } from "@/lib/agent-kinds";

type Answer = { content: { type: "text"; text: string }[]; isError: boolean };
const answer = (value: unknown, isError = false): Answer => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError });

/** propose_product_description: a new long description for one product, waiting for the creator. */
export async function proposeDescription(store: Store, keyId: string, args: Record<string, unknown>): Promise<Answer> {
  const product = typeof args.product === "string" ? args.product.slice(0, 40) : "";
  const raw = typeof args.description === "string" ? args.description : null;
  if (!product || raw === null) return answer({ error: "Send product (from list_products) and description (the whole new text)." }, true);
  if (raw.length > MAX_ABOUT_LENGTH * 2) return answer({ error: `A description holds at most ${MAX_ABOUT_LENGTH.toLocaleString("en-US")} characters.` }, true);
  const listing = await readListing(store, product);
  if (!listing || !store.statsId) return answer({ error: "There is no such product in this store. Use list_products for the ids." }, true);
  const after = cleanAbout(raw);
  // The words the studio would refuse on this product are refused here too, before the creator ever sees them.
  const refused = await PRODUCT_DESCRIPTION.refusal?.(store, product, after);
  if (refused) return answer({ error: `${refused} Nothing was proposed.` }, true);
  try {
    const before = await PRODUCT_DESCRIPTION.current(store, product);
    const made = await addProposal({ ...store, statsId: store.statsId }, PRODUCT_DESCRIPTION, { target: product, before, after, asked: { by: "mcp", who: keyId } });
    if (!made.ok) {
      const words = { no_change: "That is already the product's description: nothing to propose.", too_big: "That description is too long to propose.", too_many: "Fifty proposals are already waiting for the creator. Ask them to look at those first.", bad_kind: "That cannot be proposed." } as const;
      return answer({ error: words[made.error] }, true);
    }
    return answer({
      proposal: made.proposal.id,
      product: listing.id,
      title: listing.title,
      waiting_for: "the creator to confirm it in their studio, under What the AI proposes",
      replaced: made.replaced,
    });
  } catch (error) {
    if (error instanceof DataRoomError) return answer({ error: "The store has no room for this proposal right now." }, true);
    if (error instanceof BookBusy) return answer({ error: "Another change is being made to the proposals right now. Try again in a moment." }, true);
    console.error("proposing a description failed", error);
    return answer({ error: "The proposal could not be kept just now. Try again in a moment." }, true);
  }
}
