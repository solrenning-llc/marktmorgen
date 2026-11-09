/**
 * A store's pictures counted in the store's space (owner's decision 8,
 * 9 November 2026): the pictures kept under images/<folder>/ (a product's,
 * a link's, a page's, a buyer's review photo, an email's) take room from the
 * same plan figure as its files and lesson videos (lib/storage-rules.ts), and
 * the figure the plan shows does not change.
 *
 * Kept as a counter, not listed before each picture: listing every picture
 * of a store before each upload costs more than the plan can carry (C5 MR (d),
 * 9 November 2026). The counter only ever errs upward: every way a picture is
 * written takes its bytes before it is written (admitImage), a door's picture
 * at the most it may weigh until it is settled; only a deletion whose size is
 * known gives bytes back. What it cannot know (a picture deleted elsewhere,
 * a door never used) is corrected once a day at the most, by listing the
 * pictures and measuring the files again (reconcileImages), which a door
 * runs when it is due.
 *
 * One hash per picture folder, nl:images:space:<folder>:
 *   held    bytes of pictures counted (the last listing, plus what was taken
 *           and settled since, minus what was given back);
 *   files   bytes of files and lesson videos, as last measured, plus what the
 *           file doors signed for since (noteFilesAuthorized);
 *   fat     when a file door last signed for bytes (ms);
 *   try     when the last reconciliation began (ms), done or not: at most one
 *           a RECONCILE_EVERY_MS;
 *   at      when the last reconciliation ended (ms);
 *   r:<file> a door's picture not settled yet: "<bytes>:<ms>".
 *
 * A counter that is missing or cannot be read counts as full (rule 24): the
 * picture is refused and the next reconciliation that is due makes it again.
 *
 * Gaps that existed before this unit and are not made worse by it: a lesson
 * video the video service receives is checked against the space when its
 * door opens but not reserved, and a stamped copy of a sold file
 * (lib/pdf-stamp.ts) is written without a reservation, so either may still
 * go past the space by what it writes; the file doors' concurrent uploads
 * are measured, not reserved (lib/storage-quota.ts, maximumUploadBytes).
 * Pictures copied to R2 (lib/picture-r2-copy.ts) are copies, off while
 * PICTURE_R2_CEILING (lib/picture-r2.ts) is null, and not counted. A closing store's pictures
 * are not deleted on its closing day (lib/plan-closing.ts counts files and
 * videos only); deleting pictures nothing shows is a separate unit (owner's
 * decision 8: proven unreferenced, 30 days' grace, unknown is kept).
 */
import { list } from "@/lib/blob";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { storageBrakeFor, storageUsed, type StorageUse } from "@/lib/storage-quota";
import { standingOf, storageRefusal } from "@/lib/plan-standing";
import type { Store } from "@/lib/store";
import { imageFolder, storeFolder } from "@/lib/store";
import { UPLOAD_SECONDS } from "@/lib/vault-rules";

/** How long a store's counter is kept after its last reconciliation or file door: a store away longer lists its pictures again. */
export const IMAGE_SPACE_KEEP_SECONDS = 40 * 24 * 60 * 60;
/** At most one reconciliation a store in this time. */
export const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
/** The pages of a thousand pictures one reconciliation lists, at the most. */
export const IMAGE_LIST_PAGES = 20;
/** How long one reconciliation may list and measure before it gives up for the day. */
export const RECONCILE_MS = 20_000;
/** A door's picture not settled this long after its door is counted for good at what it may weigh. */
export const IMAGE_FOLD_MS = 10 * 60 * 1000;
/** Door pictures waiting to be settled at one time, at the most. */
export const IMAGE_OPEN_MAX = 100;
/** How long bytes a file door signed for may still be arriving (the vault's upload window is the longest). */
export const FILES_ARRIVING_MS = UPLOAD_SECONDS * 1000 + 10 * 60 * 1000;
/**
 * Commands each step sends, the script's own calls included (Upstash bills a
 * script's calls one by one beside the EVAL, lib/redis-memory.ts scriptCalls):
 * a picture taken whole (TAKE: EVAL, HMGET, HSET), a door's picture (DOOR:
 * EVAL, HGETALL, HDEL, HSET), a settle or a give back (ADJUST: EVAL, HMGET,
 * HDEL, HSET), a file door's note (FILES: EVAL, HMGET, HSET, EXPIRE) and its
 * read of the pictures (HELD_READ: HMGET), a reconciliation's claim and its
 * write (CLAIM: EVAL, HMGET, HSET, EXPIRE; RECONCILE: EVAL, HGETALL, HDEL,
 * HSET, EXPIRE). Only these three create the hash, and each gives it
 * IMAGE_SPACE_KEEP_SECONDS; the others write only into a hash that is there.
 */
