/**
 * A ready example for the note in the waitlist's email (487 [IT4], item 5: no
 * empty screen without a ready example; added 16 November 2026). That email
 * tells everyone who confirmed that the product is on sale, and already
 * carries its link and its price (lib/waitlist-rules.ts launchBody); the note
 * is the creator's own words above them. The example sets out what someone who
 * waited looks for there, in the note's own writing (plain text, a blank line
 * between parts), with every part the creator writes marked in [brackets]. It
 * holds nothing but those prompts: no figure, no price, no urgency, no
 * scarcity and no claim, so no word of it stays in the email once the creator
 * has written theirs, in the store's own language.
 *
 * The email goes to everyone confirmed, once, and the list is spent, so it
 * never goes out with one of these prompts left: launch (lib/waitlist.ts)
 * refuses it before anything is put on sale, queued or sent, and the panel
 * refuses it before its review. Only the exact prompts are looked for, so the
 * creator's own brackets ("[Updated]") are never taken for one.
 *
 * Browser-safe.
 */

export const WAITLIST_NOTE = [
  "[A line of thanks for waiting, in your own words.]",
  "",
  "[In one or two sentences: what they get, and what it helps them do.]",
  "",
  "[Anything they need to know before they start.]",
].join("\n");

/** The prompts the example holds: the parts in [brackets]. */
export const WAITLIST_NOTE_PROMPTS: string[] = WAITLIST_NOTE.match(/\[[^\]\n]+\]/g) ?? [];

/** The example's prompts still in a note, in the order they appear; empty when none is left. */
export function waitlistPromptsLeft(note: unknown): string[] {
  const text = typeof note === "string" ? note : "";
  return WAITLIST_NOTE_PROMPTS.filter((prompt) => text.includes(prompt)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/** What the panel says when the note still holds a prompt. */
export const WAITLIST_NOTE_LEFT = "Replace each part in [brackets] from the example with your own words, including the brackets, before it goes on sale: the email goes to everyone on the waitlist at once.";
