/**
 * How a proposal of the AI assistant is named on the studio's proposals page (app/studio/agent/page.tsx).
 * `titles` is null when the products' titles could not be read (rule 24): the label then says so, and never that
 * the product was removed, which could make the creator decline a valid proposal.
 */
export function proposalLabel(kind: string, target: string, titles: Map<string, string> | null): string {
  if (kind !== "product.description") return kind;
  if (titles === null) return "Description of a product whose name could not be read just now";
  return `Description of ${titles.get(target) ?? "a product you have since removed"}`;
}