export const IMAGE_SPACE_COMMANDS = { take: 3, door: 4, adjust: 4, files: 4, heldRead: 1, claim: 4, reconcile: 5 } as const;
/** Bytes a door's admission reads at the most: every field of the hash, IMAGE_OPEN_MAX pictures waiting and the six counters. */
export const IMAGE_SPACE_READ_BYTES = (IMAGE_OPEN_MAX + 6) * 200;

export type ImageRefusal = "full" | "unknown" | "busy";

export class ImageSpaceRefused extends Error {
  constructor(public readonly reason: ImageRefusal) {
    super(`image_space_${reason}`);
    this.name = "ImageSpaceRefused";
  }
}

const key = (folder: string) => {
  if (!/^[0-9a-f]{24}$/.test(folder)) throw new Error("image_space_folder");
  return `nl:images:space:${folder}`;
};

/** A picture's file name inside its folder (images/<folder>/<file>), or null. */
function fileOf(path: string, folder: string): string | null {
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === "images" && parts[1] === folder && /^[A-Za-z0-9._-]{1,120}$/.test(parts[2]) ? parts[2] : null;
}

// A picture written whole by the server (a review photo, an email's picture): its exact bytes, counted at once.
const TAKE = `-- marktmorgen:image-space-take:v1
local v=redis.call('HMGET',KEYS[1],'held','files','pend','try')
local bytes=tonumber(ARGV[1]) local limit=tonumber(ARGV[2]) local now=tonumber(ARGV[3])
local due=0
if not v[4] or not string.match(v[4],'^%d+$') or now-tonumber(v[4])>=tonumber(ARGV[4]) then due=1 end
if not v[1] or not v[2] or not string.match(v[1],'^%d+$') or not string.match(v[2],'^%d+$') or (v[3] and not string.match(v[3],'^%d+$')) then return {-1,due,0} end
local held=tonumber(v[1])
local total=held+tonumber(v[2])+(v[3] and tonumber(v[3]) or 0)
if total+bytes>limit then return {0,due,total} end
redis.call('HSET',KEYS[1],'held',string.format('%.0f',held+bytes))
return {1,due,total+bytes}`;

// A door's picture: kept apart at the most it may weigh until it is settled; one older than the fold is counted for good.
const DOOR = `-- marktmorgen:image-space-door:v1
local h=KEYS[1]
local bytes=tonumber(ARGV[1]) local limit=tonumber(ARGV[2]) local now=tonumber(ARGV[3])
local field=ARGV[4] local foldBefore=tonumber(ARGV[5]) local most=tonumber(ARGV[6]) local every=tonumber(ARGV[7])
local all=redis.call('HGETALL',h)
local held,files,try=nil,nil,nil
local open={} local bad=false local taken=false
for i=1,#all,2 do
  local k,v=all[i],all[i+1]
  if k=='held' then held=v elseif k=='files' then files=v elseif k=='try' then try=v
  elseif string.sub(k,1,2)=='r:' then
    if k==field then taken=true end
    local b,at=string.match(v,'^(%d+):(%d+)$')
    if not b then bad=true else open[#open+1]={k,tonumber(b),tonumber(at)} end
  end
end
local due=0
if try==nil or not string.match(try,'^%d+$') or now-tonumber(try)>=every then due=1 end
if bad or held==nil or files==nil or not string.match(held,'^%d+$') or not string.match(files,'^%d+$') then return {-1,due,0} end
held=tonumber(held)
local pending=0 local n=0 local gone={}
for _,r in ipairs(open) do
  if r[3]<=foldBefore then gone[#gone+1]=r[1] held=held+r[2]
  else pending=pending+r[2] n=n+1 end
end
if #gone>0 then redis.call('HDEL',h,unpack(gone)) end
local total=tonumber(files)+held+pending
local code=1
if total+bytes>limit then code=0 elseif n>=most or taken then code=-3 end
if code==1 then
  redis.call('HSET',h,'held',string.format('%.0f',held),'pend',string.format('%.0f',pending+bytes),field,ARGV[1]..':'..ARGV[3])
  return {1,due,total+bytes}
end
redis.call('HSET',h,'held',string.format('%.0f',held),'pend',string.format('%.0f',pending))
return {code,due,total}`;

