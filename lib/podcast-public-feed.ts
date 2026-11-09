/**
 * A public podcast feed, as a pure rule: the RSS 2.0 + iTunes document a podcast directory or any app may read,
 * holding only the episodes the creator marked public. 33 [F2], part 1.
 *
 * The private per-buyer feed (lib/podcast-rules.ts, feedXml) is a different document and is not touched here: it
 * keeps its `itunes:block`, its per-buyer audio addresses and its exact bytes (tests/f2-public-feed.test.ts holds them).
 * This one has no `itunes:block`, carries the category, language, image and explicit flag a directory asks for, and
 * never anything about a buyer.
 *
 * What may appear is decided only by an exact mark: an episode whose visibility is not exactly "public" is left out,
 * so a paid episode, a private one and one whose mark is missing or unreadable never appear (rule 24: unknown is never
 * public). A public episode whose size, type, date, title or id cannot be read is left out too, never written with a
 * size of zero, and the left-out list says why for the editor to show. A date is written only in RFC 822 form
 * (lib/rfc822-date.ts); one that has none (past year 9999) is left out as date-unknown, never "Invalid Date".
 *
 * No route serves this yet and nothing here makes a request: serving a public feed opens audience bandwidth, a cost
 * that needs its own ceiling and cost line (MR) before it is switched on, in a later unit.
 */
import { EPISODE_ID, EPISODE_TYPES, MAX_EPISODES, MAX_EPISODE_NOTES, MAX_EPISODE_TITLE, type Episode } from "./podcast-rules";
import { formatRfc822Date } from "./rfc822-date";

/** Apple Podcasts' top-level categories, which Spotify and the other directories read from the same tag. */
export const PUBLIC_CATEGORIES = [
  "Arts",
  "Business",
  "Comedy",
  "Education",
  "Fiction",
  "Government",
  "Health & Fitness",
  "History",
  "Kids & Family",
  "Leisure",
  "Music",
  "News",
  "Religion & Spirituality",
  "Science",
  "Society & Culture",
  "Sports",
  "Technology",
  "True Crime",
  "TV & Film",
] as const;
export type PublicCategory = (typeof PUBLIC_CATEGORIES)[number];

export const MAX_SHOW_TITLE = 255;
export const MAX_SHOW_SUMMARY = 4_000;
export const MAX_SHOW_AUTHOR = 255;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;
/** The shape of a buyer's feed token (lib/podcast-rules.ts FEED_TOKEN), anywhere in an address. */
const TOKEN_SHAPE = /[0-9a-f]{48}/i;

/** One episode offered to the public feed, with the creator's mark as stored: only exactly "public" counts. */
export type PublicEpisodeCandidate = { episode: Episode; visibility: unknown };

export type LeftOutReason = "not-public" | "bad-id" | "no-title" | "title-too-long" | "notes-too-long" | "size-unknown" | "type-unknown" | "date-unknown";

export type PublicFeedInput = {
  title: string;
  summary: string;
  author: string;
  /** The show's public page, https. */
  page: string;
  /** The cover, https, or none. */
  image: string | null;
  category: PublicCategory;
  explicit: boolean;
  /** As RSS writes one ("es-es"); "en-us" unless given. */
  language?: string;
  episodes: readonly PublicEpisodeCandidate[];
  /** The public address of an episode's audio: https, and never a buyer's token or address. */
  audio: (episode: Episode) => string;
};

export type PublicFeedRefusal = "title" | "summary" | "author" | "not-https" | "buyer-data" | "category" | "explicit" | "language" | "too-many-episodes";

/** Thrown when the feed cannot be written as asked: nothing is published half right. */
export class PublicFeedError extends Error {
  constructor(
    readonly reason: PublicFeedRefusal,
    detail: string,
  ) {
    super(detail);
    this.name = "PublicFeedError";
  }
}

