/**
 * AI topic ideas for a community, 286 [SX2], unit 1: the rules, pure. No
 * model is asked, nothing is read or written and nothing is drawn yet; the
 * call (cheapest current model, capped input and output, its cost reserved
 * from the store's own monthly budget before it is made) and the studio
 * list are later units.
 *
 * What the ideas may be made from is only the store's own content: the
 * titles of its published courses and their lessons, the posts members wrote
 * that nobody has answered yet, and the events it has coming. Never who
 * wrote a post, and never an address, phone number or link (cleanReviewText).
 *
 * The model only proposes: it is handed the sources by number and returns a
 * few short ideas, each with the numbers of the sources it comes from. An
 * idea is kept only when it has a word that carries meaning and every such
 * word is found in those sources (a few plain words that frame a post, like "tips" or
 * "questions", excepted), and when it has no figure, link, address, handle
 * or word of a deal or of pressure (heldToFacts, with no facts: none may
 * pass). The creator reads, edits and posts them; nothing is posted alone.
 *
 * An idea whose sources are gone since (a post deleted, hidden or answered,
 * an event canceled or over, a course unpublished) is dropped, so a
 * member's deleted words never live on in an idea.
 */
import { cleanReviewText } from "@/lib/review-ai-summary-rules";
import { heldToFacts } from "@/lib/store-assistant-rules";

/** The most ideas shown at once. */
export const MAX_IDEAS = 5;
/** The longest idea, in characters. */
export const MAX_IDEA_TITLE = 80;
/** Made at most once a week for a community. */
export const IDEAS_REFRESH_SECONDS = 7 * 86_400;
/** Fewer sources than this and there is too little to suggest from. */
export const MIN_IDEA_SOURCES = 3;
/** The most bytes of sources sent in one request, so one list stays a small job. */
export const MAX_IDEA_INPUT_BYTES = 8_000;
/** Members' posts older than this are not read as open questions. */
export const QUESTION_WINDOW_SECONDS = 30 * 86_400;
/** Events further ahead than this are not read. */
export const EVENT_WINDOW_SECONDS = 30 * 86_400;
const MAX_EVENTS = 5;
const MAX_QUESTIONS = 15;
const MAX_COURSES = 10;

export type IdeaCourse = { title: string; lessons: readonly string[]; draft: boolean };
/** A community post as these rules read it; `replies` is how many visible replies it has. */
export type IdeaPost = { a: string; title: string; text: string; at: number; kind: "post" | "announcement"; hid: boolean; replies: number };
/** An event as these rules read it; `start` in milliseconds. */
export type IdeaEvent = { title: string; start: number; cancelled: boolean };
export type IdeaSource = { id: number; kind: "event" | "question" | "course"; text: string };
export type TopicIdea = { title: string; from: number[] };

const isText = (v: unknown): v is string => typeof v === "string";
/** Whether cleaned words still say something once the taken-out parts are set aside. */
const saysSomething = (text: string) => text.replace(/\[(email|link|number|handle)\]/g, "").replace(/[\s.,;:]+/g, "").length >= 2;

function courseText(c: IdeaCourse): string {
  const lessons = (Array.isArray(c.lessons) ? c.lessons : []).filter(isText).map((l) => l.trim()).filter(Boolean);
  return cleanReviewText(lessons.length ? `${c.title.trim()}: ${lessons.join("; ")}` : c.title);
}

function questionText(p: IdeaPost): string {
  const title = p.title.trim();
  const text = p.text.trim();
  if (!title || !text) return cleanReviewText(title || text);
  return cleanReviewText(/[.?!]$/.test(title) ? `${title} ${text}` : `${title}. ${text}`);
}

/**
 * The sources sent for one community, numbered from 1: events coming in the
 * next 30 days, soonest first; members' posts of the last 30 days with no
 * visible reply, newest first; published courses with their lessons. Each
 * kind and the whole are capped. A shape not known is read as nothing.
 */
export function ideaSources(
  content: { courses: readonly IdeaCourse[]; posts: readonly IdeaPost[]; events: readonly IdeaEvent[] },
  nowMs: number,
): IdeaSource[] {
  const list = <T>(v: readonly T[] | unknown): T[] => (Array.isArray(v) ? (v as T[]).filter((x) => x && typeof x === "object") : []);
  const nowS = Math.floor(nowMs / 1000);
  const events = list<IdeaEvent>(content?.events)
    .filter((e) => isText(e.title) && typeof e.start === "number" && e.cancelled === false && e.start > nowMs && e.start <= nowMs + EVENT_WINDOW_SECONDS * 1000)
    .sort((a, b) => a.start - b.start)
    .map((e) => ({ kind: "event" as const, text: cleanReviewText(e.title) }))
    .filter((s) => saysSomething(s.text))
    .slice(0, MAX_EVENTS);
  const questions = list<IdeaPost>(content?.posts)
    .filter((p) => isText(p.a) && p.a !== "CREATOR" && p.kind === "post" && p.hid === false && p.replies === 0 && isText(p.title) && isText(p.text) && typeof p.at === "number" && p.at <= nowS && nowS - p.at <= QUESTION_WINDOW_SECONDS)
    .sort((a, b) => b.at - a.at)
    .map((p) => ({ kind: "question" as const, text: questionText(p) }))
    .filter((s) => saysSomething(s.text))
    .slice(0, MAX_QUESTIONS);
  const courses = list<IdeaCourse>(content?.courses)
    .filter((c) => isText(c.title) && c.draft === false)
    .map((c) => ({ kind: "course" as const, text: courseText(c) }))
    .filter((s) => saysSomething(s.text))
    .slice(0, MAX_COURSES);
  const out: IdeaSource[] = [];
  let bytes = 0;
  for (const s of [...events, ...questions, ...courses]) {
    const size = Buffer.byteLength(s.text) + 1;
    if (bytes + size > MAX_IDEA_INPUT_BYTES) break;
    bytes += size;
    out.push({ id: out.length + 1, ...s });
  }
  return out;
}

