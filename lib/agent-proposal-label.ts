/**
 * How a proposal of the AI assistant is named on the studio's proposals page (app/studio/agent/page.tsx).
 * `titles` is null when the products' titles could not be read (rule 24): the label then says so, and never that
 * the product was removed, which could make the creator decline a valid proposal.
 */
/** What each kind of change to a product is called (#1929: the title and the summary as well as the description). */
const PRODUCT_PART: Record<string, string> = { "product.description": "Description", "product.title": "Title", "product.summary": "Summary" };

export function proposalLabel(kind: string, target: string, titles: Map<string, string> | null): string {
  const part = PRODUCT_PART[kind];
  if (!part) return kind;
  if (titles === null) return `${part} of a product whose name could not be read just now`;
  return `${part} of ${titles.get(target) ?? "a product you have since removed"}`;
}
