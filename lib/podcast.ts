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
  MAX_TRANSCRIPT_BYTES,
  PODCAST_ID,
  type Podcast,
  isTranscriptType,
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

export async function savePodcast(podcast: Podcast): Promise<void> {
  await redisPipeline([["SET", podKey(podcast.id), JSON.stringify(podcast)]]);
}

export async function dropPodcast(id: string): Promise<void> {
  await redisPipeline([["DEL", podKey(id)]]);
}

export type PodcastEdit =
  | { op: "add"; pathname: string; bytes: number; contentType: string; title: unknown; notes: unknown; at: number }
  | { op: "edit"; id: string; title: unknown; notes: unknown }
  | { op: "remove"; id: string }
  /** Sets an episode's transcript to the stored file named, or takes it away with `pathname` null. */
  | { op: "transcript"; id: string; pathname: string | null; bytes: number; contentType: string };

/**
 * `dropped` is every file the change leaves no longer named by the episode it touched: a removed episode's audio and
 * transcript, a replaced or removed transcript. The caller deletes each one nothing else still names.
 */
export type PodcastResult =
  | { ok: true; podcast: Podcast; removed: Episode | null; dropped: string[] }
  | { ok: false; reason: "too_many" | "type" | "unknown" | "title" | "too_big" };

/** One change from the studio. Pure: the caller writes, and deletes the files it drops. */
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
      transcript: null,
    };
    return { ok: true, podcast: { ...podcast, episodes: [...podcast.episodes, episode] }, removed: null, dropped: [] };
  }
  const found = podcast.episodes.find((e) => e.id === edit.id);
  if (!found) return { ok: false, reason: "unknown" };
  if (edit.op === "remove") {
    const dropped = found.transcript ? [found.pathname, found.transcript.pathname] : [found.pathname];
    return { ok: true, podcast: { ...podcast, episodes: podcast.episodes.filter((e) => e.id !== edit.id) }, removed: found, dropped };
  }
  let next: Episode;
  if (edit.op === "transcript") {
    if (edit.pathname === null) {
      next = { ...found, transcript: null };
    } else {
      if (!isTranscriptType(edit.contentType)) return { ok: false, reason: "type" };
      if (!(edit.bytes >= 0 && edit.bytes <= MAX_TRANSCRIPT_BYTES)) return { ok: false, reason: "too_big" };
      next = { ...found, transcript: { pathname: edit.pathname, bytes: edit.bytes } };
    }
  } else {
    const title = cleanLine(edit.title, MAX_EPISODE_TITLE);
    if (!title) return { ok: false, reason: "title" };
    next = { ...found, title, notes: cleanText(edit.notes, MAX_EPISODE_NOTES) };
  }
  const old = found.transcript?.pathname;
  const dropped = old && old !== next.transcript?.pathname ? [old] : [];
  return { ok: true, podcast: { ...podcast, episodes: podcast.episodes.map((e) => (e.id === edit.id ? next : e)) }, removed: null, dropped };
}
