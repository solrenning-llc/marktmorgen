/**
 * Which messages a sales page takes as a video player's (components/page-depth.tsx).
 *
 * A page hears how far a video is watched from the player's frame, by
 * postMessage. Any window can post a message to the page, so a message
 * counts only when it comes from the exact origin of a player frame the
 * page itself drew (lib/sales-page.ts, embedUrl) AND from that very frame's
 * window. A name that merely contains "youtube" or ends in "vimeo.com"
 * (evilvimeo.com, youtube.evil.com) is not a player. Security audit 506
 * [SG1], MM-SA-27, 4 November 2026.
 *
 * Nothing is imported: the page's client bundle stays small.
 * tests/player-origin.test.ts holds these origins to embedUrl's.
 */
export type PlayerKind = "youtube" | "vimeo";

/** The origins of the frames embedUrl builds, scheme and host exactly, default port. */
export const PLAYER_ORIGINS: Readonly<Record<string, PlayerKind>> = Object.freeze({
  "https://www.youtube-nocookie.com": "youtube",
  "https://player.vimeo.com": "vimeo",
});

/** The player an origin belongs to, compared whole; null for anything else. */
export function playerOf(origin: unknown): PlayerKind | null {
  if (typeof origin !== "string") return null;
  return Object.prototype.hasOwnProperty.call(PLAYER_ORIGINS, origin) ? PLAYER_ORIGINS[origin] : null;
}

/** Whether an origin is exactly one of the player frames' origins. */
export function isPlayerOrigin(origin: unknown): boolean {
  return playerOf(origin) !== null;
}

/** The origin of a frame's address, or "" when it has none that can be read. */
function originOf(src: string): string {
  try {
    return new URL(src).origin;
  } catch {
    return "";
  }
}

/** The player a frame's address loads, judged by its origin alone; null for anything else. */
export function framePlayer(src: string): PlayerKind | null {
  return playerOf(originOf(src));
}

/**
 * The player a message came from: its origin is a player's, its sender is
 * the window of one of the page's own player frames, and that frame was
 * drawn from the same origin. Null otherwise, and the message is ignored.
 */
export function messagePlayer(
  frames: Iterable<{ src: string; contentWindow: unknown }>,
  source: unknown,
  origin: unknown,
): PlayerKind | null {
  const kind = playerOf(origin);
  if (!kind || source === null || source === undefined) return null;
  for (const frame of frames) {
    if (frame.contentWindow === source && originOf(frame.src) === origin) return kind;
  }
  return null;
}
