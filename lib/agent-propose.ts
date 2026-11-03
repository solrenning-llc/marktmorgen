/**
 * What the agent's tools that prepare a change do (631 [AA1] (c)): read what
 * the store holds now, and put a proposal in the store's book
 * (lib/agent-book.ts) for the creator to confirm in the studio. Nothing on
 * the store changes here.
 */
import type { Store } from "@/lib/store";
import { MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH, readListing } from "@/lib/catalog";
import { MAX_ABOUT_LENGTH, cleanAbout } from "@/lib/product-about";
import { DataRoomError } from "@/lib/store-data";
import { BookBusy, addProposal } from "@/lib/agent-book";
import { type AgentKind, PRODUCT_DESCRIPTION, PRODUCT_SUMMARY, PRODUCT_TITLE } from "@/lib/agent-kinds";

type Answer = { content: { type: "text"; text: string }[]; isError: boolean };
const answer = (value: unknown, isError = false): Answer => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError });

/** Keeps a proposal of `kind` for one product, after the words checks the studio runs; the answer the agent reads. */
async function keep(store: Store, keyId: string, kind: AgentKind, product: string, after: string, what: string): Promise<Answer> {
  const listing = await readListing(store, product);
  if (!listing || !store.statsId) return answer({ error: "There is no such product in this store. Use list_products for the ids." }, true);
  // The words the studio would refuse on this product are refused here too, before the creator ever sees them.
  const refused = await kind.refusal?.(store, product, after);
  if (refused) return answer({ error: `${refused} Nothing was proposed.` }, true);
  try {
    const before = await kind.current(store, product);
    const made = await addProposal({ ...store, statsId: store.statsId }, kind, { target: product, before, after, asked: { by: "mcp", who: keyId } });
    if (!made.ok) {
      const words = { no_change: `That is already the product's ${what}: nothing to propose.`, too_big: `That ${what} is too long to propose.`, too_many: "Fifty proposals are already waiting for the creator. Ask them to look at those first.", bad_kind: "That cannot be proposed." } as const;
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
    console.error(`proposing a ${what} failed`, error);
    return answer({ error: "The proposal could not be kept just now. Try again in a moment." }, true);
  }
}

/** propose_product_description: a new long description for one product, waiting for the creator. */
export async function proposeDescription(store: Store, keyId: string, args: Record<string, unknown>): Promise<Answer> {
  const product = typeof args.product === "string" ? args.product.slice(0, 40) : "";
  const raw = typeof args.description === "string" ? args.description : null;
  if (!product || raw === null) return answer({ error: "Send product (from list_products) and description (the whole new text)." }, true);
  if (raw.length > MAX_ABOUT_LENGTH * 2) return answer({ error: `A description holds at most ${MAX_ABOUT_LENGTH.toLocaleString("en-US")} characters.` }, true);
  return keep(store, keyId, PRODUCT_DESCRIPTION, product, cleanAbout(raw), "description");
}

/** propose_product_title: a new title for one product, waiting for the creator. */
export async function proposeTitle(store: Store, keyId: string, args: Record<string, unknown>): Promise<Answer> {
  const product = typeof args.product === "string" ? args.product.slice(0, 40) : "";
  const raw = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim() : "";
  if (!product || !raw) return answer({ error: "Send product (from list_products) and title (the whole new title, not empty)." }, true);
  if (raw.length > MAX_TITLE_LENGTH) return answer({ error: `A title holds at most ${MAX_TITLE_LENGTH} characters.` }, true);
  return keep(store, keyId, PRODUCT_TITLE, product, raw, "title");
}

/** propose_product_summary: a new short summary (the line under the title) for one product, waiting for the creator. */
export async function proposeSummary(store: Store, keyId: string, args: Record<string, unknown>): Promise<Answer> {
  const product = typeof args.product === "string" ? args.product.slice(0, 40) : "";
  const raw = typeof args.summary === "string" ? args.summary.replace(/\s+/g, " ").trim() : null;
  if (!product || raw === null) return answer({ error: "Send product (from list_products) and summary (the whole new line; empty takes it off)." }, true);
  if (raw.length > MAX_SUMMARY_LENGTH) return answer({ error: `A summary holds at most ${MAX_SUMMARY_LENGTH} characters.` }, true);
  return keep(store, keyId, PRODUCT_SUMMARY, product, raw, "summary");
}
