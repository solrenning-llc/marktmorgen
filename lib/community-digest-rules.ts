/**
 * The weekly community digest, its rules only (264 [CI2], unit 1; added 12
 * November 2026): what one member's email of the week holds, or that there is
 * nothing to send, or that it cannot be known. Pure and browser-safe; the box
 * a member ticks, the creator's switch, the reads and the sending are later
 * units, and none of it is on yet.
 *
 *   - Asked for only: a member gets it when they ticked the box (unticked
 *     until they do), are still let in, and have an address; and only while
 *     the creator offers it.
 *   - What that member may see, nothing else: every post and event comes with
 *     the verdict of the same gate its own page uses (lib/community-found.ts);
 *     a verdict that could not be read leaves the item out, never in.
 *   - Facts only: the week's top discussions by replies, the creator's
 *     announcements of the week, and the events coming in the next 7 days.
 *     The only numbers are counts of replies and likes, as the feed shows
 *     them. No urgency, no scarcity, no names of other members.
 *   - Nothing to say, nothing sent: an empty week is "skip", never an empty
 *     email. A list that could not be read is "unknown", never an empty week.
 *   - Once a week: the send key is the ISO week, so a retry of the same week
 *     finds it taken and never sends twice.
 *
 * No AI writes any of it: the words are the posts' own titles, cut to a
 * preview line, and the fixed sentences below. A later AI summary would be
 * labelled by the page, as every AI line is.
 */

/** The days a digest looks back at, and ahead to for events. */
export const DIGEST_DAYS = 7;
/** The most discussions one digest lists. */
export const MAX_DISCUSSIONS = 5;
/** The most announcements one digest lists. */
export const MAX_ANNOUNCEMENTS = 3;
/** The most events one digest lists. */
export const MAX_EVENTS = 3;
/** The longest preview of a post, in characters: the title, or its first words when it has none. */
export const PREVIEW_CHARS = 80;

const DAY_MS = 86_400_000;

/** A post as the digest needs it; `at` in seconds, as the feed keeps it. */
export type DigestPost = {
  id: string;
  title: string;
  text: string;
  at: number;
  kind: "post" | "announcement";
  hid: boolean;
  /** Its author: "CREATOR" or a member key. */
  a: string;
  /** Replies and likes, as the feed counts them; null when they could not be read. */
  comments: number | null;
  likes: number | null;
  /** The answer of the post's own gate for this member: true, false, or null when it could not be read. */
  canSee: boolean | null;
};

/** An event as the digest needs it; `start` in milliseconds, as events keep it. */
export type DigestEvent = {
  id: string;
  title: string;
  start: number;
  minutes: number;
  tz: string;
  cancelled: boolean;
  /** mayAttend for this member: true, false, or null when it could not be read. */
  canSee: boolean | null;
};

export type DigestReader = {
  /** Their member key. */
  key: string;
  email: string;
  /** Ticked "Email me a weekly summary": false until they do. */
  digest: boolean;
  removed: boolean;
};

export type DigestItem = { id: string; line: string; path: string };

export type Digest =
  | { kind: "send"; week: string; subject: string; discussions: DigestItem[]; announcements: DigestItem[]; events: DigestItem[]; text: string }
  | { kind: "skip"; week: string }
  | { kind: "unknown"; week: string };

/** Whether this member gets the digest at all: the creator offers it and they asked for it. */
export function getsDigest(offered: boolean, reader: DigestReader): boolean {
  return offered && reader.digest === true && !reader.removed && /\S+@\S+\.\S+/.test(reader.email);
}

