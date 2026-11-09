/**
 * The words people write in a store's community, and every limit on them.
 *
 * Nothing here touches the network or Redis, so the studio and the composer
 * in the browser read the very numbers the server enforces, and a limit can
 * never be one thing on the page and another in the code.
 *
 * What a member writes is plain text and stays plain text. It is never put
 * into a page as HTML: React writes it as text, so a "<script>" typed into a
 * post is shown as those eight characters and does nothing. The one thing
 * turned into something else is a web address. `segments` cuts a text into
 * words and addresses, and an address becomes a link only when it is an
 * ordinary http or https address — never javascript:, data: or anything a
 * browser would run — and the link is marked as the member's, not ours
 * (rel="nofollow ugc noopener noreferrer"), and opens in a new tab.
 *
 * Every number below is published to the creator in the studio. They are
 * generous for a real community and tight for a script: a person does not
 * write six posts in an hour, and a spammer who can is stopped at five.
 */

/** Spaces (Stan calls them categories) one community may have. */
export const MAX_SPACES = 20;
export const MAX_SPACE_NAME = 40;
export const MAX_SPACE_ABOUT = 160;

/** The community's own name and the line under it. */
export const MAX_COMMUNITY_NAME = 60;
export const MAX_COMMUNITY_ABOUT = 300;

/** A post: an optional title, the text, and one picture. */
export const MAX_POST_TITLE = 120;
export const MAX_POST_TEXT = 5_000;
/** A comment or a reply to one. */
export const MAX_COMMENT_TEXT = 2_000;
/** Addresses one post, or one comment, may carry: past this it reads as spam. */
export const MAX_LINKS_IN_POST = 10;
export const MAX_LINKS_IN_COMMENT = 5;

/** The name a member chooses to be seen by. Never their email address. */
export const MAX_DISPLAY_NAME = 40;

/**
 * Welcoming a new member: up to MAX_QUESTIONS questions the creator asks,
 * answered once before a member's first post or comment, and one message
 * sent to them privately the first time they come in.
 */
export const MAX_QUESTIONS = 3;
export const MAX_QUESTION = 200;
export const MAX_ANSWER = 500;
export const MAX_WELCOME = 1_000;

/** How many posts may be pinned to the top of the feed at once. */
export const MAX_PINNED = 3;
/** Every post a community holds, and every comment under one post. */
export const MAX_POSTS = 10_000;
export const MAX_COMMENTS_PER_POST = 300;
/** Everyone who has ever come in: a record each, for their name and choices. */
export const MAX_MEMBERS = 50_000;
/** Reported posts and comments waiting for the creator. */
export const MAX_REPORT_QUEUE = 500;

/** Posts on one page of a feed, and members on one page of the directory. */
export const FEED_PAGE = 20;
export const DIRECTORY_PAGE = 60;

/**
 * What one member may do, per community. The creator is never limited:
 * it is their community, and they are the one spam would be aimed at.
 */
export const RATE_LIMITS = {
  post: { limit: 5, seconds: 60 * 60, words: "5 posts an hour" },
  postDay: { limit: 20, seconds: 24 * 60 * 60, words: "20 posts a day" },
  comment: { limit: 30, seconds: 60 * 60, words: "30 comments an hour" },
  like: { limit: 200, seconds: 60 * 60, words: "200 likes an hour" },
  report: { limit: 20, seconds: 24 * 60 * 60, words: "20 reports a day" },
  upload: { limit: 10, seconds: 60 * 60, words: "10 pictures an hour" },
  rsvp: { limit: 30, seconds: 60 * 60, words: "30 RSVPs or canceled RSVPs an hour" },
  challenge: { limit: 30, seconds: 60 * 60, words: "30 challenge joins or check-ins an hour" },
  dm: { limit: 60, seconds: 60 * 60, words: "60 messages an hour" },
  dmNew: { limit: 10, seconds: 24 * 60 * 60, words: "10 new conversations a day" },
} as const;

export type RateKind = keyof typeof RATE_LIMITS;

/**
 * Live events inside the community (lib/community-events.ts): how many may
 * be coming up at once, how many are kept in all (the ones that are over
 * stay, with their replays, until this many are kept; then the oldest one
 * that is over makes room), what one may say, how long one lasts, and how
 * many people one may take.
 */
export const MAX_UPCOMING_EVENTS = 50;
export const MAX_KEPT_EVENTS = 500;
export const MAX_EVENT_TITLE = 120;
export const MAX_EVENT_ABOUT = 3_000;
export const EVENT_LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240] as const;
export const MAX_EVENT_CAP = 5_000;
/** How far ahead an event may be put. */
export const MAX_EVENT_AHEAD_DAYS = 365;
/** The way in shows this many minutes before the start, and until the end. */
export const JOIN_EARLY_MINUTES = 15;
/** Events a creator may schedule or change in an hour: a person is nowhere near it. */
export const EVENT_WRITES_PER_HOUR = 60;

/**
 * Challenges inside the community (lib/community-challenges.ts): how many may
 * be on (not yet over) at once, how many are kept in all, how long one runs,
 * how far ahead it may be put, what one may say, and how long one that is
 * over stays for its members to see before it is let go.
 */
