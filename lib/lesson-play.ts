/**
 * What a press of Play on a lesson video leaves behind (app/api/store/course/play/route.ts), so that the frame is
 * drawn only after it, and a reload does not hold the time again:
 *
 *   nl:learn:play:<ticket>     the player a press got, for the page the browser is sent back to: taken once,
 *                              PLAY_TICKET_SECONDS at most, and only for the lesson video it was got for
 *   nl:learn:playing:<hash>    a signed-in person's token for one lesson video, while it has PLAY_REUSE_MIN_SECONDS
 *                              left: their next press of it is given the same, with nothing held again
 *
 * Neither is the token's only copy that matters: the token is the video service's, good until its own end whatever
 * is kept here. A reply in any other shape is nothing kept (CX-123 rule 24), and the press holds as usual.
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { STREAM_PLAYER_ORIGIN } from "@/lib/stream-rules";
import { PLAY_REUSE_MIN_SECONDS, PLAY_TICKET_SECONDS } from "@/lib/lesson-play-rules";

export type KeptPlayer = { src: string; width: number; height: number };

const ticketKey = (ticket: string) => `nl:learn:play:${ticket}`;
const playingKey = (who: string, pathname: string) => `nl:learn:playing:${createHash("sha256").update(`${who}\n${pathname}`).digest("hex").slice(0, 40)}`;
const TICKET = /^[0-9a-f]{24}$/;

/** Whether a ticket in a page's address has the shape of one. */
export function isPlayTicket(value: unknown): value is string {
  return typeof value === "string" && TICKET.test(value);
}

/** The second a player's token stops being good, from its own address; null for anything else. */
function expiresOf(src: string): number | null {
  try {
    const url = new URL(src);
    if (url.origin !== STREAM_PLAYER_ORIGIN || !url.pathname.startsWith("/embed/")) return null;
    const raw = url.searchParams.get("expires") ?? "";
    if (!/^[1-9][0-9]{0,11}$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

/** A kept player, only in its exact shape, and only for `pathname`, with at least `minLeft` seconds of its token left. */
function playerOf(raw: unknown, pathname: string, minLeft: number, now: number): KeptPlayer | null {
  if (typeof raw !== "string" || raw.length > 4_096) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { p, src, width, height } = value as Record<string, unknown>;
  if (p !== pathname || typeof src !== "string") return null;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1) return null;
  const expires = expiresOf(src);
  if (expires === null || expires - Math.floor(now / 1000) < minLeft) return null;
  return { src, width: width as number, height: height as number };
}

/**
 * Keeps a press's player for the page the browser is sent back to: a new ticket, or null when it could not be kept
 * for certain (the page then says the video could not be loaded; what was held goes back at a reading).
 */
export async function keepPlayTicket(pathname: string, player: KeptPlayer): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  const ticket = randomBytes(12).toString("hex");
  try {
    const [reply] = await redisPipeline([["SET", ticketKey(ticket), JSON.stringify({ p: pathname, ...player }), "EX", PLAY_TICKET_SECONDS, "NX"]]);
    return reply === "OK" ? ticket : null;
  } catch (error) {
    console.error("could not keep a lesson video's ticket", error);
    return null;
  }
}

/** The player a ticket holds, taken once, only for `pathname`; null for anything else. */
export async function takePlayTicket(ticket: unknown, pathname: string, now = Date.now()): Promise<KeptPlayer | null> {
  if (!isRedisConfigured() || !isPlayTicket(ticket)) return null;
  try {
    const [raw] = await redisPipeline([["GETDEL", ticketKey(ticket)]]);
    return playerOf(raw, pathname, 1, now);
  } catch (error) {
    console.error("could not read a lesson video's ticket", error);
    return null;
  }
}

/** A signed-in person's token for one lesson video, still good for PLAY_REUSE_MIN_SECONDS; null when none is known. */
export async function keptPlaying(who: string, pathname: string, now = Date.now()): Promise<KeptPlayer | null> {
  if (!isRedisConfigured() || !who) return null;
  try {
    const [raw] = await redisPipeline([["GET", playingKey(who, pathname)]]);
    return playerOf(raw, pathname, PLAY_REUSE_MIN_SECONDS, now);
  } catch (error) {
    console.error("could not read a lesson video's token kept for its viewer", error);
    return null;
  }
}

/** Keeps a signed-in person's token for one lesson video until it has PLAY_REUSE_MIN_SECONDS left. Best effort. */
export async function keepPlaying(who: string, pathname: string, player: KeptPlayer, now = Date.now()): Promise<void> {
  if (!isRedisConfigured() || !who) return;
  const expires = expiresOf(player.src);
  const seconds = expires === null ? 0 : expires - Math.floor(now / 1000) - PLAY_REUSE_MIN_SECONDS;
  if (seconds < 1) return;
  try {
    await redisPipeline([["SET", playingKey(who, pathname), JSON.stringify({ p: pathname, ...player }), "EX", seconds]]);
  } catch (error) {
    console.error("could not keep a lesson video's token for its viewer", error);
  }
}
