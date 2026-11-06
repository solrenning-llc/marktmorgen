/**
 * Reddit's conversions API, as rules only (613 [WP12] unit 2): what Claude 1
 * confirmed on Reddit's own pages on 2 November 2026
 * (docs/x-reddit-pixels-official-check-2026-11-02.md, Reddit items 6 to 9),
 * and nothing sent. The v3 address and the exact field names were not on a
 * page that could be read (item 10), so there is no request, no wire format
 * and no screen here: a creator is never shown a switch that does nothing
 * (rule VR). What is ready, for the day the reference is read:
 *
 *   - the creator's conversion access token, kept only sealed (lib/secret-box.ts);
 *   - events from a website only (`action_source` WEBSITE), the channel the
 *     pixel's events are deduplicated in;
 *   - nothing older than seven days;
 *   - one event per name and conversion id, the same pair the pixel sends
 *     (lib/reddit-pixel.ts), so Reddit counts each once;
 *   - batches of at most 1,000;
 *   - Limited Data Use carried per person, as on the pixel.
 */
import { seal, unseal } from "@/lib/secret-box";

export const REDDIT_MAX_BATCH = 1_000;
export const REDDIT_MAX_AGE_SECONDS = 7 * 86_400;
export const REDDIT_ACTION_SOURCE = "WEBSITE" as const;
/** The standard events this store sends (lib/reddit-pixel.ts); the server never sends a page visit. */
export type RedditServerEvent = "Purchase" | "Lead";

/** One event as this code keeps it, before any wire format exists. Never an email in clear. */
export type RedditConversion = {
  event: RedditServerEvent;
  /** Seconds. */
  at: number;
  /** The order's or lead's id: the pixel's `conversionId`. */
  conversionId: string;
  actionSource: typeof REDDIT_ACTION_SOURCE;
  value?: number;
  currency?: string;
  /** Limited Data Use for this person, as on the pixel. */
  limited?: { country: string; region: string | null };
};

const SEAL_CONTEXT = "reddit-conversion-token";
const MAX_TOKEN_LENGTH = 4_096;

/**
 * A pasted conversion access token, tidied: one line of visible characters.
 * Its exact shape is not documented on the pages read, so nothing else is
 * assumed; null when it cannot be one.
 */
export function readRedditToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return token.length >= 16 && token.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(token) ? token : null;
}

/** The token sealed for storage; null when it is not one or nothing can seal (then it is never kept). */
export function sealRedditToken(raw: unknown): string | null {
  const token = readRedditToken(raw);
  if (!token) return null;
  try {
    return seal(token, SEAL_CONTEXT);
  } catch {
    return null;
  }
}

/** The token back from storage, or null. */
export function openRedditToken(sealed: string): string | null {
  const opened = unseal(sealed, SEAL_CONTEXT);
  return opened.ok ? readRedditToken(opened.value) : null;
}

/**
 * What would go out now: events from the website only, no older than seven
 * days and not in the future, one per event name and conversion id (the
 * first kept), in batches of at most 1,000.
 */
export function redditBatches(events: readonly RedditConversion[], nowSeconds: number): RedditConversion[][] {
  const seen = new Set<string>();
  const kept: RedditConversion[] = [];
  for (const event of events) {
    if (event.actionSource !== REDDIT_ACTION_SOURCE) continue;
    if (!event.conversionId || event.at > nowSeconds + 60 || nowSeconds - event.at > REDDIT_MAX_AGE_SECONDS) continue;
    const key = `${event.event}|${event.conversionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(event);
  }
  const batches: RedditConversion[][] = [];
  for (let i = 0; i < kept.length; i += REDDIT_MAX_BATCH) batches.push(kept.slice(i, i + REDDIT_MAX_BATCH));
  return batches;
}
