/**
 * A podcast's public show: the settings its public feed is written from, read exactly, the units a feed takes from
 * the store's public requests before it is sent, and the bounded cache that answers an app asking again.
 * 33 [F2], part 2 (the route is app/api/store/podcast/public/[handle]/[product]/route.ts; the feed itself is
 * lib/podcast-public-feed.ts, part 1).
 *
 *   nl:pod:<id>:public   the show's public settings: its category, explicit flag, and for each episode the
 *                        creator's mark and the https address its audio is published at
 *
 * Nothing here writes the record: the studio unit that lets a creator mark episodes public writes it (and deletes it
 * with the podcast), so until then no show has one and every public feed answers 404. A record that is there but
 * cannot be read is unknown, never "no settings" and never "no episodes" (rule 24): the route says 503.
 *
 * The audio is never ours to send in a public feed: an episode is published at the https address kept for it (where
 * the creator's audio already lives, as the RSS import records it), never at a signed address in the private file
 * store and never through a route of ours. An episode with no such address is left out.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { EPISODE_ID, MAX_EPISODES, MAX_EPISODE_NOTES, MAX_EPISODE_TITLE, PODCAST_ID, type Episode, type Podcast } from "@/lib/podcast-rules";
import type { PublicEpisodeCandidate } from "@/lib/podcast-public-feed";

const showKey = (id: string) => `nl:pod:${id}:public`;

/** The settings record read at the most: past it the record is unknown, not read on. */
export const PUBLIC_SHOW_MAX_BYTES = 768_000;
/** The longest audio address kept for an episode (the import's own cap, lib/rss-import.ts). */
const MAX_AUDIO_ADDRESS = 2_048;
/** The shape of a buyer's feed token, anywhere in an address (lib/podcast-rules.ts FEED_TOKEN). */
const TOKEN_SHAPE = /[0-9a-f]{48}/i;

/**
 * A podcast's record at its worst, in bytes, for pricing a feed built: MAX_EPISODES episodes with the longest title
 * and notes, every character written as a six-byte JSON escape, and a kilobyte each for the rest of its fields.
 */
export const PODCAST_RECORD_MOST = MAX_EPISODES * (6 * (MAX_EPISODE_TITLE + MAX_EPISODE_NOTES) + 1_024);

/**
 * Units of the store's public requests (lib/traffic.ts) a feed built takes besides the bytes it reads: its call at the
 * heavy shape with PUBLIC_FEED_READ_COMMANDS commands, and the store's record and the listing at their largest
 * (MAX_STORE_BYTES, MAX_PRODUCT_BYTES), read and worked through. tests/f2-public-feed-route.test.ts holds every unit
 * here above what it pays for.
 */
export const PUBLIC_FEED_BUILD_UNITS = 3;
/** Bytes each further unit pays for: of the podcast and its settings read and worked through, or of the feed written and sent. */
export const PUBLIC_FEED_BYTES_PER_UNIT = 256_000;
/** Commands a feed built reads with at the most: the store's address and record, the listing, the podcast, the settings. */
export const PUBLIC_FEED_READ_COMMANDS = 8;
/** How long a feed is kept on a server before it is built again from the records. */
export const PUBLIC_FEED_CACHE_SECONDS = 300;
/** Feeds kept on one server at once, and their bytes together. */
export const PUBLIC_FEED_CACHE_ENTRIES = 256;
export const PUBLIC_FEED_CACHE_BYTES = 32_000_000;

/** Units of `bytes` at PUBLIC_FEED_BYTES_PER_UNIT each, rounded up; null for a size that is not one. */
export function byteUnits(bytes: number): number | null {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return Math.ceil(bytes / PUBLIC_FEED_BYTES_PER_UNIT);
}

/**
 * Units a feed of `bytes` takes to be sent: one at least, which also pays the request of a kept feed and a "not
 * modified" answer, then one per PUBLIC_FEED_BYTES_PER_UNIT; null for a size that is not one.
 */
export function sendUnits(bytes: number): number | null {
  const units = byteUnits(bytes);
  return units === null ? null : Math.max(1, units);
}

/** The units a feed built is held at before anything past the store is read: its base and its records at their largest. */
export const PUBLIC_FEED_HOLD_UNITS = PUBLIC_FEED_BUILD_UNITS + Math.ceil((PODCAST_RECORD_MOST + PUBLIC_SHOW_MAX_BYTES) / PUBLIC_FEED_BYTES_PER_UNIT);

/** What a feed built really took, from the bytes of the podcast and of its settings read: its base and their units. */
export function buildUnits(readBytes: number): number | null {
  const units = byteUnits(readBytes);
  return units === null ? null : PUBLIC_FEED_BUILD_UNITS + units;
}

/** One episode's public entry as stored: the creator's mark, and the address its audio is published at. */
type PublicEntry = { visibility: unknown; audio: unknown };

