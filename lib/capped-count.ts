/**
 * Counting into hashes that may never grow past a number of fields (added 18
 * October 2026, when what a store keeps in the database was given a figure,
 * tests/store-data-registry.ts).
 *
 * A day's numbers (lib/stats.ts) and a page's reading (lib/page-depth.ts)
 * are counted under fields their visitors' requests name: a source, a term
 * searched for, a block. Each new name was a new field kept for a year, so
 * what a store kept grew with every request that named something new, and
 * no figure said how far. Counted through this script, a field that is
 * already there always counts, and a new one is added only while the hash
 * has fewer fields than its most; past it, what it would have counted is
 * added to the hash's "~" field instead (so the total stays right and the
 * studio can say some were not told apart): a hash holds its most fields and
 * "~" at the most.
 *
 *   KEYS          the hashes
 *   ARGV[1..n]    each hash's most fields, n = #KEYS
 *   ARGV[n+1..2n] each hash's expiry in seconds, 0 for none (version 3)
 *   then          (hash number, field, by) three at a time
 *
 * Answers each field's new value in order, or 0 for one left out. Nothing
 * is written when anything asked is not a count it can do.
 *
 * What it costs (version 2, 31 October 2026). Upstash bills a script as one
 * command plus one for every redis.call it runs
 * (https://upstash.com/docs/redis/overall/billing, read 31 October 2026).
 * Version 1 asked HEXISTS, and for a new name HLEN, before each HINCRBY: a
 * view's nine counts (lib/stats.ts) were billed up to 28 commands (27
 * inside and the EVAL). Version 2 reads each hash's length once; when every
 * name asked could be new and still fit, it only counts; otherwise one HMGET
 * says which names (and "~") are there already, and the length is followed
 * from that, exactly as re-reading it would. One HINCRBY a count, one HLEN a
 * hash and one HMGET for a hash near its most: the same nine counts are
 * billed 12 commands below their hashes' most and 14 at the most (13 inside
 * and the EVAL). It answers and keeps what version 1 did, which
 * scripts/test_capped_count_redis.py checks against version 1 itself on
 * random counts near and past their most, with the commands each run
 * counted by the server. One difference, on purpose: the same hash named
 * twice in KEYS is refused before anything is written (version 1 counted
 * each name against a length the other copy did not see; no caller does it).
 *
 * The expiry (version 3, 7 November 2026). A day's record (lib/stats.ts)
 * was made by whichever count came first, and some of them never gave it
 * its expiry: a reading of the store's page or a search after midnight UTC,
 * before the day's first view, made a record kept for ever; others gave it
 * in a second request, sent only when the count's answer said it was the
 * first, so an answer lost after the write left the record with none. A
 * hash asked with an expiry is now given it by the script itself when the
 * script makes it (its HLEN was 0), in the same write as its first count:
 * one EXPIRE once in the hash's life, nothing more on any later count, and
 * nothing a lost answer can skip. A hash that is already there keeps the
 * expiry it has.
 *
 * scripts/test_capped_count_redis.py runs it on a real Redis.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

/** The field what did not fit is counted under. */
export const OVER_FIELD = "~";

export const CAPPED_COUNT = `-- marktmorgen:capped-count:v3
local n = #KEYS
if n < 1 or #ARGV < 2 * n or (#ARGV - 2 * n) % 3 ~= 0 then return redis.error_reply('capped-count: arguments') end
for i = 1, n do
  for j = i + 1, n do
    if KEYS[i] == KEYS[j] then return redis.error_reply('capped-count: arguments') end
  end
end
local caps = {}
for i = 1, n do
  local cap = tonumber(ARGV[i])
  if not cap or cap < 1 or cap ~= math.floor(cap) then return redis.error_reply('capped-count: most') end
  caps[i] = cap
end
local keeps = {}
for i = 1, n do
  local keep = tonumber(ARGV[n + i])
  if not keep or keep < 0 or keep ~= math.floor(keep) then return redis.error_reply('capped-count: expiry') end
  keeps[i] = keep
end
local left = {}
for i = 2 * n + 1, #ARGV, 3 do
  local k = tonumber(ARGV[i])
  local by = tonumber(ARGV[i + 2])
  if not k or k < 1 or k > n or k ~= math.floor(k) or not by or by ~= math.floor(by) or ARGV[i + 1] == '' or ARGV[i + 1] == '~' then return redis.error_reply('capped-count: count') end
  left[k] = (left[k] or 0) + 1
end
local len, there, made = {}, {}, {}
for k = 1, n do
  if left[k] then
    len[k] = redis.call('HLEN', KEYS[k])
    made[k] = len[k] == 0
    if len[k] + left[k] > caps[k] then
      local names = {}
      for i = 2 * n + 1, #ARGV, 3 do
        if tonumber(ARGV[i]) == k then names[#names + 1] = ARGV[i + 1] end
      end
      names[#names + 1] = '~'
      local held = redis.call('HMGET', KEYS[k], unpack(names))
      there[k] = {}
      for j = 1, #names do
        if held[j] then there[k][names[j]] = true end
      end
    end
  end
end
local out = {}
for i = 2 * n + 1, #ARGV, 3 do
  local k = tonumber(ARGV[i])
  local field = ARGV[i + 1]
  local by = tonumber(ARGV[i + 2])
  local held = there[k]
  if not held then
    out[#out + 1] = redis.call('HINCRBY', KEYS[k], field, by)
  elseif held[field] or len[k] < caps[k] then
    if not held[field] then
      held[field] = true
      len[k] = len[k] + 1
    end
    out[#out + 1] = redis.call('HINCRBY', KEYS[k], field, by)
  else
    if not held['~'] then
      held['~'] = true
      len[k] = len[k] + 1
    end
    redis.call('HINCRBY', KEYS[k], '~', by)
    out[#out + 1] = 0
  end
end
for k = 1, n do
  if made[k] and keeps[k] > 0 then redis.call('EXPIRE', KEYS[k], keeps[k]) end
end
return out`;

export type CappedCount = { hash: number; field: string; by: number };

/**
 * The EVAL that counts these, for a pipeline of its own or one shared with
 * other commands. A hash's `keep` is the expiry, in seconds, the script gives
 * it when it makes it; none when left out.
 */
export function cappedCountCommand(hashes: { key: string; most: number; keep?: number }[], counts: CappedCount[]): (string | number)[] {
  return [
    "EVAL",
    CAPPED_COUNT,
    hashes.length,
    ...hashes.map((h) => h.key),
    ...hashes.map((h) => h.most),
    ...hashes.map((h) => h.keep ?? 0),
    ...counts.flatMap((c) => [c.hash + 1, c.field, c.by]),
  ];
}

/**
 * Counts into one hash; each field's new value, or 0 where it was left out
 * or the answer is not known. Never throws. With `keep`, a hash this makes
 * is given that expiry in the same write, so an answer lost after it never
 * leaves the hash kept for ever.
 */
export async function cappedCount(key: string, most: number, counts: { field: string; by: number }[], keep = 0): Promise<number[]> {
  if (!isRedisConfigured() || !counts.length) return counts.map(() => 0);
  try {
    const [reply] = await redisPipeline([cappedCountCommand([{ key, most, keep }], counts.map((c) => ({ hash: 0, ...c })))]);
    return Array.isArray(reply) ? reply.map((v) => Number(v) || 0) : counts.map(() => 0);
  } catch {
    return counts.map(() => 0);
  }
}