// Door pictures settled at their real size, and bytes given back (a picture deleted whose size is known), in one step.
const ADJUST = `-- marktmorgen:image-space-adjust:v1
local h=KEYS[1]
local give=tonumber(ARGV[1])
local names={'held','pend'}
for i=2,#ARGV,2 do names[#names+1]=ARGV[i] end
local v=redis.call('HMGET',h,unpack(names))
if not v[1] or not string.match(v[1],'^%d+$') or (v[2] and not string.match(v[2],'^%d+$')) then return -1 end
local held=tonumber(v[1]) local pend=v[2] and tonumber(v[2]) or 0
local gone={}
for i=2,#ARGV,2 do
  local raw=v[2+i/2]
  local b=raw and string.match(raw,'^(%d+):%d+$')
  if b then gone[#gone+1]=ARGV[i] held=held+tonumber(ARGV[i+1]) pend=pend-tonumber(b) end
end
if pend<0 then pend=0 end
if #gone>0 then redis.call('HDEL',h,unpack(gone)) end
if held<give then redis.call('HDEL',h,'held') return -1 end
redis.call('HSET',h,'held',string.format('%.0f',held-give),'pend',string.format('%.0f',pend))
return 1`;

const FILES = `-- marktmorgen:image-space-files:v1
local v=redis.call('HMGET',KEYS[1],'files','fat')
local now=tonumber(ARGV[3])
local base=tonumber(ARGV[1])
if v[1] and v[2] and string.match(v[1],'^%d+$') and string.match(v[2],'^%d+$') and now-tonumber(v[2])<tonumber(ARGV[4]) and tonumber(v[1])>base then base=tonumber(v[1]) end
redis.call('HSET',KEYS[1],'files',string.format('%.0f',base+tonumber(ARGV[2])),'fat',ARGV[3])
redis.call('EXPIRE',KEYS[1],tonumber(ARGV[5]))
return 1`;

const CLAIM = `-- marktmorgen:image-space-claim:v1
local v=redis.call('HMGET',KEYS[1],'try','held')
local now=tonumber(ARGV[1])
if v[1] and string.match(v[1],'^%d+$') and now-tonumber(v[1])<tonumber(ARGV[2]) then return {0,''} end
redis.call('HSET',KEYS[1],'try',ARGV[1])
redis.call('EXPIRE',KEYS[1],tonumber(ARGV[3]))
if not v[2] or not string.match(v[2],'^%d+$') then return {1,''} end
return {1,v[2]}`;