const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Text as XML character data or an attribute value: characters XML forbids dropped, the five specials escaped. */
function text(value: string): string {
  return value
    .replace(NOT_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isHttps(address: string): boolean {
  if (!/^https:\/\//i.test(address)) return false;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Whether an address could name a buyer: a feed token or an email address, written plainly or %-escaped. Every store
 * page is /@<handle>, so an "@" right after a slash names a store and is let through; an "@" anywhere else could be an
 * email's and is not. An address whose escapes do not read is taken as naming somebody.
 */
function namesSomebody(address: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(address);
  } catch {
    return true;
  }
  return TOKEN_SHAPE.test(address) || TOKEN_SHAPE.test(decoded) || /(^|[^/])@/.test(address) || /(^|[^/])@/.test(decoded);
}

/** A public address: https, and nothing that could name a buyer (a feed token, an email address). */
function publicAddress(address: unknown, what: string): string {
  if (typeof address !== "string" || !isHttps(address)) throw new PublicFeedError("not-https", `The ${what} address must start with https://.`);
  if (namesSomebody(address)) {
    throw new PublicFeedError("buyer-data", `The ${what} address holds something that could name a buyer, so it is not published.`);
  }
  return address;
}

function why(candidate: PublicEpisodeCandidate): LeftOutReason | null {
  if (candidate.visibility !== "public") return "not-public";
  const e = candidate.episode;
  if (typeof e.id !== "string" || !EPISODE_ID.test(e.id)) return "bad-id";
  if (typeof e.title !== "string" || e.title.trim() === "") return "no-title";
  if (e.title.length > MAX_EPISODE_TITLE) return "title-too-long";
  if (typeof e.notes !== "string" || e.notes.length > MAX_EPISODE_NOTES) return "notes-too-long";
  if (!Number.isSafeInteger(e.bytes) || e.bytes <= 0) return "size-unknown";
  if (!(EPISODE_TYPES as readonly string[]).includes(e.contentType)) return "type-unknown";
  if (formatRfc822Date(e.at) === null) return "date-unknown";
  return null;
}

/** The episodes the public feed holds, newest first, and each one left out with its reason, in the order given. */
export function publicEpisodes(candidates: readonly PublicEpisodeCandidate[]): {
  episodes: Episode[];
  left: { id: string; reason: LeftOutReason }[];
} {
  const episodes: Episode[] = [];
  const left: { id: string; reason: LeftOutReason }[] = [];
  for (const candidate of candidates) {
    const reason = why(candidate);
    if (reason === null) episodes.push(candidate.episode);
    else left.push({ id: String(candidate.episode?.id), reason });
  }
  episodes.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { episodes, left };
}

/** The public feed. Throws PublicFeedError rather than write a feed that is wrong in any part. */
export function publicFeedXml(input: PublicFeedInput): string {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "" || title.length > MAX_SHOW_TITLE) throw new PublicFeedError("title", "The show needs a title of 1 to 255 characters.");
  if (typeof input.summary !== "string" || input.summary.length > MAX_SHOW_SUMMARY) throw new PublicFeedError("summary", "The show's description is too long.");
  if (typeof input.author !== "string" || input.author.length > MAX_SHOW_AUTHOR) throw new PublicFeedError("author", "The show's author name is too long.");
  const page = publicAddress(input.page, "show page");
  const image = input.image === null ? null : publicAddress(input.image, "cover image");
  if (!(PUBLIC_CATEGORIES as readonly unknown[]).includes(input.category)) throw new PublicFeedError("category", "Choose one of the podcast categories.");
  if (typeof input.explicit !== "boolean") throw new PublicFeedError("explicit", "Say whether the show is explicit.");
  const language = input.language === undefined ? "en-us" : input.language;
  if (typeof language !== "string" || !LANGUAGE.test(language)) throw new PublicFeedError("language", "The show's language is not one a feed can name.");
  if (input.episodes.length > MAX_EPISODES) throw new PublicFeedError("too-many-episodes", `A podcast holds at most ${MAX_EPISODES} episodes.`);

  const items = publicEpisodes(input.episodes)
    .episodes.map((e) => {
      const audio = publicAddress(input.audio(e), "episode audio");
      return `    <item>
      <title>${text(e.title.trim())}</title>
      <description>${text(e.notes)}</description>
      <guid isPermaLink="false">${text(e.id)}</guid>
      <pubDate>${formatRfc822Date(e.at)}</pubDate>
      <enclosure url="${text(audio)}" length="${e.bytes}" type="${text(e.contentType)}"/>
    </item>
`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${text(title)}</title>
    <link>${text(page)}</link>
    <description>${text(input.summary || title)}</description>
    <language>${text(language)}</language>
    <itunes:author>${text(input.author)}</itunes:author>
    <itunes:category text="${text(input.category)}"/>
    <itunes:explicit>${input.explicit ? "true" : "false"}</itunes:explicit>
${image ? `    <itunes:image href="${text(image)}"/>\n` : ""}    <itunes:type>episodic</itunes:type>
${items}  </channel>
</rss>
`;
}
