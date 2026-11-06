/**
 * How far down a product's sales page visitors read: for each block, the
 * share of visitors who reached it.
 *
 * Measured before it was built (7 October 2026): Kajabi, Stan, Hotmart,
 * Gumroad and Whop report views and sales of a page, not where on it people
 * stop. A creator who sees that half the visitors never get past the third
 * block knows which block to rewrite, or which to move up.
 *
 * What is kept, and what is not: when a visitor leaves the page, it sends the
 * id of the furthest block they saw (components/page-depth.tsx) — one visitor
 * in eight, since 11 October 2026 (lib/page-read.ts). One hash per product
 * counts, for each block id, how many visitors stopped there. No cookie, no address, nothing about who.
 * A block's share is everybody who stopped at it or further down, worked out
 * from the page as it is now; a removed block's count is simply not shown.
 *
 *   nl:depth:<statsId>:<productId>   hash: <blockId> (stopped there); _n (visitors) until 11 October 2026
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { cappedCount } from "@/lib/capped-count";
import { DEPTH_FIELDS_MAX, DEPTH_RECORD_BYTES } from "@/lib/page-depth-rules";
import { BLOCK_ID_PATTERN } from "@/lib/sales-page";
import { type WhyNot, isWhyNot } from "@/lib/why-not-rules";

const key = (statsId: string, productId: string) => `nl:depth:${statsId}:${productId}`;
const KEEP_SECONDS = 400 * 86_400;

export { DEPTH_FIELDS_MAX, DEPTH_RECORD_BYTES };

/**
 * Counts one visitor who read down to this block: one command (lib/page-read.ts
 * says why that matters). The record's expiry is written only when a block is
 * counted for the first time, so a page counted on keeps its record for a
 * little over a year after its newest block first appeared; how many visitors
 * were counted is the sum of the blocks, so it needs no command of its own.
 */
/** Of the measured visitors, how many pressed play on a video and how far each got: counts at or past each point. */
export type VideoReach = { played: number; quarter: number; half: number; threeQuarters: number; end: number };

/** How far into a video somebody got (components/page-depth.tsx): played, then each quarter. */
const VIDEO_STEPS = ["p", "25", "50", "75", "100"] as const;
type VideoStep = (typeof VIDEO_STEPS)[number];

/**
 * The field one measured visitor is counted under: the furthest block, then
 * `?answer` when they said what stopped them from buying, then
 * `!videoBlock.step` when they played the page's video. One field, so one
 * command, whatever the visitor did. Pure, so the test reads it.
 */
export function depthField(blockId: string, whyNot = "", video = ""): string | null {
  if (!BLOCK_ID_PATTERN.test(blockId)) return null;
  let field = blockId;
  if (isWhyNot(whyNot)) field += `?${whyNot}`;
  const [videoBlock, step] = video.split(".");
  if (video && BLOCK_ID_PATTERN.test(videoBlock ?? "") && (VIDEO_STEPS as readonly string[]).includes(step ?? "")) field += `!${videoBlock}.${step}`;
  return field;
}

export async function countDepth(statsId: string | null, productId: string, blockId: string, whyNot = "", video = ""): Promise<void> {
  const field = depthField(blockId, whyNot, video);
  if (!statsId || !isRedisConfigured() || !field) return;
  const k = key(statsId, productId);
  try {
    const [count] = await cappedCount(k, DEPTH_FIELDS_MAX, [{ field, by: 1 }]);
    if (count === 1) await redisPipeline([["EXPIRE", k, KEEP_SECONDS]]);
  } catch {
    // A measure that fails is a visitor not counted, nothing more.
  }
}

/** For each block of the page, in order, the share (0–100) of visitors who reached it; and how many were counted. */
export function reachShares(order: string[], stopped: Record<string, number>, visitors: number): { shares: Record<string, number>; visitors: number } {
  const shares: Record<string, number> = {};
  let below = 0;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    below += stopped[order[i]] ?? 0;
    shares[order[i]] = visitors > 0 ? Math.round((Math.min(below, visitors) / visitors) * 100) : 0;
  }
  return { shares, visitors };
}

/** What was counted for a product: visitors, and how many stopped at each block id. */
export async function readDepth(
  statsId: string | null,
  productId: string,
): Promise<{ visitors: number; stopped: Record<string, number>; whyNot: Partial<Record<WhyNot, number>>; videos: Record<string, VideoReach> }> {
  if (!statsId || !isRedisConfigured()) return { visitors: 0, stopped: {}, whyNot: {}, videos: {} };
  const [raw] = await redisPipeline([["HGETALL", key(statsId, productId)]]);
  const pairs: Record<string, string> = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) pairs[String(raw[i])] = String(raw[i + 1]);
  else if (raw && typeof raw === "object") Object.assign(pairs, raw);
  const stopped: Record<string, number> = {};
  const whyNot: Partial<Record<WhyNot, number>> = {};
  const videos: Record<string, VideoReach> = {};
  let visitors = 0;
  for (const [field, value] of Object.entries(pairs)) {
    if (field === "_n" || !(Number(value) > 0)) continue;
    const n = Number(value);
    const [head, video] = field.split("!");
    const [block, answer] = head.split("?");
    stopped[block] = (stopped[block] ?? 0) + n;
    if (isWhyNot(answer)) whyNot[answer] = (whyNot[answer] ?? 0) + n;
    if (video) {
      const [videoBlock, step] = video.split(".");
      const at = VIDEO_STEPS.indexOf(step as VideoStep);
      if (at >= 0) {
        const row = (videos[videoBlock] ??= { played: 0, quarter: 0, half: 0, threeQuarters: 0, end: 0 });
        row.played += n;
        if (at >= 1) row.quarter += n;
        if (at >= 2) row.half += n;
        if (at >= 3) row.threeQuarters += n;
        if (at >= 4) row.end += n;
      }
    }
    visitors += n;
  }
  // Every visitor counted stopped at exactly one block, so the blocks add up
  // to the visitors; "_n", written until 11 October 2026, said the same.
  return { visitors, stopped, whyNot, videos };
}
