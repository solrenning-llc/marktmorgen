/** RED stub: the words for those left out of a change in bulk come with the fix. */
export type HeldWhy = "cap" | "unavailable";
export type HeldOne = { id: string; email: string; why: HeldWhy };
export function heldLines(_held: HeldOne[], _what: "approve" | "rate"): string[] {
  return [];
}