/** Whether ideas may be made now: enough sources, and none made in the last week. */
export function mayMakeIdeas(sources: readonly IdeaSource[], lastAt: number, nowSeconds: number): boolean {
  return sources.length >= MIN_IDEA_SOURCES && (lastAt <= 0 || nowSeconds - lastAt >= IDEAS_REFRESH_SECONDS);
}

/** The small words of English, which an idea may use without a source saying them. */
const SMALL_WORDS = new Set(["a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "at", "by", "from", "is", "are", "be", "it", "its", "as", "or", "but", "not", "no", "so", "that", "this", "these", "those", "their", "they", "you", "your", "we", "our", "my", "i", "me", "do", "does", "can", "how", "why", "what", "when", "where", "which", "who", "about", "before", "after", "into", "more"]);
/** Plain words that frame a post rather than say what it is about. */
const FRAMING_WORDS = new Set(["tips", "tip", "ideas", "idea", "questions", "question", "answers", "answer", "ask", "share", "first", "try", "next", "common", "guide", "steps", "recap", "week", "weekly", "practice", "favorite", "story", "stories", "help", "getting", "started", "start", "thoughts", "challenge", "lesson", "course", "event", "members", "community"]);
/** Numbers written in words: an idea never says one. */
const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand|million|percent)\b/i;
/** An idea as the studio may show it: plain Latin letters, no digit, simple punctuation. */
const TITLE_SHAPE = /^[A-Za-z][A-Za-z ,'’&/?:!-]*$/;
/** A word reduced to its first five letters, so "mixing" and "mix", "greens" and "green" meet. */
const stem = (word: string) => word.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);

function heldToSources(title: string, texts: readonly string[]): boolean {
  const said = new Set(texts.join(" ").toLowerCase().split(/[^a-z]+/).filter(Boolean).map(stem));
  const words = title.split(/[^A-Za-z]+/).filter((w) => w && !SMALL_WORDS.has(w.toLowerCase()) && !FRAMING_WORDS.has(w.toLowerCase()));
  // At least one word of its own: "Tips" or "Your questions" alone says nothing the sources said.
  return words.length > 0 && words.every((w) => said.has(stem(w)));
}

/**
 * The ideas kept from the model's answer `{ ideas: [{ title, from: [n…] }] }`,
 * in its order: each short, plain words held to the sources it names (at
 * least one, every one sent), no figure, link, address, handle or deal
 * word, an idea once, at most MAX_IDEAS. Anything else reads as no idea.
 */
export function readIdeas(answer: unknown, sources: readonly IdeaSource[]): TopicIdea[] {
  const byId = new Map(sources.map((s) => [s.id, s.text]));
  const raw = answer && typeof answer === "object" && Array.isArray((answer as { ideas?: unknown }).ideas) ? (answer as { ideas: unknown[] }).ideas : [];
  const out: TopicIdea[] = [];
  for (const entry of raw.slice(0, 20)) {
    if (out.length >= MAX_IDEAS) break;
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { title?: unknown; from?: unknown };
    const title = isText(value.title) ? value.title.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim() : "";
    if (!title || title.length > MAX_IDEA_TITLE || !TITLE_SHAPE.test(title) || NUMBER_WORDS.test(title) || !heldToFacts(title, "") || cleanReviewText(title) !== title) continue;
    if (out.some((i) => i.title.toLowerCase() === title.toLowerCase())) continue;
    const from = [...new Set(Array.isArray(value.from) ? value.from : [])];
    if (!from.length || !from.every((n): n is number => typeof n === "number" && byId.has(n))) continue;
    if (!heldToSources(title, from.map((n) => byId.get(n) as string))) continue;
    out.push({ title, from });
  }
  return out;
}

/**
 * The ideas still shown: each one whose every source, as it was sent, is
 * still among the community's sources now. One whose post was deleted,
 * hidden or answered, whose event was canceled or is over, or whose course
 * was unpublished or renamed since is dropped.
 */
export function ideasStillShown(ideas: readonly TopicIdea[], sent: readonly IdeaSource[], now: readonly IdeaSource[]): TopicIdea[] {
  const sentById = new Map(sent.map((s) => [s.id, s]));
  const current = new Set(now.map((s) => `${s.kind}\n${s.text}`));
  return ideas.filter((idea) =>
    idea.from.length > 0 &&
    idea.from.every((n) => {
      const s = sentById.get(n);
      return s !== undefined && current.has(`${s.kind}\n${s.text}`);
    }),
  );
}
