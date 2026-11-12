/**
 * The side list of help topics, its filter only (564 [HC1]): kept apart from
 * lib/help-pages.ts so the browser gets these few lines, not the help
 * center's whole text. Pure and import-free.
 */

export type HelpTopic = { name: string; href: string };

/** The topics whose name has every word typed, in any case and with or without accents; all of them when nothing is typed. */
export function filterTopics(topics: readonly HelpTopic[], typed: string): HelpTopic[] {
  const fold = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US");
  const words = fold(typed).split(/\s+/).filter(Boolean);
  return words.length ? topics.filter((t) => words.every((w) => fold(t.name).includes(w))) : [...topics];
}
