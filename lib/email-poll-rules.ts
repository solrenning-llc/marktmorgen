/**
 * A poll answered by a click in an email (125 [F2-EMAIL-POLLS], unit 1: the
 * rules only; nothing sends a poll or keeps a vote yet).
 *
 * A creator asks their list one question in a broadcast, with 2 to 5
 * answers, each a link. What makes it honest:
 *
 *   - Opening a link is never a vote. Mail scanners at companies and schools
 *     open every link of an email before a person sees it; a vote taken on
 *     that open would count machines. The link opens a page that names the
 *     answer and asks the person to press Confirm; only that press (a POST)
 *     counts. The email says so.
 *   - One vote per recipient, through their own link: they can change it, or
 *     take it back, until the poll closes, 1 to 30 days after the email was
 *     sent (POLL_DEFAULT_DAYS unless the creator picks another).
 *   - The creator sees only the totals, never who answered what, and the
 *     email says that too.
 *   - Unknown is never a vote (rule 24): a link that could not be checked, a
 *     clock or a sending time that is not a number, a kept vote that does not
 *     read. Results with a vote that does not read are "unknown", never a
 *     count with it left out.
 *
 * Pure: no storage, no network.
 */

import { pollWords } from "@/lib/buyer-words/polls";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 5;
export const MAX_POLL_QUESTION = 200;
export const MAX_POLL_OPTION = 60;
export const POLL_DEFAULT_DAYS = 7;
export const MAX_POLL_DAYS = 30;
/**
 * Database commands one confirmed answer makes at the most (lib/email-poll-vote.ts):
 * the broadcast's record, the store's handle and record, the vote and its
 * expiry. A review ceiling.
 */
export const POLL_VOTE_COMMANDS = 5;
/**
 * Public requests of the store's month one opening of a poll's page, or one
 * confirmed answer, takes before it
 * is kept: more than its reads (the store's record at 1 MB at the most, the
 * broadcast's record) and its writes cost (POLL_VOTE_READ in
 * tests/plan-cost-registry.test.ts).
 */
export const POLL_VOTE_REQUEST_UNITS = 2;

const DAY_MS = 86_400_000;

export type EmailPoll = { question: string; options: string[]; days: number };
export type PollProblem = "question" | "options" | "days";

const tidy = (value: unknown): string | null => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : null);
const sameWords = (text: string) => text.toLowerCase();

/** A poll as the creator wrote it, checked; the words kept as written, only spaces tidied. */
export function readPollInput(raw: unknown): { ok: true; poll: EmailPoll } | { ok: false; problem: PollProblem } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "question" };
  const value = raw as Record<string, unknown>;
  const question = tidy(value.question);
  if (!question || question.length > MAX_POLL_QUESTION) return { ok: false, problem: "question" };
  if (!Array.isArray(value.options) || value.options.length < MIN_POLL_OPTIONS || value.options.length > MAX_POLL_OPTIONS) return { ok: false, problem: "options" };
  const options: string[] = [];
  for (const raw of value.options) {
    const option = tidy(raw);
    if (!option || option.length > MAX_POLL_OPTION || options.some((o) => sameWords(o) === sameWords(option))) return { ok: false, problem: "options" };
    options.push(option);
  }
  const days = value.days === undefined || value.days === null || value.days === "" ? POLL_DEFAULT_DAYS : typeof value.days === "string" && /^\d{1,2}$/.test(value.days) ? Number(value.days) : value.days;
  if (!isDays(days)) return { ok: false, problem: "days" };
  return { ok: true, poll: { question, options, days } };
}

const isDays = (days: unknown): days is number => typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_POLL_DAYS;

/** When a poll sent at `sentAt` closes; null when that is not known. */
export function pollClosesAt(sentAt: number, days: number): number | null {
  return Number.isFinite(sentAt) && isDays(days) ? sentAt + days * DAY_MS : null;
}

/** Open from its sending until it closes; anything not known is "unknown", never open. */
export function pollState(sentAt: number, days: number, now: number): "open" | "closed" | "unknown" {
  const closes = pollClosesAt(sentAt, days);
  if (closes === null || !Number.isFinite(now) || now < sentAt) return "unknown";
  return now < closes ? "open" : "closed";
}

