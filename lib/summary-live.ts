/** Store-bound admissions for scheduled numbers summaries. Work already admitted is not cancelled by erasure. */
import { claimValue, type Claimed } from "@/lib/claim-mark";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { ERASING_KEY, LIST_ID_PATTERN, MAX_STORE_BYTES, STORE_ID_PATTERN, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";

type Mode = "claim" | "part" | "peek" | "retry";
export type SummaryClaim = Claimed | "gone";
export type SummaryAdmission = { claimed: SummaryClaim; first: number | null };
/** A purpose-specific script: no caller-supplied commands. Keys: identity, erasing, mark/counter, first-time/period.
 * Arguments: erasing field, ref, legacy stats id, TTL, nonce, mode, now, email window (zero without), retry ceiling. */
export const SUMMARY_LIVE = `-- marktmorgen:summary-live:v1
if #KEYS ~= 4 or #ARGV ~= 9 then return {-2, 0} end
if ARGV[3] == '' then
  if redis.call('GET', KEYS[1]) ~= ARGV[2] then return {-1, 0} end
else
  local raw = redis.call('GETRANGE', KEYS[1], 0, ${MAX_STORE_BYTES})
  if not raw or raw == '' then return {-1, 0} end
  if #raw > ${MAX_STORE_BYTES} then return {-2, 0} end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' then return {-2, 0} end
  if record.statsId ~= ARGV[3] then return {-1, 0} end
end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) ~= 0 then return {-1, 0} end
local mode = ARGV[6]
if mode == 'peek' then
  return {redis.call('GET', KEYS[3]) and 0 or 1, 0}
end
if mode == 'retry' then
  local count = redis.call('INCR', KEYS[3])
  redis.call('EXPIRE', KEYS[3], ARGV[4])
  if count < 1 then return {-2, count} end
  if count < tonumber(ARGV[9]) then
    redis.call('DEL', KEYS[4])
    return {1, count}
  end
  return {0, count}
end
if mode ~= 'claim' and mode ~= 'part' then return {-2, 0} end
local kept = redis.call('SET', KEYS[3], ARGV[5], 'NX', 'EX', ARGV[4])
if not kept then return {0, 0} end
if mode == 'part' and tonumber(ARGV[8]) > 0 then
  redis.call('SET', KEYS[4], ARGV[7], 'NX', 'EX', ARGV[4])
  return {1, redis.call('GETRANGE', KEYS[4], 0, 16)}
end
return {1, ARGV[7]}`;

const unknown = (): SummaryAdmission => ({ claimed: "unknown", first: null });
const timeOf = (raw: unknown): number | null => {
  if (typeof raw !== "string" || !/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

export async function summaryAdmission(
  store: Store, key: string, seconds: number, mode: Mode,
  options: { value?: string; related?: string; now?: number; window?: number; tries?: number } = {},
): Promise<SummaryAdmission> {
  if (!isRedisConfigured() || !Number.isSafeInteger(seconds) || seconds <= 0) return unknown();
  const modern = STORE_ID_PATTERN.test(store.sid);
  if (!store.email || (!modern && (store.sid !== "" || store.extra || !store.statsId || !LIST_ID_PATTERN.test(store.statsId)))) return unknown();
  const ref = storeRef(store);
  if (!ref || ref.length > 320) return unknown();
  const value = options.value ?? claimValue(), now = options.now ?? Date.now();
  const window = options.window ?? 0;
  let result: unknown[] | null = null;
  try {
    const keys = [modern ? storeIdCommand(store.sid)[1] : await ownerKey(ref), ERASING_KEY, key, options.related ?? key];
    const response = repliesFor(await redisPipeline([["EVAL", SUMMARY_LIVE, 4, ...keys,
      await erasingField(ref), ref, modern ? "" : store.statsId!, seconds, value, mode, now, window, options.tries ?? 0,
    ]]), 1);
    result = repliesFor(response?.[0], 2);
  } catch { /* Only an exact readback of this unique claim can recover a lost admission response. */ }
  if (result?.[0] === -1 && result[1] === 0) return { claimed: "gone", first: null };
  if (result?.[0] === -2) return unknown();
  if (mode === "peek") return result?.[1] === 0 && (result[0] === 0 || result[0] === 1)
    ? { claimed: result[0] === 1 ? "ours" : "taken", first: null } : unknown();
  if (mode === "retry") {
    const count = countOf(result?.[1]);
    if (count === null || count < 1) return unknown();
    if (result?.[0] === 1 && count < (options.tries ?? 0)) return { claimed: "ours", first: null };
    if (result?.[0] === 0 && count >= (options.tries ?? 0)) return { claimed: "taken", first: null };
    return unknown();
  }
  if (result?.[0] === 0 && result[1] === 0) return { claimed: "taken", first: null };
  if (result?.[0] === 1 && timeOf(result[1]) !== null) return { claimed: "ours", first: mode === "part" ? timeOf(result[1]) : null };
  if (mode !== "claim" && mode !== "part") return unknown();
  try {
    const commands: (string | number)[][] = [["GETRANGE", key, 0, value.length]];
    if (mode === "part" && window > 0) commands.push(["GETRANGE", options.related ?? key, 0, 16]);
    const back = repliesFor(await redisPipeline(commands), commands.length);
    if (back?.[0] === value) return { claimed: "ours", first: mode === "part" ? (window > 0 ? timeOf(back[1]) : now) : null };
    if (back && typeof back[0] === "string" && back[0] !== "") return { claimed: "taken", first: null };
  } catch { /* No repeat of an uncertain claim, counter or external operation. */ }
  return unknown();
}