export type PublicShow = {
  category: unknown;
  explicit: unknown;
  /** Each episode's entry by its id; an episode with none is not public. */
  episodes: Map<string, PublicEntry>;
  /** The record's size as read, in bytes. */
  bytes: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The settings from the stored text, or null when the text is not a record of them: not JSON, not an object, or
 * episodes that are not an object of entries. What an entry holds is read as stored and judged by the feed: a mark
 * that is not exactly "public" is not public, so a bent entry leaves its episode out, never the others.
 */
export function parsePublicShow(raw: string): PublicShow | null {
  if (raw.length > PUBLIC_SHOW_MAX_BYTES) return null;
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > PUBLIC_SHOW_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || !isObject(value.episodes)) return null;
  const episodes = new Map<string, PublicEntry>();
  for (const [id, entry] of Object.entries(value.episodes)) {
    episodes.set(id, isObject(entry) ? { visibility: entry.visibility, audio: entry.audio } : { visibility: undefined, audio: undefined });
  }
  return { category: value.category, explicit: value.explicit, episodes, bytes };
}

/**
 * A podcast's public settings: null only when Redis says there are none (an exact null). Any other reply (none,
 * several, not text, text that is not a record of them, over PUBLIC_SHOW_MAX_BYTES) throws UnknownReplyError.
 */
export async function readPublicShow(podcastId: string): Promise<PublicShow | null> {
  if (!PODCAST_ID.test(podcastId)) return null;
  if (!isRedisConfigured()) throw new UnknownReplyError("a podcast's public settings (no database)");
  const replies = repliesFor(await redisPipeline([["GET", showKey(podcastId)]]), 1);
  if (!replies) throw new UnknownReplyError("a podcast's public settings");
  const raw = replies[0];
  if (raw === null) return null;
  const show = typeof raw === "string" ? parsePublicShow(raw) : null;
  if (!show) throw new UnknownReplyError("a podcast's public settings");
  return show;
}

/** A published audio address: https, a host, no credentials, not too long, and nothing that could name a buyer. */
function publishedAudio(address: unknown): string | null {
  if (typeof address !== "string" || address.length > MAX_AUDIO_ADDRESS || !/^https:\/\//i.test(address)) return null;
  if (TOKEN_SHAPE.test(address) || address.includes("@") || /%40/i.test(address)) return null;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "" ? address : null;
  } catch {
    return null;
  }
}

/**
 * The podcast's episodes as the public feed's candidates, each with the creator's mark as stored, and the audio
 * address of each: an episode with no entry, or whose audio address is not one a public feed may carry, is offered
 * with no mark, so the feed leaves it out (a bad address never takes the whole feed down).
 */
export function publicCandidates(podcast: Podcast, show: PublicShow): { candidates: PublicEpisodeCandidate[]; audio: Map<string, string> } {
  const audio = new Map<string, string>();
  const candidates = podcast.episodes.map((episode: Episode): PublicEpisodeCandidate => {
    const entry = EPISODE_ID.test(episode.id) ? show.episodes.get(episode.id) : undefined;
    const address = entry ? publishedAudio(entry.audio) : null;
    if (!entry || !address) return { episode, visibility: undefined };
    audio.set(episode.id, address);
    return { episode, visibility: entry.visibility };
  });
  return { candidates, audio };
}

/** The ETag of a feed: its bytes' digest, quoted. */
export function etagOf(xml: string): string {
  return `"${createHash("sha256").update(xml, "utf8").digest("hex").slice(0, 32)}"`;
}

/** Whether an If-None-Match header names this tag (or any). */
export function matchesTag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const tag = part.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

/** A feed kept: the store it is counted against, the XML, its tag and its size in bytes. */
export type KeptFeed = { store: Store; xml: string; etag: string; bytes: number };

const kept = new Map<string, { feed: KeptFeed; until: number }>();
let keptBytes = 0;

function drop(key: string): void {
  const held = kept.get(key);
  if (!held) return;
  kept.delete(key);
  keptBytes -= held.feed.bytes;
}

/** The feed kept under `key`, while it is fresh; null otherwise. */
export function cachedFeed(key: string, now: number): KeptFeed | null {
  const held = kept.get(key);
  if (!held) return null;
  if (now >= held.until) {
    drop(key);
    return null;
  }
  return held.feed;
}

/**
 * Keeps a feed PUBLIC_FEED_CACHE_SECONDS, letting the oldest go first so that at most PUBLIC_FEED_CACHE_ENTRIES feeds
 * and PUBLIC_FEED_CACHE_BYTES bytes are held. A feed larger than the whole cache is not kept.
 */
export function keepFeed(key: string, feed: KeptFeed, now: number): void {
  drop(key);
  if (!Number.isSafeInteger(feed.bytes) || feed.bytes < 0 || feed.bytes > PUBLIC_FEED_CACHE_BYTES) return;
  for (const oldest of kept.keys()) {
    if (kept.size < PUBLIC_FEED_CACHE_ENTRIES && keptBytes + feed.bytes <= PUBLIC_FEED_CACHE_BYTES) break;
    drop(oldest);
  }
  kept.set(key, { feed, until: now + PUBLIC_FEED_CACHE_SECONDS * 1000 });
  keptBytes += feed.bytes;
}

/** Forgets every kept feed (tests). */
export function forgetPublicFeeds(): void {
  kept.clear();
  keptBytes = 0;
}
