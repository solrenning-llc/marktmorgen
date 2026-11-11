/**
 * Where what a creator spent on ads is kept (lib/ad-spend-rules.ts says what
 * it is for). One field for each entry, so two people adding at once both
 * keep theirs; at most MAX_SPEND_ENTRIES, the oldest let go; kept as long as
 * the days of visits are, counted from the last entry added. Shown only in
 * the studio.
 *
 * What the store's Meta ad account spent is read into lines of its own
 * (lib/meta-ads.ts), and readSpends hands them back with the typed ones,
 * marked source "meta", so every figure that uses spend uses both. They
 * cannot be removed one by one: they go with the connection.
 *
 *   nl:stats:<statsId>:spend   hash: <id> → JSON { channel, campaign, cents, from, to }
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type AdSpend, MAX_SPEND_ENTRIES, readSpend } from "@/lib/ad-spend-rules";
import { metaLines } from "@/lib/meta-ads";

const key = (statsId: string) => `nl:stats:${statsId}:spend`;
const ID = /^[a-f0-9]{8}$/;
const KEEP_SECONDS = 400 * 86_400;

export function parseSpends(raw: unknown): AdSpend[] {
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const out: AdSpend[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (!ID.test(flat[i])) continue;
    let value: unknown;
    try {
      value = JSON.parse(flat[i + 1]);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    // Read back through the same rule it was written by, with no "now": a kept entry is never refused for its age.
    const v = value as Record<string, unknown>;
    const read = readSpend({ channel: v.channel, campaign: v.campaign, cents: v.cents, from: v.from, to: v.to }, Number.MAX_SAFE_INTEGER);
    if (read.ok) out.push({ id: flat[i], ...read.spend });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id)).slice(-MAX_SPEND_ENTRIES);
}

/** The typed lines only. */
async function typedSpends(statsId: string): Promise<AdSpend[]> {
  const [raw] = await redisPipeline([["HGETALL", key(statsId)]]);
  return parseSpends(raw);
}

/** Every line: the typed ones, then those read from Meta while the store is connected. */
export async function readSpends(statsId: string | null): Promise<AdSpend[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [typed, meta] = await Promise.all([typedSpends(statsId), metaLines(statsId).catch(() => [])]);
  return [...typed, ...meta];
}

export async function addSpend(
  statsId: string,
  input: { channel: unknown; campaign?: unknown; cents: unknown; from: unknown; to: unknown },
  now = Date.now(),
): Promise<{ ok: true; spends: AdSpend[] } | { ok: false; reason: "channel" | "amount" | "days" | "unavailable" }> {
  const read = readSpend(input, now);
  if (!read.ok) return read;
  if (!isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const id = randomBytes(4).toString("hex");
  await redisPipeline([
    ["HSET", key(statsId), id, JSON.stringify(read.spend)],
    ["EXPIRE", key(statsId), KEEP_SECONDS],
  ]);
  // Over the cap, the oldest are trimmed only from lines read exactly (rule 24): a reply cut short or of another shape
  // trims nothing this time, never "keep none", which deleted every typed line, the new one too.
  const kept = repliesFor(await redisPipeline([["HGETALL", key(statsId)], ["HLEN", key(statsId)], ["HKEYS", key(statsId)]]), 3);
  const flat = stringList(kept?.[0]);
  const count = countOf(kept?.[1]);
  const all = stringList(kept?.[2]);
  if (flat && flat.length % 2 === 0 && count !== null && all && count > MAX_SPEND_ENTRIES) {
    const keep = new Set(parseSpends(flat).map((s) => s.id));
    const drop = all.filter((field) => !keep.has(field));
    if (drop.length && keep.size > 0) await redisPipeline([["HDEL", key(statsId), ...drop]]);
  }
  return { ok: true, spends: await readSpends(statsId) };
}

export async function removeSpend(statsId: string, id: unknown): Promise<AdSpend[]> {
  if (typeof id === "string" && ID.test(id) && isRedisConfigured()) await redisPipeline([["HDEL", key(statsId), id]]);
  return readSpends(statsId);
}
