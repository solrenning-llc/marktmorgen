/**
 * A ready example for a new bundle's name and one line (487 [IT4], item 5: no
 * empty screen without a ready example; added 16 November 2026). It sets out
 * what a buyer looks for in them, each part the creator writes marked in
 * [brackets]. It holds nothing but those prompts: no price, no product chosen,
 * no figure and no claim, so no word of it stays once the creator has written
 * theirs, in the store's own language. The price and what goes in the bundle
 * stay the creator's to choose.
 *
 * A bundle is on the store the moment it is made, so it is never made with one
 * of these prompts left: the editor says so before it asks the server, and the
 * bundle route refuses it. They are among the prompts productPromptsLeft
 * (lib/product-outline.ts) looks for, so the product route keeps refusing them
 * once the bundle is a product on the store. Only the exact prompts are looked
 * for, so the creator's own brackets ("[New]") are never taken for one.
 */

export const BUNDLE_EXAMPLE = {
  title: "[A name that says what is in it]",
  summary: "[In one sentence: what a buyer can do with everything in it, and who it is for.]",
} as const;

/** The prompts the example holds: the parts in [brackets]. */
export const BUNDLE_EXAMPLE_PROMPTS: string[] = `${BUNDLE_EXAMPLE.title}\n${BUNDLE_EXAMPLE.summary}`.match(/\[[^\]\n]+\]/g) ?? [];

/** What the editor says when a new bundle still holds a prompt, naming the first one left when known. */
export function bundleExampleMessage(left: string | null): string {
  const part = left ? ` The first one left: ${left}` : "";
  return `Replace each part in [brackets] from the example with your own words, including the brackets, before you add the bundle: it goes on your store at once.${part}`;
}