// The listing and the measurement written, door pictures from before the claim taken off (their files are listed, or
// were never sent); a listing that is not whole counts those at what they may weigh instead, never lower.
const RECONCILE = `-- marktmorgen:image-space-reconcile:v1
local h=KEYS[1]
local claimed=tonumber(ARGV[2]) local held0=ARGV[3] local listed=ARGV[4] local measured=ARGV[5]
local foldBefore=claimed-tonumber(ARGV[6]) local arriving=tonumber(ARGV[7])
local all=redis.call('HGETALL',h)
local held,files,fat=nil,nil,nil
local gone={} local folded=0 local bad=false local pending=0
for i=1,#all,2 do
  local k,v=all[i],all[i+1]
  if k=='held' then held=v elseif k=='files' then files=v elseif k=='fat' then fat=v
  elseif string.sub(k,1,2)=='r:' then
    local b,at=string.match(v,'^(%d+):(%d+)$')
    if not b then gone[#gone+1]=k bad=true
    elseif tonumber(at)<=foldBefore then gone[#gone+1]=k folded=folded+tonumber(b)
    else pending=pending+tonumber(b) end
  end
end
if held and not string.match(held,'^%d+$') then held=nil end
if #gone>0 then redis.call('HDEL',h,unpack(gone)) end
local out={'at',ARGV[1],'pend',string.format('%.0f',pending)}
local drop=false
if listed~='' then
  local value=tonumber(listed)
  if held and held0~='' then
    local delta=tonumber(held)-tonumber(held0)
    if delta>0 then value=value+delta end
  end
  out[#out+1]='held' out[#out+1]=string.format('%.0f',value)
elseif held and not bad then
  out[#out+1]='held' out[#out+1]=string.format('%.0f',tonumber(held)+folded)
elseif held then drop=true end
if measured~='' then
  local value=tonumber(measured)
  if files and fat and string.match(files,'^%d+$') and string.match(fat,'^%d+$') and claimed-tonumber(fat)<arriving and tonumber(files)>value then value=tonumber(files) end
  out[#out+1]='files' out[#out+1]=string.format('%.0f',value)
end
if drop then out[#out+1]='held' out[#out+1]='x' end
redis.call('HSET',h,unpack(out))
redis.call('EXPIRE',h,tonumber(ARGV[8]))
return 1`;

type Folders = { images: string; files: string };

async function foldersOf(ref: string): Promise<Folders> {
  return { images: await imageFolder(ref), files: await storeFolder(ref) };
}

function wholeNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Every picture in a folder, in bytes, listed whole within IMAGE_LIST_PAGES
 * pages; null when the listing is incomplete, invalid or not finished by the
 * deadline.
 */
export async function listImages(folder: string, deadline = Date.now() + RECONCILE_MS): Promise<number | null> {
  const prefix = `images/${folder}/`;
  let bytes = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const paths = new Set<string>();
  try {
    for (let page = 0; page < IMAGE_LIST_PAGES; page += 1) {
      if (Date.now() > deadline) return null;
      const answer = await list({ prefix, limit: 1000, cursor });
      if (!answer || !Array.isArray(answer.blobs) || answer.blobs.length > 1000 || typeof answer.hasMore !== "boolean") return null;
      for (const entry of answer.blobs) {
        if (!entry || typeof entry.pathname !== "string" || !entry.pathname.startsWith(prefix) ||
            paths.has(entry.pathname) || !Number.isSafeInteger(entry.size) || entry.size < 0) return null;
        paths.add(entry.pathname);
        bytes += entry.size;
        if (!Number.isSafeInteger(bytes)) return null;
      }
      if (!answer.hasMore) return bytes;
      if (!answer.cursor || seen.has(answer.cursor)) return null;
      seen.add(answer.cursor);
      cursor = answer.cursor;
    }
  } catch (error) {
    console.error("could not list a store's pictures", error);
  }
  return null;
}

/**
 * Lists the store's pictures and measures its files again, at most once a
 * RECONCILE_EVERY_MS a store (the claim is taken first, done or not), and
 * writes the counter from them. A listing that is not whole keeps the
 * counter as it is, never lower; a measurement that is not whole keeps the
 * files as they are. True when it ran.
 */
