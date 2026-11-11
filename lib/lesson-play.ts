/**
 * What a press of Play on a lesson video leaves behind (app/api/store/course/play/route.ts), so that the frame is
 * drawn only after it, and a reload does not hold the time again:
 *
 *   nl:learn:play:<ticket>     the player a press got, for the page the browser is sent back to: taken once,
 *                              PLAY_TICKET_SECONDS at most, and only for the lesson video it was got for
 *   nl:learn:playing:<hash>    a signed-in person's live token in one store (and the lesson video it is for), while
 *                              it has PLAY_REUSE_MIN_SECONDS left, or their claim while a press of theirs holds
 *                              (PLAY_CLAIM_SECONDS): their next press of that lesson is given the same token, and of
 *                              another lesson is told that one of theirs is playing, with nothing signed (the owner's
 *                              decision B of 11 November 2026); so a person holds one block at a time in a store,
 *                              never one a lesson (review of #3402, M1), and every token signed is held
 *
 * Neither is the token's only copy that matters: the token is the video service's, good until its own end whatever
 * is kept here. A reply in any other shape is nothing kept (CX-123 rule 24), and the press holds as usual.
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { STREAM_PLAYER_ORIGIN } from "@/lib/stream-rules";
import { PLAY_CLAIM_POLL_MS, PLAY_CLAIM_READS, PLAY_CLAIM_SECONDS, PLAY_REUSE_MIN_SECONDS, PLAY_TICKET_SECONDS } from "@/lib/lesson-play-rules";

export type KeptPlayer = { src: string; width: number; height: number };
/** A person's live token in a store: the lesson video it is for, and the second it stops being good. */
export type LivePlayer = { pathname: string; expires: number; player: KeptPlayer };

const ticketKey = (ticket: string) => `nl:learn:play:${ticket}`;
// One a person a store: the store's video folder, not the lesson's video (review of #3402, M1).
const playingKey = (who: string, folder: string) => `nl:learn:playing:${createHash("sha256").update(`${who}\n${folder}`).digest("hex").slice(0, 40)}`;
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

/** A kept player, only in its exact shape, and only for `pathname` (any, when null), with at least `minLeft` seconds of its token left. */
function keptOf(raw: unknown, pathname: string | null, minLeft: number, now: number): LivePlayer | null {
  if (typeof raw !== "string" || raw.length > 4_096) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { p, src, width, height } = value as Record<string, unknown>;
  if (typeof p !== "string" || (pathname !== null && p !== pathname) || typeof src !== "string") return null;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1) return null;
  const expires = expiresOf(src);
  if (expires === null || expires - Math.floor(now / 1000) < minLeft) return null;
  return { pathname: p, expires, player: { src, width: width as number, height: height as number } };
}

/** A kept player, only in its exact shape, and only for `pathname`, with at least `minLeft` seconds of its token left. */
function playerOf(raw: unknown, pathname: string, minLeft: number, now: number): KeptPlayer | null {
  return keptOf(raw, pathname, minLeft, now)?.player ?? null;
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

/**
 * A signed-in person's place to hold in a store (one live hold a person a store, review of #3402, M1):
 *
 *   { live }   their token in this store, still good for PLAY_REUSE_MIN_SECONDS: nothing is held for this press;
 *   { claim }  none, and the place is claimed for this press (SET NX, PLAY_CLAIM_SECONDS): it holds, and then
 *              keepPlaying replaces the claim with its token, or dropPlayingClaim lets it go;
 *   null       claimed by another press of theirs that gave no token within PLAY_CLAIM_WAIT_MS, or unreadable: no
 *              hold, and the page says the video could not be loaded.
 */
export async function claimPlaying(who: string, folder: string, now = Date.now()): Promise<{ live: LivePlayer } | { claim: string } | null> {
  if (!isRedisConfigured() || !who || !folder) return null;
  const key = playingKey(who, folder);
  const claim = `claim:${randomBytes(12).toString("hex")}`;
  try {
    for (let read = 0; read <= PLAY_CLAIM_READS; read += 1) {
      if (read > 0) await new Promise((resolve) => setTimeout(resolve, PLAY_CLAIM_POLL_MS));
      const [raw] = await redisPipeline([["GET", key]]);
      const live = keptOf(raw, null, PLAY_REUSE_MIN_SECONDS, now + read * PLAY_CLAIM_POLL_MS);
      if (live) return { live };
      if (raw !== null) continue;
      const [set] = await redisPipeline([["SET", key, claim, "EX", PLAY_CLAIM_SECONDS, "NX"]]);
      if (set === "OK") return { claim };
    }
  } catch (error) {
    console.error("could not read or claim a viewer's lesson video token", error);
  }
  return null;
}

/** Lets a claim go when its press signed no token, only while it is still that claim. Best effort: it ends in PLAY_CLAIM_SECONDS. */
export async function dropPlayingClaim(who: string, folder: string, claim: string): Promise<void> {
  if (!isRedisConfigured() || !who || !folder || !claim.startsWith("claim:")) return;
  try {
    const key = playingKey(who, folder);
    const [raw] = await redisPipeline([["GET", key]]);
    if (raw === claim) await redisPipeline([["DEL", key]]);
  } catch (error) {
    console.error("could not let a viewer's claim to hold go; it ends on its own", error);
  }
}

/**
 * Keeps a signed-in person's live token in a store, for the lesson video it is for, until it has
 * PLAY_REUSE_MIN_SECONDS left, in place of their claim or their token before. Answers whether it was kept.
 */
export async function keepPlaying(who: string, folder: string, pathname: string, player: KeptPlayer, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured() || !who || !folder) return false;
  const expires = expiresOf(player.src);
  const seconds = expires === null ? 0 : expires - Math.floor(now / 1000) - PLAY_REUSE_MIN_SECONDS;
  if (seconds < 1) return false;
  try {
    const [reply] = await redisPipeline([["SET", playingKey(who, folder), JSON.stringify({ p: pathname, ...player }), "EX", seconds]]);
    return reply === "OK";
  } catch (error) {
    console.error("could not keep a lesson video's token for its viewer", error);
    return false;
  }
}
