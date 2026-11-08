/** Path, its data-room slots and opt-in board entry change in one Redis operation. */
import { TAKE_DATA } from "@/lib/store-data";
import { PATH_BOARD_ROOM_BYTES } from "@/lib/path-board-rules";
export const PATH_DATA_CHANGE = `local function pathRoom(limit, always, month, size, boardSize)
  local roomKey = KEYS[1]
  local count = #KEYS
  local KEYS = {roomKey}
  local ARGV = {limit, always, month, 's', 'path', size}
  if count == 4 then ARGV[7]='s'; ARGV[8]='path-board'; ARGV[9]=boardSize end
${TAKE_DATA}
end`;

export const PATH_BOARD_CHANGE = `local boardKey = KEYS[3]
local mapKey = KEYS[4]
local sid = ARGV[7]
local oldMember = nil
if #KEYS == 4 then
  if type(sid) ~= 'string' or #sid ~= 32 or not string.match(sid, '^[0-9a-f]+$') then return {-1, 0} end
  local kind=redis.call('TYPE', boardKey).ok
  local mapKind=redis.call('TYPE', mapKey).ok
  if (kind ~= 'none' and kind ~= 'zset') or (mapKind ~= 'none' and mapKind ~= 'hash') then return {-1, 0} end
  oldMember=redis.call('HGET', mapKey, sid)
end
local function member(value)
  if value == nil or value == cjson.null then return nil end
  if type(value) ~= 'table' or type(value.token) ~= 'string' or #value.token ~= 32 or not string.match(value.token, '^[0-9a-f]+$') or type(value.score) ~= 'number' or value.score < 0 or value.score > 15 or value.score ~= math.floor(value.score) or type(value.at) ~= 'number' or value.at <= 0 or value.at > 9007199254740991 or value.at ~= math.floor(value.at) then return false end
  return value.token .. ':' .. tostring(value.score) .. ':' .. string.format('%.0f', value.at)
end
local function changeBoard(nextMember, score)
  if #KEYS ~= 4 then return end
  if oldMember then redis.call('ZREM', boardKey, oldMember) end
  if nextMember then
    redis.call('ZADD', boardKey, score, nextMember)
    redis.call('HSET', mapKey, sid, nextMember)
  else redis.call('HDEL', mapKey, sid) end
end`;

/** Legacy two-key callers remain valid only for records without board membership. */
export const WRITE_PATH = `-- marktmorgen:path-write:v1
${PATH_DATA_CHANGE}
if (#KEYS ~= 2 and #KEYS ~= 4) or (#KEYS == 2 and #ARGV ~= 6) or (#KEYS == 4 and #ARGV ~= 7) or (ARGV[5] ~= '0' and ARGV[5] ~= '1') then return {-1, 0} end
${PATH_BOARD_CHANGE}
local old = redis.call('GET', KEYS[2])
local before = nil
if ARGV[5] == '1' then
  if old then return {-2, 0} end
  if ARGV[4] ~= '' then return {-1, 0} end
else
  if not old then return {-2, 0} end
  local ok, record = pcall(cjson.decode, old)
  if not ok or type(record) ~= 'table' or record.v ~= 1 then return {-1, 0} end
  before=record
  local revision = type(record.r) == 'string' and record.r or ''
  if revision ~= ARGV[4] then return {-2, 0} end
end
local ok, next = pcall(cjson.decode, ARGV[6])
if not ok or type(next) ~= 'table' or next.v ~= 1 or type(next.r) ~= 'string' or #next.r ~= 32 or not string.match(next.r, '^[0-9a-f]+$') or next.r == ARGV[4] then return {-1, 0} end
local nextMember=member(next.g)
if nextMember == false or (nextMember and #KEYS ~= 4) then return {-1, 0} end
-- A visit cannot restore a membership removed from the shared index.
if nextMember and before and member(before.g) and not oldMember then return {-2, 0} end
local boardSize=nextMember and '${PATH_BOARD_ROOM_BYTES}' or '0'
local taken = pathRoom(ARGV[1], '0', ARGV[2], ARGV[3], boardSize)
if taken[1] ~= 1 then return taken end
redis.call('SET', KEYS[2], ARGV[6])
changeBoard(nextMember, nextMember and next.g.score or 0)
return taken`;

export const FORGET_PATH = `-- marktmorgen:path-forget:v1
${PATH_DATA_CHANGE}
if (#KEYS ~= 2 and #KEYS ~= 4) or (#KEYS == 2 and #ARGV ~= 1) or (#KEYS == 4 and #ARGV ~= 2) then return {-1, 0} end
local sid=ARGV[2]
local oldMember=nil
if #KEYS == 4 then
  if type(sid) ~= 'string' or #sid ~= 32 or not string.match(sid, '^[0-9a-f]+$') then return {-1, 0} end
  local kind=redis.call('TYPE', KEYS[3]).ok
  local mapKind=redis.call('TYPE', KEYS[4]).ok
  if (kind ~= 'none' and kind ~= 'zset') or (mapKind ~= 'none' and mapKind ~= 'hash') then return {-1, 0} end
  oldMember=redis.call('HGET', KEYS[4], sid)
end
local taken = pathRoom('0', '1', ARGV[1], '0', '0')
if taken[1] ~= 1 then return taken end
redis.call('DEL', KEYS[2])
if #KEYS == 4 then
  if oldMember then redis.call('ZREM', KEYS[3], oldMember) end
  redis.call('HDEL', KEYS[4], sid)
end
return taken`;

/**
 * FORGET_PATH made only while a lock is still its holder's, read in the same step: the closing walk forgets a closing
 * store's Path only while it still holds the store's lock (lib/closed-store-data.ts, prepareStore; Codex M's focal M1
 * on #3156). KEYS: FORGET_PATH's four, then the lock; ARGV: FORGET_PATH's two, then the holder's token. {-9, 0}, and
 * nothing done, when the lock is not the holder's; otherwise FORGET_PATH's answer, the lock left out of its keys.
 */
export const FORGET_PATH_HELD = `-- marktmorgen:path-forget-held:v1
if #KEYS ~= 5 or #ARGV ~= 3 then return {-1, 0} end
if redis.call('GET', KEYS[5]) ~= ARGV[3] then return {-9, 0} end
KEYS[5] = nil
ARGV[3] = nil
${FORGET_PATH.slice(FORGET_PATH.indexOf("\n") + 1)}`;