export async function reconcileImages(ref: string, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const folders = await foldersOf(ref);
  const record = key(folders.images);
  const [claim] = await redisPipeline([["EVAL", CLAIM, 1, record, now, RECONCILE_EVERY_MS, IMAGE_SPACE_KEEP_SECONDS]]);
  if (!Array.isArray(claim) || Number(claim[0]) !== 1) return false;
  const held0 = typeof claim[1] === "string" ? claim[1] : "";
  const deadline = Date.now() + RECONCILE_MS;
  const listed = await listImages(folders.images, deadline);
  let measured: number | null = null;
  if (Date.now() <= deadline) {
    const files = await storageUsed(folders.files).catch(() => null);
    measured = files?.available === true ? files.bytes : null;
  }
  const [written] = await redisPipeline([["EVAL", RECONCILE, 1, record, now, now, held0,
    listed === null ? "" : listed, measured === null ? "" : measured, IMAGE_FOLD_MS, FILES_ARRIVING_MS, IMAGE_SPACE_KEEP_SECONDS]]);
  return Number(written) === 1;
}

async function admitOnce(record: string, bytes: number, limit: number, field: string, now: number): Promise<{ code: number; due: boolean }> {
  const [answer] = await redisPipeline([field
    ? ["EVAL", DOOR, 1, record, bytes, limit, now, field, now - IMAGE_FOLD_MS, IMAGE_OPEN_MAX, RECONCILE_EVERY_MS]
    : ["EVAL", TAKE, 1, record, bytes, limit, now, RECONCILE_EVERY_MS]]);
  if (!Array.isArray(answer) || answer.length !== 3) return { code: -1, due: false };
  const code = Number(answer[0]);
  return { code: [1, 0, -1, -3].includes(code) ? code : -1, due: Number(answer[1]) === 1 };
}

function refusal(code: number): ImageSpaceRefused {
  return new ImageSpaceRefused(code === 0 ? "full" : code === -3 ? "busy" : "unknown");
}

/**
 * Takes a picture's bytes from the store's space before it is written or
 * signed for: `door` names a door's picture (its path), kept apart at those
 * bytes until it is settled; without it the bytes are exact and counted at
 * once. Throws ImageSpaceRefused: "full" past the plan's space, "unknown"
 * when the counter cannot be read (rule 24), "busy" when too many door
 * pictures wait or the name is already waiting.
 */
export async function admitImage(ref: string, bytes: number, limit: number, door?: string, now = Date.now()): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(limit) || limit < 0 || !isRedisConfigured()) throw new ImageSpaceRefused("unknown");
  const folder = await imageFolder(ref);
  const record = key(folder);
  let field = "";
  if (door !== undefined) {
    const file = fileOf(door, folder);
    if (!file) throw new ImageSpaceRefused("unknown");
    field = `r:${file}`;
  }
  let first: { code: number; due: boolean };
  try {
    first = await admitOnce(record, bytes, limit, field, now);
  } catch (error) {
    console.error("could not take a picture's room", error);
    throw new ImageSpaceRefused("unknown");
  }
  if (first.code === 1) {
    // Counted. A reconciliation that is due runs after it, so a counter that only errs upward comes back down.
    if (first.due) await reconcileImages(ref, now).catch(() => false);
    return;
  }
  // Full or unreadable while a reconciliation is due: it runs, and the picture is asked for once more.
  if (first.due && (first.code === -1 || first.code === 0)) {
    const ran = await reconcileImages(ref, now).catch((error: unknown) => {
      console.error("could not reconcile a store's pictures", error);
      return false;
    });
    if (ran) {
      const again = await admitOnce(record, bytes, limit, field, now).catch(() => ({ code: -1, due: false }));
      if (again.code === 1) return;
      throw refusal(again.code);
    }
  }
  throw refusal(first.code);
}

/** A picture refused for the store's space: the plan's storage sentence, or files_unavailable when the room cannot be read. */
export class StoreSpaceRefused extends Error {
  constructor(public readonly code: "storage_full" | "storage_trial" | "storage_setup" | "files_unavailable") {
    super(code);
    this.name = "StoreSpaceRefused";
  }
}

/**
 * admitImage against the store's own space (its plan's storage, by where it
 * stands with its plan), refusing with the words a studio upload is told:
 * the plan's storage sentence when full, files_unavailable when the room
 * cannot be read or too many pictures wait.
 */
