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
  type PodcastRef,
  exactEpisodeAudio,
  parsePodcast,
} from "@/lib/podcast-rules";

const podKey = (id: string) => `nl:pod:${id}`;

export function newPodcastId(): string {
  return randomUUID().replace(/-/g, "");
}

export async function readPodcast(id: string): Promise<Podcast | null> {
  if (!PODCAST_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", podKey(id)]]);
  return parsePodcast(raw);
}

/**
 * The audio the episodes of this product's podcast play, read exactly (exactEpisodeAudio), for a decision to delete
 * a file in the product's folder: an empty set for a product that is not a podcast, and for a podcast with no record
 * (episodes live only in it, so none names a file); null, unknown, when the product was not read, the store's answer
 * is not exactly one GET's, or the record is bent. A caller keeps the file on null.
 */
export async function audioPlayedBy(product: { podcast?: PodcastRef | null } | null | undefined): Promise<Set<string> | null> {
  if (!product) return null;
  if (!product.podcast) return new Set();
  const id = product.podcast.id;
  if (!PODCAST_ID.test(id) || !isRedisConfigured()) return null;
  const answers = await redisPipeline([["GET", podKey(id)]]).catch(() => null);
  if (!Array.isArray(answers) || answers.length !== 1) return null;
  if (answers[0] === null) return new Set();
  return exactEpisodeAudio(answers[0], id);
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
