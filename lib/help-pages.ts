/**
 * A page of its own for each section and each answer of the help center (564
 * [HC1], second complement of 30 October 2026, 10h00; added 12 November
 * 2026): /help/<section> lists a section's answers, /help/<section>/<answer>
 * is one answer with the trail above it and its neighbors below. Read only
 * from lib/help-content.ts, the same words /help and the studio's help
 * assistant read, so no page can say something the others do not.
 *
 * Each answer has one address of its own, its answerId under its section's
 * id; the old /help#<answerId> links keep opening the answer on /help as
 * before. Pure and browser-safe.
 */
import { HELP_SECTIONS, type HelpSection, answerId } from "@/lib/help-content";
import { HELP_AREAS } from "@/lib/help-areas";
import type { HelpTopic } from "@/lib/help-topics-rules";

/** The most characters of a page's description: what a search result shows. */
export const SUMMARY_CHARS = 160;

export type HelpAnswer = { section: HelpSection; id: string; q: string; a: string[]; index: number };

/** A section by its id, or null. */
export const helpSection = (id: string): HelpSection | null => HELP_SECTIONS.find((s) => s.id === id) ?? null;

/** One answer by its section and its id, or null when either is not one. */
export function helpAnswer(sectionId: string, id: string): HelpAnswer | null {
  const section = helpSection(sectionId);
  const index = section ? section.items.findIndex((item) => answerId(item.q) === id) : -1;
  if (!section || index < 0) return null;
  const item = section.items[index];
  return { section, id, q: item.q, a: item.a, index };
}

/** An answer's own address. */
export const helpAnswerPath = (sectionId: string, id: string) => `/help/${sectionId}/${id}`;

/** Every section's and every answer's address, for the static pages and the sitemap. */
export function helpPagePaths(): { section: string; answer?: string }[] {
  return HELP_SECTIONS.flatMap((s) => [{ section: s.id }, ...s.items.map((item) => ({ section: s.id, answer: answerId(item.q) }))]);
}

/**
 * The start of an answer, as a line under its question in a list and as the
 * page's description: its first sentence when that fits, else its first words
 * up to SUMMARY_CHARS, cut at a word, with an ellipsis. Nothing is written
 * that the answer does not say.
 */
export function answerSummary(paragraphs: readonly string[]): string {
  const text = (paragraphs[0] ?? "").replace(/\s+/g, " ").trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  if ([...sentence].length <= SUMMARY_CHARS) return sentence;
  const cut = [...text].slice(0, SUMMARY_CHARS - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > SUMMARY_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** The other answers of the same section, in its order, for "More in <section>". */
export const sectionNeighbors = (answer: HelpAnswer): { id: string; q: string }[] =>
  answer.section.items.filter((_, i) => i !== answer.index).map((item) => ({ id: answerId(item.q), q: item.q }));

/** The section an answer is in, by the answer's id; null when no answer has it. */
export const sectionOfAnswer = (id: string): string | null => HELP_SECTIONS.find((s) => s.items.some((item) => answerId(item.q) === id))?.id ?? null;

/** Every studio area as a topic of the side list, by name, each to its answer's own page (564 [HC1]). */
export function helpTopics(): HelpTopic[] {
  return [...HELP_AREAS]
    .sort((a, b) => a.name.localeCompare(b.name, "en-US"))
    .flatMap((area) => {
      const section = sectionOfAnswer(area.answer);
      return section ? [{ name: area.name, href: helpAnswerPath(section, area.answer) }] : [];
    });
}

/** A day kept as YYYY-MM-DD (UTC), in US English with the month in full, never an abbreviation (3.1.4): "November 12, 2026". */
export const helpDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export type DatedAnswer = { section: string; id: string; q: string; created: string; updated: string };

/** Every answer with its dates (lib/help-dates.ts); an answer without them is left out, never dated by guess. */
export function datedAnswers(dates: Readonly<Record<string, { created: string; updated: string }>>): DatedAnswer[] {
  return HELP_SECTIONS.flatMap((s) => s.items.flatMap((item) => {
    const id = answerId(item.q);
    const d = dates[id];
    return d ? [{ section: s.id, id, q: item.q, created: d.created, updated: d.updated }] : [];
  }));
}

/** The newest answers, by the day they were first written, at most `most`. */
export const newestAnswers = (answers: readonly DatedAnswer[], most = 5) =>
  [...answers].sort((a, b) => b.created.localeCompare(a.created) || a.q.localeCompare(b.q, "en-US")).slice(0, most);

/** The answers whose words changed after they were first written, most recent first, at most `most`. */
export const recentlyUpdated = (answers: readonly DatedAnswer[], most = 5) =>
  answers.filter((a) => a.updated > a.created).sort((a, b) => b.updated.localeCompare(a.updated) || a.q.localeCompare(b.q, "en-US")).slice(0, most);
