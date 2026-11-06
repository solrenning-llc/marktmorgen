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
  EPISODE_ID,
  EPISODE_TYPES,
  type Episode,
  MAX_EPISODES,
  MAX_EPISODE_NOTES,
  MAX_EPISODE_TITLE,
  PODCAST_ID,
  type Podcast,
} from "@/lib/podcast-rules";

const podKey = (id: string) => `nl:pod:${id}`;

export function newPodcastId(): string {
  return randomUUID().replace(/-/g, "");
}

const RECORD_KEYS = ["episodes", "id"];
const EPISODE_KEYS = ["at", "bytes", "contentType", "id", "notes", "pathname", "title"];

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
};
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One episode exactly as editPodcast writes it, or null. */
function exactEpisode(value: unknown): Episode | null {
  if (!plainObject(value) || !exactKeys(value, EPISODE_KEYS)) return null;
  const { id, title, notes, pathname, bytes, contentType, at } = value;
  if (typeof id !== "string" || !EPISODE_ID.test(id)) return null;
  if (typeof title !== "string" || !title || typeof notes !== "string") return null;
  if (typeof pathname !== "string" || !pathname) return null;
  if (typeof contentType !== "string" || !(EPISODE_TYPES as readonly string[]).includes(contentType)) return null;
  if (!count(bytes) || !count(at)) return null;
  return { id, title, notes, pathname, bytes, contentType, at };
}

/**
 * The record exactly as savePodcast writes it — `{ id, episodes }` with this podcast's id and every episode whole, at
 * most MAX_EPISODES — or null. Never the lenient parsePodcast (lib/podcast-rules.ts), which reads missing or broken
 * episodes as fewer: what is read here is written back whole.
 */
function exactPodcast(raw: string, id: string): Podcast | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plainObject(value) || !exactKeys(value, RECORD_KEYS) || value.id !== id) return null;
  const listed = value.episodes;
  if (!Array.isArray(listed) || listed.length > MAX_EPISODES) return null;
  const episodes: Episode[] = [];
  for (const entry of listed) {
    const episode = exactEpisode(entry);
    if (!episode) return null;
    episodes.push(episode);
  }
  return { id, episodes };
}

/**
 * A podcast's record; null only when Redis says there is none. A reply in any other shape (none, several, not text,
 * text that is not this podcast, or this podcast's id over episodes that are missing, not a list, more than
 * MAX_EPISODES or with one entry not as the writer writes it) throws UnknownReplyError (CX-123 rule 24): it is never an
 * empty or a partial podcast, because the studio and plan closing write back the whole podcast they read, and one
 * written back with fewer episodes would take the others off the feed.
 */
export async function readPodcast(id: string): Promise<Podcast | null> {
  if (!PODCAST_ID.test(id) || !isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["GET", podKey(id)]]), 1);
  const raw = reply?.[0];
  if (raw === null) return null;
  const podcast = typeof raw === "string" ? exactPodcast(raw, id) : null;
  if (!podcast) throw new UnknownReplyError("a podcast's record");
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
