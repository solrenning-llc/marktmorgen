/**
 * Lesson video that plays the way a video site plays it: the rules.
 *
 * A lesson's video used to be the file as the creator uploaded it, handed to
 * the browser whole. That plays, and on a slow line it stops and waits: a
 * gigabyte filmed on a phone is sent at the rate it was filmed at, whatever
 * the line can carry. A video site does not stop because it keeps several
 * copies of each video, each smaller than the last, cut into pieces of a few
 * seconds, and the player asks for the next piece in the size the line can
 * carry right now.
 *
 * Making those copies is a service's job (lib/stream.ts says which, and
 * why). This file holds what can be said without asking it anything, so the
 * studio's browser reads the same rules the server holds an upload to:
 *
 *   - where such a video is written down. A lesson keeps one handle to its
 *     video, a path (lib/product-file.ts). A video kept by the service has a
 *     path of its own shape, `stream/<store's folder>/<lesson>/<video id>`,
 *     so everything that already carries a lesson's video carries this one,
 *     and the two kinds are told apart by the path alone;
 *   - what state the service says a video is in, read from its own numbers;
 *   - how much one viewing is counted as, for the month's delivery
 *     (lib/delivery.ts).
 *
 * Nothing here touches the network or a secret.
 */

/** The service's own address: where the studio's browser sends a video's pieces (lib/tus-upload.ts). */
export const STREAM_API_ORIGIN = "https://video.bunnycdn.com";
/**
 * Requests one measurement of what a store keeps at the service makes
 * (lib/stream.ts, streamHeld): one API read of the store's collection. The
 * cost table prices an upload start from this (lib/spend-cost-table.ts,
 * UPLOAD_OPEN_STREAM_API_READS), because admission measures it every time
 * (lib/storage-quota.ts).
 */
export const STREAM_HELD_REQUESTS = 1;
/** Where the service's player is framed from: the one address a lesson page frames for it (lib/csp.ts). */
export const STREAM_PLAYER_ORIGIN = "https://player.mediadelivery.net";

/** The first piece of the path of a video the service keeps. */
export const STREAM_PREFIX = "stream";

/** The service's id for a video: a GUID, in lower case. */
export const STREAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FOLDER_PATTERN = /^[0-9a-f]{32}$/;
const OWNER_PATTERN = /^[a-z0-9]{12}$/;

/** The path a lesson keeps for a video the service holds. */
export function streamPath(folder: string, lessonId: string, id: string): string {
  return `${STREAM_PREFIX}/${folder}/${lessonId}/${id}`;
}

/** The store's folder, the lesson and the video id in such a path; null for any other path. */
export function readStreamPath(pathname: unknown): { folder: string; lessonId: string; id: string } | null {
  if (typeof pathname !== "string") return null;
  const parts = pathname.split("/");
  if (parts.length !== 4 || parts[0] !== STREAM_PREFIX) return null;
  const [, folder, lessonId, id] = parts;
  if (!FOLDER_PATTERN.test(folder) || !OWNER_PATTERN.test(lessonId) || !STREAM_ID_PATTERN.test(id)) return null;
  return { folder, lessonId, id };
}

export function isStreamPath(pathname: unknown): boolean {
  return readStreamPath(pathname) !== null;
}

/**
 * Where a video is on its way to being playable.
 *
 *   upload   the door was opened, and the file is still arriving, or never did
 *   working  the file arrived, and no copy of it can be played yet
 *   ready    at least one copy can be played; the rest follow by themselves
 *   failed   the service could not make anything of the file
 */
export type StreamState = "upload" | "working" | "ready" | "failed";

/**
 * The service's own word for a video, as a number (its API, VideoModelStatus):
 * 0 created, 1 uploaded, 2 processing, 3 transcoding, 4 finished, 5 error,
 * 6 upload failed, 7 and 8 the two steps of preparing pieces on demand.
 */
export type ServiceVideo = {
  status: number;
  /** The sizes that have finished, as "360p,720p"; empty while there is none. */
  availableResolutions: string;
};

/** What a video's state is, from what the service says about it. */
export function stateFrom(video: ServiceVideo): StreamState {
  if (video.status === 5 || video.status === 6) return "failed";
  if (video.status === 0) return "upload";
  // Finished, or one size done: the player has something to play, and takes
  // the larger sizes by itself as they arrive.
  if (video.status === 4 || video.availableResolutions.trim() !== "") return "ready";
  return "working";
}

/** The tallest copy that is made. Above it a phone's screen shows no difference, and every viewing costs more. */
export const TOP_HEIGHT = 1080;

/**
 * The most a second of video weighs at each height, in bits, sound included.
 * Set high on purpose: the figure this feeds is what an hour watched can
 * cost us (tests/plan-margin.test.ts), and a cost that errs low is no guard.
 */
const BITS_PER_SECOND: [height: number, bits: number][] = [
  [240, 700_000],
  [360, 1_000_000],
  [480, 1_700_000],
  [720, 3_300_000],
  [1080, 5_500_000],
];

/**
 * What `seconds` of a video weigh, in bytes, at the largest size it is kept
 * in. Never more than `ceiling`, the file as it was uploaded.
 *
 * A viewing used to be counted with this, whole, each time a lesson page
 * opened. What a plan covers of video is now the time it was watched, by
 * the video service's own count (lib/watch.ts), which a page view cannot
 * inflate; this is kept for what it still answers, the most an hour of
 * watching can weigh.
 */
export function viewingBytes(seconds: number, height: number, ceiling: number): number {
  const cap = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(seconds) || seconds <= 0) return Number.isFinite(cap) ? cap : 0;
  const shown = Math.min(height > 0 ? height : TOP_HEIGHT, TOP_HEIGHT);
  const rate = (BITS_PER_SECOND.find(([top]) => shown <= top) ?? BITS_PER_SECOND[BITS_PER_SECOND.length - 1])[1];
  return Math.min(cap, Math.round((seconds * rate) / 8));
}

/**
 * The shape the player takes: the video's own, so one filmed upright on a
 * phone stays upright. A file that says it is turned a quarter is as tall as
 * it says it is wide.
 */
export function shapeOf(width: number, height: number, rotation: number | null): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 16, height: 9 };
  const turned = rotation === 90 || rotation === 270 || rotation === -90;
  return turned ? { width: height, height: width } : { width, height };
}

/**
 * The most the service may come to keep for one video: the file and every
 * size made from it. The studio is held to a file of five gigabytes
 * (lib/product-file.ts), but the pieces go from the browser to the service,
 * which holds nobody to anything; a video that turns out larger than three
 * such files was not sent by the studio, and is not kept.
 */
export const MOST_KEPT_BYTES = 15 * 1024 * 1024 * 1024;

/** How long the studio has to send the file after the door is opened. The service asks for an hour at least. */
export const UPLOAD_WINDOW_SECONDS = 24 * 60 * 60;
/** A door nothing came through is closed after this, and what was made for it is taken away. */
export const ABANDONED_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
/** A file that arrived and is still not playable after this is given up on. */
export const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When to ask the service about a video again, from how long ago its file
 * was asked for. Often at first, when the answer is usually minutes away;
 * seldom later, when it is a long file in a busy hour.
 */
export function nextLook(ageMs: number): number {
  if (ageMs < 60 * 60 * 1000) return 5 * 60 * 1000;
  if (ageMs < 12 * 60 * 60 * 1000) return 15 * 60 * 1000;
  return 60 * 60 * 1000;
}

/** What one lesson video's records count for in the store's data room (lib/store-data.ts): taken at its door, given back here. */
export const VIDEO_RECORD_BYTES = 2_048;
