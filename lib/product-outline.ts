/**
 * A ready outline for a product's full description (487 [IT4], item 5: no
 * empty screen without a ready example; added 2 November 2026). It sets out
 * what buyers look for on a product page, in the description's own writing
 * (lib/product-about.ts: a blank line starts a paragraph, "- " a point), with
 * every part the creator writes marked in [brackets]. Nothing in it is a
 * claim, a figure or a quotation: it says what goes where.
 *
 * A product is never on the store with one of these prompts still in its
 * title, its line or its description: the product route refuses adding it,
 * saving it while it is published, and publishing a draft that holds one
 * (as it does for a course's example titles); a draft may keep them. Only the
 * exact prompts are looked for, so the creator's own brackets are never
 * taken for one.
 */

export const PRODUCT_OUTLINE = [
  "[In one or two sentences: what someone gets, and what it helps them do.]",
  "",
  "What is inside:",
  "- [The first thing inside]",
  "- [The next thing inside]",
  "",
  "[Who it is for, and who it is not for.]",
  "",
  "[What happens after they buy: how they get it, and when.]",
].join("\n");

/** The prompts the outline holds: the parts in [brackets]. */
export const PRODUCT_OUTLINE_PROMPTS: string[] = PRODUCT_OUTLINE.match(/\[[^\]\n]+\]/g) ?? [];

/** The outline's prompts still in a product's words, in the order they appear; empty when none is left. */
export function productPromptsLeft(words: { title: string; summary: string; about: string }): string[] {
  const text = `${words.title}\n${words.summary}\n${words.about}`;
  return PRODUCT_OUTLINE_PROMPTS.filter((prompt) => text.includes(prompt)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/** What the editor says when a product still holds a prompt, by what was refused: adding it, saving it while it is on the store, or publishing it. */
export function productOutlineMessage(when: "add" | "save" | "publish", left: string | null, product: string | null): string {
  const part = left ? ` The first one left: ${left}` : "";
  if (when === "publish") return `${product ? `“${product}”` : "This product"} still has a part in [brackets] from the outline. Press Edit, replace each one, brackets and all, with your own words, then publish it.${part}`;
  if (when === "save") return `This product is on your store, so it cannot be saved with a part in [brackets] from the outline. Replace each one, brackets and all, with your own words.${part}`;
  return `Replace each part in [brackets] from the outline, brackets and all, with your own words before you add it: it goes on your store at once.${part}`;
}

/** The plain refusal, for a screen that has only one way to save. */
export const PRODUCT_OUTLINE_LEFT = productOutlineMessage("add", null, null);