export const MAX_OPEN_CHALLENGES = 3;
export const MAX_KEPT_CHALLENGES = 20;
export const MAX_CHALLENGE_DAYS = 90;
export const MAX_CHALLENGE_AHEAD_DAYS = 365;
export const MAX_CHALLENGE_TITLE = 120;
export const MAX_CHALLENGE_ABOUT = 1_000;
export const MAX_CHALLENGE_TASK = 300;
export const CHALLENGE_KEEP_DAYS = 30;
/** Challenges a creator may make or delete in an hour: a person is nowhere near it. */
export const CHALLENGE_WRITES_PER_HOUR = 30;

/** Ids of spaces, posts and comments: short, random, and nothing else. */
export const ITEM_ID = /^[0-9a-f]{12}$/;
export const COMMUNITY_ID = /^[0-9a-f]{32}$/;

// An address starts with http:// or https:// and runs to the next space or
// to a character that cannot sit in one unescaped.
const URL_PATTERN = /(https?:\/\/[^\s<>"'`]+)/gi;
/** Punctuation that ends a sentence rather than an address. */
const TRAILING = new Set([".", ",", "!", "?", ";", ":", "*"]);

/**
 * How many characters at the end of `text` are in `set`, counted from the
 * end in one pass. A regular expression anchored at the end ("[.,]+$") does
 * the same job in time that grows with the square of a long run of those
 * characters that does not reach the end, which a member could post.
 */
function trailingRun(text: string, set: Set<string>): number {
  let n = 0;
  while (n < text.length && set.has(text[text.length - 1 - n])) n += 1;
  return n;
}

export type Segment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

/** A web address a member typed, as a link, or null when it is not a safe one. */
export function safeHref(raw: string): string | null {
  if (raw.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || !url.hostname.includes(".")) return null;
  // Credentials in an address are only ever there to mislead the reader.
  if (url.username || url.password) return null;
  return url.href;
}

/**
 * A text cut into plain words and links, in order. A closing bracket at the
 * end of an address is kept only when the address opened one, so
 * "(see https://example.com/a)" links to the address and not to "a)".
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const push = (piece: string) => {
    if (!piece) return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += piece;
    else out.push({ kind: "text", text: piece });
  };
  let at = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    const cut = trailingRun(candidate, TRAILING);
    let tail = candidate.slice(candidate.length - cut);
    candidate = candidate.slice(0, candidate.length - cut);
    // Closing brackets the address did not open are left outside it. Counted
    // once, then trimmed in one pass: a long run of ")" costs its length,
    // not its length squared.
    let open = 0;
    let close = 0;
    for (const ch of candidate) {
      if (ch === "(") open += 1;
      else if (ch === ")") close += 1;
    }
    let drop = 0;
    while (drop < candidate.length && candidate[candidate.length - 1 - drop] === ")" && open < close - drop) drop += 1;
    if (drop) {
      tail = `${candidate.slice(candidate.length - drop)}${tail}`;
      candidate = candidate.slice(0, candidate.length - drop);
    }
    push(text.slice(at, start));
    const href = safeHref(candidate);
    if (href) out.push({ kind: "link", text: candidate, href });
    else push(candidate);
    push(tail);
    at = start + match[0].length;
  }
  push(text.slice(at));
  return out;
}

/** How many addresses a text carries. */
export function linkCount(text: string): number {
  return segments(text).filter((s) => s.kind === "link").length;
}

/**
 * Text a member sent, made fit to keep: line endings made one kind, the
 * characters that only exist to hide or reorder text taken out, runs of
 * blank lines folded to one, and cut to its limit.
 */
export function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // Cut to a little over the limit first: nothing past it is kept, and every
  // step below then costs time in proportion to what can be kept, never to
  // whatever size a form was sent with.
  return raw
    .slice(0, max * 2 + 1_000)
    .replace(/\r\n?/g, "\n")
    // Control characters, zero-width characters and the ones that flip the
    // direction of text: none has a use in a post, and each can disguise one.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "")
    // Spaces at the end of each line, removed line by line: the pattern
    // "[ \t]+\n" does it in time that grows with the square of a long run of
    // spaces that is not followed by a line break.
    .split("\n")
    .map((line) => line.slice(0, line.length - trailingRun(line, SPACES)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

const SPACES = new Set([" ", "\t"]);

/** A one-line name: a display name, a space's name, a title. */
export function cleanLine(raw: unknown, max: number): string {
  return cleanText(raw, max * 2).replace(/\s+/g, " ").trim().slice(0, max);
}

/** "just now", "5 min ago", "3 h ago", "Sep 4", "Sep 4, 2025". */
export function whenWords(seconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const ago = Math.max(0, nowSeconds - seconds);
  if (ago < 60) return "just now";
  if (ago < 3_600) return `${Math.floor(ago / 60)} min ago`;
  if (ago < 86_400) return `${Math.floor(ago / 3_600)} h ago`;
  if (ago < 7 * 86_400) return `${Math.floor(ago / 86_400)} d ago`;
  const date = new Date(seconds * 1000);
  const sameYear = date.getUTCFullYear() === new Date(nowSeconds * 1000).getUTCFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** The letter in a member's round badge: the first of their name, or a dot. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0] ?? "";
  return /\p{L}|\p{N}/u.test(first) ? first.toUpperCase() : "•";
}
