/**
 * A poll in a one-off email (125 [F2-EMAIL-POLLS], unit 1; added 6 November
 * 2026): the rules and the drawing, pure and browser-safe, as for the
 * store's profiles (lib/mail-socials-block.ts).
 *
 * Written as a paragraph of its own, which the box and the designer both
 * keep as text:
 *
 *   @poll What should I make next?
 *   - A video course
 *   - A printable guide
 *
 *   - One question, of up to MAX_POLL_QUESTION characters, on the first line.
 *   - MIN_POLL_ANSWERS to MAX_POLL_ANSWERS different answers, one a line,
 *     each of up to MAX_POLL_ANSWER characters, without square brackets.
 *   - One poll an email. A line that starts like a poll and is not one stops
 *     the email before it goes, saying why, so a reader never gets it as raw
 *     text (pollProblem).
 *
 * When it goes, each reader's copy draws the question as a heading and each
 * answer as a button: a real link with the answer's own words, which opens a
 * page where the reader confirms it (lib/mail-poll-votes.ts, app/poll). The
 * page, not the link, records it, so a mail scanner that opens every link
 * records nothing. Nothing reports an open: there is no pixel, and a button
 * is a link. The plain text lists each answer with its link.
 */
import { SITE_URL } from "@/lib/site-url";

export const POLL_LINE = "@poll";
export const MAX_POLL_QUESTION = 120;
/** A button's words are at most 60 characters (lib/mail-body.ts, MAX_MAIL_BUTTON). */
export const MAX_POLL_ANSWER = 60;
export const MIN_POLL_ANSWERS = 2;
export const MAX_POLL_ANSWERS = 5;
/** The fewest answers a poll's totals are shown at (lib/mail-poll-votes.ts): below it, a total could say what one reader picked. */
export const POLL_MIN_SHOWN = 5;

export type MailPoll = { question: string; answers: string[] };

const STARTS_POLL = /^@polls?\b/i;
const QUESTION = /^@poll[ \t]+(.*)$/;
const ANSWER = /^[-•][ \t]+(.*)$/;

const paragraphs = (body: string) => body.replace(/\r\n?/g, "\n").split(/\n{2,}/);

/** A paragraph read as a poll, bounds unchecked, or null when it is not written as one. */
function readShape(paragraph: string): MailPoll | null {
  const lines = paragraph.trim().split("\n").map((line) => line.trim());
  const question = lines[0]?.match(QUESTION);
  if (!question) return null;
  const answers: string[] = [];
  for (const line of lines.slice(1)) {
    const answer = line.match(ANSWER);
    if (!answer) return null;
    answers.push(answer[1].replace(/\s+/g, " ").trim());
  }
  return { question: question[1].replace(/\s+/g, " ").trim(), answers };
}

/** Why a poll as written cannot go, or null. */
function shapeProblem(poll: MailPoll): string | null {
  if (!poll.question) return "Write the poll's question on the line that starts with @poll.";
  if (poll.question.length > MAX_POLL_QUESTION) return `A poll's question is at most ${MAX_POLL_QUESTION} characters.`;
  if (poll.answers.length < MIN_POLL_ANSWERS || poll.answers.length > MAX_POLL_ANSWERS) return `A poll has ${MIN_POLL_ANSWERS} to ${MAX_POLL_ANSWERS} answers, one a line, each starting with "- ".`;
  if (poll.answers.some((answer) => !answer)) return "Each answer of a poll needs some words.";
  if (poll.answers.some((answer) => answer.length > MAX_POLL_ANSWER)) return `Each answer of a poll is at most ${MAX_POLL_ANSWER} characters.`;
  if (poll.answers.some((answer) => /[[\]]/.test(answer))) return "An answer of a poll cannot hold square brackets.";
  if (new Set(poll.answers.map((answer) => answer.toLowerCase())).size !== poll.answers.length) return "Each answer of a poll must be different.";
  return null;
}

/** Whether a paragraph is a poll that can go. */
export function isPollParagraph(paragraph: string): boolean {
  const poll = readShape(paragraph);
  return Boolean(poll && !shapeProblem(poll));
}

/** The email's poll, or null when it has none that can go. */
export function readPoll(body: string): MailPoll | null {
  for (const paragraph of paragraphs(body)) {
    const poll = readShape(paragraph);
    if (poll && !shapeProblem(poll)) return poll;
  }
  return null;
}

/** Whether an email's text holds a poll, or a line written to be one. */
export function hasPoll(body: string): boolean {
  return paragraphs(body).some((paragraph) => paragraph.trim().split("\n").some((line) => STARTS_POLL.test(line.trim())));
}

/** Why an email cannot go with its poll, in plain words, or null. */
export function pollProblem(body: string): string | null {
  let polls = 0;
  for (const paragraph of paragraphs(body)) {
    const lines = paragraph.trim().split("\n");
    if (!lines.some((line) => STARTS_POLL.test(line.trim()))) continue;
    const poll = readShape(paragraph);
    if (!poll || !STARTS_POLL.test(lines[0].trim()) || lines.slice(1).some((line) => STARTS_POLL.test(line.trim()))) {
      return `A poll is a paragraph of its own: ${POLL_LINE}, a space and the question on its first line, then one answer a line, each starting with "- ".`;
    }
    const problem = shapeProblem(poll);
    if (problem) return problem;
    polls += 1;
  }
  return polls > 1 ? "An email holds one poll. Take the others out, or send them in emails of their own." : null;
}

/** What the designer adds for a new poll: the parts to write marked, so it cannot go until they are written (lib/mail-body.ts). */
export const POLL_STARTER = `${POLL_LINE} ⟦Your question⟧\n- ⟦An answer⟧\n- ⟦Another answer⟧`;

/**
 * The email's text with its poll drawn for one reader: the question as a
 * heading, each answer as a button to `linkFor(answer's place)`, then `note`.
 * Every other paragraph is left exactly as written.
 */
export function withPollLinks(body: string, linkFor: (answer: number) => string, note = ""): string {
  return paragraphs(body)
    .map((paragraph) => {
      if (!isPollParagraph(paragraph)) return paragraph;
      const poll = readShape(paragraph) as MailPoll;
      return [`# ${poll.question}`, ...poll.answers.map((answer, i) => `[${answer}](${linkFor(i)})`), ...(note ? [note.replace(/\s+/g, " ").trim()] : [])].join("\n\n");
    })
    .join("\n\n");
}

/** Where an answer leads in a preview or a test email: a page that says only the email a reader gets records an answer. */
export const POLL_PREVIEW_URL = `${SITE_URL}/poll?preview=1`;

/** The email as the designer and a test email show it: the answers as buttons to the preview page, nothing that records. */
export function pollPreviewBody(body: string, note = ""): string {
  return withPollLinks(body, () => POLL_PREVIEW_URL, note);
}

/** The poll on a web page (a published letter, lib/letters.ts): the question and its answers as a list, with no link that records. */
export function pollOnWeb(body: string): string {
  return paragraphs(body)
    .map((paragraph) => {
      if (!isPollParagraph(paragraph)) return paragraph;
      const poll = readShape(paragraph) as MailPoll;
      return [`# ${poll.question}`, poll.answers.map((answer) => `- ${answer}`).join("\n")].join("\n\n");
    })
    .join("\n\n");
}
