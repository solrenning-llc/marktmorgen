/**
 * Whether somebody is still a member of a community, decided in the same step as a write about them (#4786, #4788,
 * #4789): an erasure deletes the member record first (lib/community-erasure.ts, forgetMemberRecord) and only then
 * each module's own part, so a write that checks the record inside its own script either lands before that deletion
 * (and the module's part deletes it after) or finds no record and writes nothing. A check made in one trip and a write
 * in the next let a write admitted before the erasure land after it and bring the erased person back.
 *
 * The record is read as lib/community.ts readMember and lib/community-push.ts STILL_IN read it: "y" in, "r" taken out
 * by the creator, "n" no record (never in, or erased), "?" a record of any other shape. No imports: the in-memory Redis
 * (lib/redis-memory.ts) models the scripts with memberMark below.
 */

/** Where lib/community.ts keeps the member records (its membersKey); read here, never written. */
export const memberRecordsKey = (id: string) => `nl:cm:${id}:m`;

export type MemberMark = "y" | "r" | "n" | "?";

/** The mark of one member record as read (a string, or null for none): the same reading as MEMBER_MARK_LUA. */
export function memberMark(raw: unknown, who: string): MemberMark {
  if (raw === null) return "n";
  if (typeof raw !== "string") return "?";
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return "?";
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return "?";
  const fields = record as { k?: unknown; e?: unknown; removed?: unknown; muted?: unknown };
  if (fields.k !== who || typeof fields.e !== "string" || typeof fields.removed !== "boolean" || typeof fields.muted !== "boolean") return "?";
  return fields.removed ? "r" : "y";
}

/** Lua: memberMark(members, who), the same reading inside a script. */
const MEMBER_MARK_LUA = [
  "local function memberMark(members, who)",
  '  local raw = redis.call("HGET", members, who)',
  '  if raw == false then return "n" end',
  "  local ok, record = pcall(cjson.decode, raw)",
  '  if not ok or type(record) ~= "table" or record.k ~= who or type(record.e) ~= "string" or type(record.removed) ~= "boolean" or type(record.muted) ~= "boolean" then return "?" end',
  '  if record.removed then return "r" end',
  '  return "y"',
  "end",
].join("\n");

/**
 * An RSVP taken only while the member is in (#4786). KEYS[1] the member records, KEYS[2] the event's RSVPs; ARGV[1]
 * the member key, ARGV[2] the time written. Answers {mark, added, length}: added and length 0 when the mark is not "y"
 * (nothing written), else HSETNX's 0 or 1 and the list's HLEN after it.
 */
export const RSVP_IF_MEMBER = [
  "-- marktmorgen:community-rsvp-if-member:v1",
  MEMBER_MARK_LUA,
  "local mark = memberMark(KEYS[1], ARGV[1])",
  'if mark ~= "y" then return {mark, 0, 0} end',
  'local added = redis.call("HSETNX", KEYS[2], ARGV[1], ARGV[2])',
  'return {mark, added, redis.call("HLEN", KEYS[2])}',
].join("\n");

/**
 * One notice filed for each member still in (#4788). KEYS[1] the member records, KEYS[1 + i] the notice list of
 * ARGV[3 + i]; ARGV[1] the time, ARGV[2] the notice, ARGV[3] the most a list keeps. Each list of a member whose mark
 * is "y" gets the notice and lets its oldest go past the most; the others are not touched. Answers the marks, one
 * character a member, in order.
 */
export const NOTICES_IF_MEMBER = [
  "-- marktmorgen:community-notices-if-member:v1",
  MEMBER_MARK_LUA,
  "local out = {}",
  "for i = 2, #KEYS do",
  "  local mark = memberMark(KEYS[1], ARGV[2 + i])",
  '  if mark == "y" then',
  '    redis.call("ZADD", KEYS[i], ARGV[1], ARGV[2])',
  '    redis.call("ZREMRANGEBYRANK", KEYS[i], 0, -(tonumber(ARGV[3]) + 1))',
  "  end",
  "  out[i - 1] = mark",
  "end",
  "return table.concat(out)",
].join("\n");