export type VoteStep = { step: "confirm"; option: number } | { step: "record"; option: number } | { step: "withdraw" } | { step: "closed" } | { step: "invalid" } | { step: "unknown" };

/**
 * What a request to a recipient's poll link does. `recipient` is whether the
 * link's token was checked as that recipient's ("valid"), was not ("invalid")
 * or could not be checked ("unknown"). GET and HEAD only show the confirm
 * page; a POST with an answer records it, a POST with none takes the vote
 * back.
 */
export function voteStep(input: {
  method: string;
  option: number | null;
  poll: EmailPoll;
  sentAt: number;
  now: number;
  recipient: "valid" | "invalid" | "unknown";
}): VoteStep {
  const { method, option, poll } = input;
  const reading = method === "GET" || method === "HEAD";
  if (!reading && method !== "POST") return { step: "invalid" };
  if (input.recipient === "invalid") return { step: "invalid" };
  if (input.recipient !== "valid") return { step: "unknown" };
  const state = pollState(input.sentAt, poll.days, input.now);
  if (state === "unknown") return { step: "unknown" };
  if (state === "closed") return { step: "closed" };
  if (method === "POST" && option === null) return { step: "withdraw" };
  if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= poll.options.length) return { step: "invalid" };
  return reading ? { step: "confirm", option } : { step: "record", option };
}

/**
 * The totals from the kept votes (one per recipient, each the index of an
 * answer as text), never who: null for a list that could not be read, and
 * "unknown" for any vote that does not read, never a count without it.
 */
export function tallyPoll(optionCount: number, votes: readonly unknown[] | null): { known: true; counts: number[]; votes: number } | { known: false } {
  if (!votes || !Number.isInteger(optionCount) || optionCount < MIN_POLL_OPTIONS || optionCount > MAX_POLL_OPTIONS) return { known: false };
  const counts = Array.from({ length: optionCount }, () => 0);
  for (const vote of votes) {
    if (typeof vote !== "string" || !/^\d$/.test(vote) || Number(vote) >= optionCount) return { known: false };
    counts[Number(vote)] += 1;
  }
  return { known: true, counts, votes: votes.length };
}

const HTML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const html = (text: string) => text.replace(/[&<>"']/g, (c) => HTML[c]);

/**
 * The poll in a recipient's email, in the store's language: the question,
 * each answer as its own link named by its words, what answering means and
 * when it closes. `linkFor` gives this recipient's link for an answer. The
 * HTML takes the email's own text color, so its links read as the rest of
 * the email does (lib/email-theme.ts, 7:1); each answer is a target of at
 * least 44 px.
 */
export function pollEmailBlock(poll: EmailPoll, linkFor: (option: number) => string, sentAt: number, language: unknown): { text: string; html: string } {
  const w = pollWords(language);
  const closes = pollClosesAt(sentAt, poll.days);
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const until = closes === null ? null : w.until(`${new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(closes)} (UTC)`);
  const notes = [w.emailHow, ...(until ? [until] : []), w.totalsOnly];
  const text = [poll.question, ...poll.options.map((option, i) => `${option}: ${linkFor(i)}`), "", ...notes].join("\n");
  const answers = poll.options
    .map((option, i) => `<li style="margin:0 0 8px"><a href="${html(linkFor(i))}" style="display:inline-block;min-height:20px;padding:12px 16px;border:1px solid currentColor;border-radius:8px;color:inherit;text-decoration:underline">${html(option)}</a></li>`)
    .join("");
  const block = `<div style="margin:24px 0 0;padding:16px 0 0;border-top:1px solid currentColor"><p style="margin:0 0 12px;font-weight:700">${html(poll.question)}</p><ul style="list-style:none;margin:0 0 12px;padding:0">${answers}</ul>${notes.map((n) => `<p style="margin:0 0 8px;font-size:14px">${html(n)}</p>`).join("")}</div>`;
  return { text, html: block };
}