/** The ISO week of a moment, in UTC: "2026-W46". The same week always gives the same key. */
export function digestWeek(now: number): string {
  const day = new Date(now);
  const date = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const weekday = date.getUTCDay() || 7;
  // The Thursday of this week decides the year the week belongs to.
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** A post's preview line: its title, or its first words; whole words, with "…" only when something was left off. */
export function previewLine(title: string, text: string): string {
  const source = (title.trim() || text).replace(/\s+/g, " ").trim();
  const chars = [...source];
  if (chars.length <= PREVIEW_CHARS) return source || "A post without words";
  const cut = chars.slice(0, PREVIEW_CHARS - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** When an event starts, in the creator's time zone and said so: "Thu, Nov 19, 5:00 PM EST". A zone that cannot be read is said as UTC. */
export function eventWhen(start: number, tz: string): string {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(start));
  try {
    return format(tz);
  } catch {
    return format("UTC");
  }
}

/**
 * One member's digest for the week of `now`. `posts` and `events` are what
 * was read for the community (null when a list could not be read); each
 * carries this member's gate verdict. `base` is the community's full
 * address ("https://marktmorgen.com/handle/community"), for the links.
 */
export function buildDigest(input: {
  communityName: string;
  base: string;
  reader: DigestReader;
  posts: readonly DigestPost[] | null;
  events: readonly DigestEvent[] | null;
  now: number;
}): Digest {
  const week = digestWeek(input.now);
  if (!input.posts || !input.events) return { kind: "unknown", week };
  const from = input.now / 1000 - DIGEST_DAYS * 86_400;
  const until = input.now / 1000;
  const seen = input.posts.filter((p) => p.canSee === true && !p.hid && p.at > from && p.at <= until);

  const announcements = seen
    .filter((p) => p.kind === "announcement")
    .sort((x, y) => y.at - x.at || x.id.localeCompare(y.id))
    .slice(0, MAX_ANNOUNCEMENTS)
    .map((p) => ({ id: p.id, line: previewLine(p.title, p.text), path: `${input.base}/post/${encodeURIComponent(p.id)}` }));

  // A discussion is someone else's post that people answered; its numbers are said only when they were read.
  const discussions = seen
    .filter((p) => p.kind === "post" && p.a !== input.reader.key && typeof p.comments === "number" && p.comments > 0)
    .sort((x, y) => (y.comments ?? 0) - (x.comments ?? 0) || (y.likes ?? 0) - (x.likes ?? 0) || y.at - x.at || x.id.localeCompare(y.id))
    .slice(0, MAX_DISCUSSIONS)
    .map((p) => ({
      id: p.id,
      line: `${previewLine(p.title, p.text)} (${count(p.comments ?? 0, "reply", "replies")}${typeof p.likes === "number" && p.likes > 0 ? `, ${count(p.likes, "like", "likes")}` : ""})`,
      path: `${input.base}/post/${encodeURIComponent(p.id)}`,
    }));

  const events = input.events
    .filter((e) => e.canSee === true && !e.cancelled && e.start > input.now && e.start <= input.now + DIGEST_DAYS * DAY_MS)
    .sort((x, y) => x.start - y.start || x.id.localeCompare(y.id))
    .slice(0, MAX_EVENTS)
    .map((e) => ({ id: e.id, line: `${previewLine(e.title, "")}: ${eventWhen(e.start, e.tz)}`, path: `${input.base}/events/${encodeURIComponent(e.id)}` }));

  if (!discussions.length && !announcements.length && !events.length) return { kind: "skip", week };

  const name = input.communityName.trim() || "your community";
  const section = (heading: string, items: DigestItem[]) => (items.length ? [heading, ...items.map((i) => `- ${i.line}\n  ${i.path}`), ""] : []);
  const text = [
    `Here is what happened in ${name} in the last ${DIGEST_DAYS} days, and what is coming in the next ${DIGEST_DAYS}.`,
    "",
    ...section("From the creator", announcements),
    ...section("Most answered posts", discussions),
    ...section("Coming up", events),
    `You get this because you asked for a weekly summary of ${name}.`,
  ].join("\n");
  return { kind: "send", week, subject: `This week in ${name}`, discussions, announcements, events, text };
}
