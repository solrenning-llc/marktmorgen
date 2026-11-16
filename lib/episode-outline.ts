/**
 * A ready outline for a podcast episode's notes (487 [IT4], item 5: no empty
 * screen without a ready example; added 16 November 2026). It sets out what a
 * listener looks for in an episode's notes, in the notes' own writing (plain
 * text: a blank line between parts, "- " for a point), with every part the
 * creator writes marked in [brackets]. It holds nothing but those prompts and
 * the points' dashes: nothing in it is a claim, a figure or a quotation, and
 * no word of it stays in the notes once the creator has written theirs, in
 * the store's own language.
 *
 * An episode goes out the moment it is put out (lib/podcast.ts), so it is
 * never put out or changed with one of these prompts still in its title or
 * notes: editPodcast refuses it, and the editor refuses it before the audio is
 * uploaded. Only the exact prompts are looked for, so the creator's own
 * brackets ("[Updated]") are never taken for one.
 */

export const EPISODE_OUTLINE = [
  "[In one or two sentences: what this episode is about, and who it is for.]",
  "",
  "- [The first thing you talk about]",
  "- [The next thing you talk about]",
  "- [The last thing you talk about]",
  "",
  "[Anything the listener needs while listening: a file, a page or a word to look up.]",
  "",
  "[One sentence on what to do after listening.]",
].join("\n");

/** The prompts the outline holds: the parts in [brackets]. */
export const EPISODE_OUTLINE_PROMPTS: string[] = EPISODE_OUTLINE.match(/\[[^\]\n]+\]/g) ?? [];

/** The outline's prompts still in an episode's title or notes, in the order they appear; empty when none is left. */
export function episodePromptsLeft(title: unknown, notes: unknown): string[] {
  const text = `${typeof title === "string" ? title : ""}\n${typeof notes === "string" ? notes : ""}`;
  return EPISODE_OUTLINE_PROMPTS.filter((prompt) => text.includes(prompt)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/** What the editor says when an episode still holds a prompt. */
export const EPISODE_OUTLINE_LEFT = "Replace each part in [brackets] from the outline with your own words, including the brackets, before you put the episode out: it goes out at once.";
