/**
 * A private podcast's episodes, kept (the rules are in lib/podcast-rules.ts).
 *
 *   nl:pod:<id>   the podcast: its episodes, in the order they went out
 *
 * The audio sits in the store's private file store, in the product's own
 * folder, and is never public: each play is a signed address made when the
 * buyer's app asks for it (app/api/store/podcast/play).
 */
import { randomUUID } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { newItemId } from "@/lib/course";
import { cleanLine, cleanText } from "@/lib/community-text";
import {
  EPISODE_TYPES,
  type Episode,
  MAX_EPISODES,
  MAX_EPISODE_NOTES,
  MAX_EPISODE_TITLE,
  PODCAST_ID,
  type Podcast,
  parsePodcast,
} from "@/lib/podcast-rules";

const podKey = (id: string) => `nl:pod:${id}`;

export function newPodcastId(): string {
  return randomUUID().replace(/-/g, "");
}

/** How many episodes the stored text lists; null when it lists none as a list (no `episodes`, or not an array). */
function listedEpisodes(raw: string): number | null {
  try {
    const v = JSON.parse(raw) as { episodes?: unknown } | null;
    return v && Array.isArray(v.episodes) ? v.episodes.length : null;
  } catch {
    return null;
  }
}

/**
 * A podcast's record; null only when Redis says there is none. A reply in any other shape (none, several, not text,
 * text that is not this podcast) throws UnknownReplyError (CX-123 rule 24): it is never an empty podcast, because the
 * studio writes back what it read, and an empty one written back would take every episode off the feed. The same holds
 * for this podcast's record with episodes that cannot all be read (no list, an entry that does not parse, more than
 * MAX_EPISODES): parsePodcast would leave them out, and written back they would leave the feed.
 */
export async function readPodcast(id: string): Promise<Podcast | null> {
  if (!PODCAST_ID.test(id) || !isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["GET", podKey(id)]]), 1);
  const raw = reply?.[0];
  if (raw === null) return null;
  const podcast = typeof raw === "string" ? parsePodcast(raw) : null;
  if (!podcast || podcast.id !== id) throw new UnknownReplyError("a podcast's record");
  // Every listed entry parsed and none was cut at MAX_EPISODES: parsePodcast only filters and slices, so the counts match.
  if (listedEpisodes(raw as string) !== podcast.episodes.length) throw new UnknownReplyError("a podcast's episodes");
  return podcast;
}

export async function savePodcast(podcast: Podcast): Promise<void> {
  await redisPipeline([["SET", podKey(podcast.id), JSON.stringify(podcast)]]);
}

export async function dropPodcast(id: string): Promise<void> {
  await redisPipeline([["DEL", podKey(id)]]);
}

export type PodcastEdit =
  | { op: "add"; pathname: string; bytes: number; contentType: string; title: unknown; notes: unknown; at: number }
  | { op: "edit"; id: string; title: unknown; notes: unknown }
  | { op: "remove"; id: string };

export type PodcastResult = { ok: true; podcast: Podcast; removed: Episode | null } | { ok: false; reason: "too_many" | "type" | "unknown" | "title" };

/** One change from the studio. Pure: the caller writes, and deletes the audio of a removed episode. */
export function editPodcast(podcast: Podcast, edit: PodcastEdit): PodcastResult {
  if (edit.op === "add") {
    if (podcast.episodes.length >= MAX_EPISODES) return { ok: false, reason: "too_many" };
    if (!(EPISODE_TYPES as readonly string[]).includes(edit.contentType)) return { ok: false, reason: "type" };
    const title = cleanLine(edit.title, MAX_EPISODE_TITLE);
    if (!title) return { ok: false, reason: "title" };
    const episode: Episode = {
      id: newItemId(),
      title,
      notes: cleanText(edit.notes, MAX_EPISODE_NOTES),
      pathname: edit.pathname,
      bytes: edit.bytes,
      contentType: edit.contentType,
      at: edit.at,
    };
    return { ok: true, podcast: { ...podcast, episodes: [...podcast.episodes, episode] }, removed: null };
  }
  const found = podcast.episodes.find((e) => e.id === edit.id);
  if (!found) return { ok: false, reason: "unknown" };
  if (edit.op === "remove") {
    return { ok: true, podcast: { ...podcast, episodes: podcast.episodes.filter((e) => e.id !== edit.id) }, removed: found };
  }
  const title = cleanLine(edit.title, MAX_EPISODE_TITLE);
  if (!title) return { ok: false, reason: "title" };
  const next = { ...found, title, notes: cleanText(edit.notes, MAX_EPISODE_NOTES) };
  return { ok: true, podcast: { ...podcast, episodes: podcast.episodes.map((e) => (e.id === edit.id ? next : e)) }, removed: null };
}