export async function admitStorePicture(store: Store, ref: string, bytes: number, door?: string): Promise<void> {
  const standing = standingOf(store);
  try {
    await admitImage(ref, bytes, storageBrakeFor(standing, store.tier), door);
  } catch (error) {
    if (error instanceof ImageSpaceRefused) throw new StoreSpaceRefused(error.reason === "full" ? storageRefusal(standing) : "files_unavailable");
    throw error;
  }
}

/**
 * Door pictures put on something, at their real sizes (their reservations
 * become those bytes), and `give` bytes given back: pictures deleted whose
 * size is known. A counter that would go below zero becomes unknown, made
 * again by the next reconciliation. Best effort: a change that fails leaves
 * the counter higher, never lower.
 */
export async function adjustImages(ref: string, settled: { path: string; bytes: number }[], give = 0): Promise<void> {
  if (!isRedisConfigured() || !Number.isSafeInteger(give) || give < 0) return;
  const folder = await imageFolder(ref);
  const pairs: (string | number)[] = [];
  for (const { path, bytes } of settled) {
    const file = fileOf(path, folder);
    if (file && Number.isSafeInteger(bytes) && bytes >= 0) pairs.push(`r:${file}`, bytes);
  }
  if (pairs.length === 0 && give === 0) return;
  await redisPipeline([["EVAL", ADJUST, 1, key(folder), give, ...pairs]]).catch((error: unknown) => {
    console.error("could not settle a store's pictures", error);
  });
}

/** Bytes the pictures take (counted and waiting), or null when the counter cannot be read. */
export async function imagesHeld(ref: string): Promise<number | null> {
  if (!isRedisConfigured()) return null;
  const [values] = await redisPipeline([["HMGET", key(await imageFolder(ref)), "held", "pend"]]);
  if (!Array.isArray(values) || values.length !== 2) return null;
  const held = wholeNumber(values[0]);
  const pend = values[1] === null ? 0 : wholeNumber(values[1]);
  if (held === null || pend === null || !Number.isSafeInteger(held + pend)) return null;
  return held + pend;
}

/**
 * What a store keeps, files, lesson videos and pictures together, for a
 * door that signs for files (app/api/store/file, stream, vault). The files
 * are measured as before (storageUsed); the pictures are read from the
 * counter, made by a reconciliation when it is unreadable and due. `files`
 * is the measured part alone, for noteFilesAuthorized.
 */
export async function spaceUsed(ref: string, brake: number): Promise<StorageUse & { files: number }> {
  const measured = await storageUsed(await storeFolder(ref), brake);
  const unavailable = { ...measured, left: 0, full: false, available: false, files: 0 };
  if (measured.available !== true) return unavailable;
  let images = await imagesHeld(ref).catch(() => null);
  if (images === null && (await reconcileImages(ref).catch(() => false))) images = await imagesHeld(ref).catch(() => null);
  if (images === null) return unavailable;
  const bytes = measured.bytes + images;
  if (!Number.isSafeInteger(bytes)) return unavailable;
  return { bytes, brake, left: Math.max(0, brake - bytes), full: bytes >= brake, available: true, files: measured.bytes };
}

/**
 * Writes down what a file door just signed for, on top of what it measured,
 * so a picture asked for before those bytes are listed still counts them.
 * Best effort: the next reconciliation measures them anyway.
 */
export async function noteFilesAuthorized(ref: string, measured: number, authorized: number, now = Date.now()): Promise<void> {
  if (!isRedisConfigured() || !Number.isSafeInteger(measured) || measured < 0 || !Number.isSafeInteger(authorized) || authorized < 0) return;
  await redisPipeline([["EVAL", FILES, 1, key(await imageFolder(ref)), measured, authorized, now, FILES_ARRIVING_MS, IMAGE_SPACE_KEEP_SECONDS]]).catch((error: unknown) => {
    console.error("could not note the bytes a file door signed for", error);
  });
}
