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
 * at the most it may weigh until it is settled; a deletion whose size is
 * known gives bytes back, unless a listing that began after it already left
 * the picture out. What it cannot know (a page's picture deleted, a door never
 * used) is corrected by a listing of the folder, IMAGE_LIST_PAGES pages at a
 * time and taken up again where it stopped (a cursor kept in the hash), one
 * pass a RECONCILE_EVERY_MS at the most, run by a picture's admission when it
 * is due (reconcileImages).
 *
 * The files part is what the file doors measured (storageUsed) plus what they
 * signed for since (noteFilesAuthorized), less what a route deleted with its
 * size known (adjustImages); a pass measures the files only while no door
 * ever has (the first time).
 *
 * One hash per picture folder, nl:images:space:<folder>:
 *   held    bytes of pictures counted;
 *   files   bytes of files and lesson videos (see above);
 *   pend    bytes of door pictures waiting (the r: fields);
 *   fat     when a file door last signed for bytes (ms); fmt when the files
 *           were last measured (ms);
 *   try     when the last pass began (ms), done or not;
 *   cs      when the last whole listing began (ms);
 *   ss, s0, sum, sc  a listing under way: when it began, `held` then, the
 *           bytes listed so far, and where to go on;
 *   r:<file> a door's picture not settled yet: "<bytes>:<ms>".
 *
 * Pictures with no whole counter yet (the first listing still going) are
 * refused (rule 24); the file, video and vault doors never are because of
 * the pictures: they count what is known of them (spaceUsed). The hash is
 * kept IMAGE_SPACE_KEEP_SECONDS after its last pass or file door.
 *
 * Gaps that existed before this unit and are not made worse by it: a lesson
 * video the video service receives is checked against the space when its
 * door opens but not reserved, and a stamped copy of a sold file
 * (lib/pdf-stamp.ts) is written without a reservation, so either may still
 * go past the space by what it writes; the file doors' concurrent uploads
 * are measured, not reserved (lib/storage-quota.ts, maximumUploadBytes).
 * Pictures copied to R2 (lib/picture-r2-copy.ts) are copies, off while
 * PICTURE_R2_CEILING (lib/picture-r2.ts) is null, and not counted. A page's
 * pictures carry no size, so taking them off frees their room at the next
 * whole listing. A closing store's pictures are not deleted on its closing
 * day (lib/plan-closing.ts counts files and videos only); deleting pictures
 * nothing shows is a separate unit (owner's decision 8: proven unreferenced,
 * 30 days' grace, unknown is kept).
 */
import { list } from "@/lib/blob";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { storageBrakeFor, storageUsed, type StorageUse } from "@/lib/storage-quota";
import { standingOf, storageRefusal } from "@/lib/plan-standing";
import type { Store } from "@/lib/store";
import { imageFolder, storeFolder } from "@/lib/store";
import { UPLOAD_SECONDS } from "@/lib/vault-rules";

/** How long a store's counter is kept after its last pass or file door: a store away longer lists its pictures again. */
export const IMAGE_SPACE_KEEP_SECONDS = 400 * 24 * 60 * 60;
/** At most one pass a store in this time. */
export const RECONCILE_EVERY_MS = 48 * 60 * 60 * 1000;
/** The pages of a thousand pictures one pass lists, at the most; a longer listing goes on at the next pass. */
export const IMAGE_LIST_PAGES = 10;
/** How long one pass may list (and, the first time, measure the files) before it stops where it is. */
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
 * read of the pictures (HELD_READ: HMGET), a pass's claim and its write
 * (CLAIM: EVAL, HMGET, HSET, EXPIRE; PASS: EVAL, HGETALL, HDEL, HSET at the
 * most). Only CLAIM and FILES make the hash, and each gives it its time.
 */
export const IMAGE_SPACE_COMMANDS = { take: 3, door: 4, adjust: 4, files: 4, heldRead: 1, claim: 4, pass: 4 } as const;
/** Bytes a door's admission or a finished pass reads at the most: every field, IMAGE_OPEN_MAX pictures waiting and the counters. */
export const IMAGE_SPACE_READ_BYTES = (IMAGE_OPEN_MAX + 12) * 200;

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
const TAKE = `-- marktmorgen:image-space-take:v2
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

// A door's picture: kept apart at what it may weigh until it is settled; one older than the fold is counted for good.
const DOOR = `-- marktmorgen:image-space-door:v2
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

// Door pictures settled at their real sizes, and room given back for pictures and files deleted with their sizes known,
// in one step. A give is skipped when a whole listing (cs) or a measurement (fmt) began after the deletion (ARGV[3]):
// it already left the deleted bytes out. One that would go below zero is skipped too: higher, never lower.
const ADJUST = `-- marktmorgen:image-space-adjust:v2
local h=KEYS[1]
local give=tonumber(ARGV[1]) local fgive=tonumber(ARGV[2]) local since=tonumber(ARGV[3])
local names={'held','pend','files','cs','fmt'}
for i=4,#ARGV,2 do names[#names+1]=ARGV[i] end
local v=redis.call('HMGET',h,unpack(names))
local d=function(x) return x and string.match(x,'^%d+$') end
local out={} local gone={} local skipped=0
if d(v[1]) and (not v[2] or d(v[2])) then
  local held=tonumber(v[1]) local pend=v[2] and tonumber(v[2]) or 0
  for i=4,#ARGV,2 do
    local raw=v[6+(i-4)/2]
    local b=raw and string.match(raw,'^(%d+):%d+$')
    if b then gone[#gone+1]=ARGV[i] held=held+tonumber(ARGV[i+1]) pend=pend-tonumber(b) end
  end
  if pend<0 then pend=0 end
  if give>0 then
    if (d(v[4]) and tonumber(v[4])>=since) or held<give then skipped=1 else held=held-give end
  end
  out={'held',string.format('%.0f',held),'pend',string.format('%.0f',pend)}
elseif give>0 then skipped=1 end
if fgive>0 then
  if d(v[3]) and not (d(v[5]) and tonumber(v[5])>=since) and tonumber(v[3])>=fgive then
    out[#out+1]='files' out[#out+1]=string.format('%.0f',tonumber(v[3])-fgive)
  else skipped=1 end
end
if #gone>0 then redis.call('HDEL',h,unpack(gone)) end
if #out>0 then redis.call('HSET',h,unpack(out)) end
return skipped==1 and 0 or 1`;

const FILES = `-- marktmorgen:image-space-files:v2
local v=redis.call('HMGET',KEYS[1],'files','fat')
local now=tonumber(ARGV[3])
local base=tonumber(ARGV[1])
local out={'fat',ARGV[3]}
if v[1] and v[2] and string.match(v[1],'^%d+$') and string.match(v[2],'^%d+$') and now-tonumber(v[2])<tonumber(ARGV[4]) and tonumber(v[1])>base then base=tonumber(v[1])
else out[#out+1]='fmt' out[#out+1]=ARGV[3] end
out[#out+1]='files' out[#out+1]=string.format('%.0f',base+tonumber(ARGV[2]))
redis.call('HSET',KEYS[1],unpack(out))
redis.call('EXPIRE',KEYS[1],tonumber(ARGV[5]))
return 1`;

// A pass claimed at most once a RECONCILE_EVERY_MS; a listing is begun when none is under way.
const CLAIM = `-- marktmorgen:image-space-claim:v2
local v=redis.call('HMGET',KEYS[1],'try','ss','sc','files','held')
local now=tonumber(ARGV[1])
if v[1] and string.match(v[1],'^%d+$') and now-tonumber(v[1])<tonumber(ARGV[2]) then return {0,'','',0} end
local missing=(v[4] and string.match(v[4],'^%d+$')) and 0 or 1
if v[2] and string.match(v[2],'^%d+$') then
  redis.call('HSET',KEYS[1],'try',ARGV[1])
  redis.call('EXPIRE',KEYS[1],tonumber(ARGV[3]))
  return {1,v[2],v[3] or '',missing}
end
local held=(v[5] and string.match(v[5],'^%d+$')) and v[5] or ''
redis.call('HSET',KEYS[1],'try',ARGV[1],'ss',ARGV[1],'s0',held,'sum','0','sc','')
redis.call('EXPIRE',KEYS[1],tonumber(ARGV[3]))
return {1,ARGV[1],'',missing}`;

// One pass written: the pages listed added, and where to go on; at the end of the listing the counter is made from it,
// door pictures from before it began taken off (their files are listed, or were never sent). A failed pass forgets the
// listing under way, so the next one begins again.
const PASS = `-- marktmorgen:image-space-pass:v2
local h=KEYS[1]
local now=ARGV[1] local ss=ARGV[2] local add=ARGV[3] local nextc=ARGV[4] local measured=ARGV[6]
local fold=tonumber(ARGV[5])
if ARGV[7]=='1' then
  local cur=redis.call('HGET',h,'ss')
  if cur==ss then redis.call('HDEL',h,'ss','s0','sum','sc') end
  return 0
end
if nextc~='' then
  local v=redis.call('HMGET',h,'ss','sum')
  if v[1]~=ss or not v[2] or not string.match(v[2],'^%d+$') then return -1 end
  local out={'sum',string.format('%.0f',tonumber(v[2])+tonumber(add)),'sc',nextc}
  if measured~='' then out[#out+1]='files' out[#out+1]=measured out[#out+1]='fmt' out[#out+1]=ss end
  redis.call('HSET',h,unpack(out))
  return 2
end
local all=redis.call('HGETALL',h)
local f={} local gone={'ss','s0','sum','sc'} local pending=0
for i=1,#all,2 do
  local k,v=all[i],all[i+1]
  if string.sub(k,1,2)=='r:' then
    local b,at=string.match(v,'^(%d+):(%d+)$')
    if not b or tonumber(at)<=tonumber(ss)-fold then gone[#gone+1]=k else pending=pending+tonumber(b) end
  else f[k]=v end
end
if f['ss']~=ss or not f['sum'] or not string.match(f['sum'],'^%d+$') then return -1 end
local value=tonumber(f['sum'])+tonumber(add)
if f['held'] and string.match(f['held'],'^%d+$') and f['s0'] and string.match(f['s0'],'^%d+$') then
  local delta=tonumber(f['held'])-tonumber(f['s0'])
  if delta>0 then value=value+delta end
end
redis.call('HDEL',h,unpack(gone))
local out={'held',string.format('%.0f',value),'pend',string.format('%.0f',pending),'cs',ss,'at',now}
if measured~='' then out[#out+1]='files' out[#out+1]=measured out[#out+1]='fmt' out[#out+1]=ss end
redis.call('HSET',h,unpack(out))
return 1`;

async function foldersOf(ref: string): Promise<{ images: string; files: string }> {
  return { images: await imageFolder(ref), files: await storeFolder(ref) };
}

function wholeNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Up to `pages` pages of a folder's pictures from `cursor` ("" for the start):
 * their bytes and where to go on ("" at the end); null when a page could not
 * be read whole or the deadline passed.
 */
export async function listImages(folder: string, cursor: string, pages = IMAGE_LIST_PAGES, deadline = Date.now() + RECONCILE_MS): Promise<{ bytes: number; next: string } | null> {
  const prefix = `images/${folder}/`;
  let bytes = 0;
  let at: string | undefined = cursor || undefined;
  const seen = new Set<string>();
  try {
    for (let page = 0; page < pages; page += 1) {
      if (Date.now() > deadline) return null;
      const answer = await list({ prefix, limit: 1000, cursor: at });
      if (!answer || !Array.isArray(answer.blobs) || answer.blobs.length > 1000 || typeof answer.hasMore !== "boolean") return null;
      for (const entry of answer.blobs) {
        if (!entry || typeof entry.pathname !== "string" || !entry.pathname.startsWith(prefix) || !Number.isSafeInteger(entry.size) || entry.size < 0) return null;
        bytes += entry.size;
        if (!Number.isSafeInteger(bytes)) return null;
      }
      if (!answer.hasMore) return { bytes, next: "" };
      if (!answer.cursor || seen.has(answer.cursor) || answer.cursor === cursor) return null;
      seen.add(answer.cursor);
      at = answer.cursor;
    }
    return at ? { bytes, next: at } : null;
  } catch (error) {
    console.error("could not list a store's pictures", error);
    return null;
  }
}

/** The files measured within what is left of a pass's time, or null. */
async function measureWithin(folder: string, deadline: number): Promise<number | null> {
  const left = deadline - Date.now();
  if (left <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), left); });
  try {
    const held = await Promise.race([storageUsed(folder).catch(() => null), late]);
    return held && held.available === true ? held.bytes : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type PassResult = "done" | "progress" | "skipped" | "failed";

/**
 * One pass of the listing, at most once a RECONCILE_EVERY_MS a store (the
 * claim is taken first, done or not): IMAGE_LIST_PAGES pages from where the
 * last pass stopped, within RECONCILE_MS. At the end of the listing the
 * counter is made from it; the first time, the files are measured too.
 */
export async function reconcileImages(ref: string, now = Date.now()): Promise<PassResult> {
  if (!isRedisConfigured()) return "skipped";
  const folders = await foldersOf(ref);
  const record = key(folders.images);
  const [claim] = await redisPipeline([["EVAL", CLAIM, 1, record, now, RECONCILE_EVERY_MS, IMAGE_SPACE_KEEP_SECONDS]]);
  if (!Array.isArray(claim) || Number(claim[0]) !== 1) return "skipped";
  const began = String(claim[1]);
  const cursor = typeof claim[2] === "string" ? claim[2] : "";
  const deadline = Date.now() + RECONCILE_MS;
  const listed = await listImages(folders.images, cursor, IMAGE_LIST_PAGES, deadline);
  const measured = Number(claim[3]) === 1 ? await measureWithin(folders.files, deadline) : null;
  const [written] = await redisPipeline([["EVAL", PASS, 1, record, now, began, listed?.bytes ?? 0, listed?.next ?? "",
    IMAGE_FOLD_MS, measured === null ? "" : measured, listed === null ? "1" : "0"]]);
  if (listed === null) return "failed";
  return Number(written) === 1 ? "done" : Number(written) === 2 ? "progress" : "failed";
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
 * when the counter cannot be read or is not whole yet (rule 24), "busy" when
 * too many door pictures wait or the name is already waiting.
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
    // Counted. A door's picture is kept apart and stays counted through a listing; a picture taken whole is not written
    // yet, so a listing now would leave it out: only a door's admission runs a pass that is due after it.
    if (first.due && field) await reconcileImages(ref, now).catch(() => "failed");
    return;
  }
  // Full or not whole while a pass is due: it runs before anything is taken, and the picture is asked for once more.
  if (first.due && (first.code === -1 || first.code === 0)) {
    const ran = await reconcileImages(ref, now).catch((error: unknown) => {
      console.error("could not go on listing a store's pictures", error);
      return "failed" as const;
    });
    if (ran === "done" || ran === "progress") {
      const again = await admitOnce(record, bytes, limit, field, now).catch(() => ({ code: -1, due: false }));
      if (again.code === 1) return;
      throw refusal(again.code);
    }
  }
  throw refusal(first.code);
}

/** A picture refused for the store's space: the plan's storage sentence, or pictures_room_unknown when the room cannot be read. */
export class StoreSpaceRefused extends Error {
  constructor(public readonly code: "storage_full" | "storage_trial" | "storage_setup" | "pictures_room_unknown") {
    super(code);
    this.name = "StoreSpaceRefused";
  }
}

/**
 * admitImage against the store's own space (its plan's storage, by where it
 * stands with its plan), refusing with the words a studio upload is told:
 * the plan's storage sentence when full, pictures_room_unknown when the room
 * cannot be read or too many pictures wait (lib/studio-messages.ts).
 */
export async function admitStorePicture(store: Store, ref: string, bytes: number, door?: string): Promise<void> {
  const standing = standingOf(store);
  try {
    await admitImage(ref, bytes, storageBrakeFor(standing, store.tier), door);
  } catch (error) {
    if (error instanceof ImageSpaceRefused) throw new StoreSpaceRefused(error.reason === "full" ? storageRefusal(standing) : "pictures_room_unknown");
    throw error;
  }
}

/**
 * Door pictures put on something, at their real sizes (their reservations
 * become those bytes), and room given back: `give` bytes of pictures and
 * `files` bytes of files deleted with their sizes known, `since` the moment
 * before the deletion began (a listing or a measurement begun after it
 * already left those bytes out, and nothing is given twice). Best effort: a
 * change that fails, or would go below zero, leaves the counter higher,
 * never lower.
 */
export async function adjustImages(ref: string, settled: { path: string; bytes: number }[], give = 0, gone: { files?: number; since?: number } = {}): Promise<void> {
  const files = gone.files ?? 0;
  const since = gone.since ?? 0;
  if (!isRedisConfigured() || ![give, files, since].every((n) => Number.isSafeInteger(n) && n >= 0)) return;
  // A give with no moment before its deletion cannot be told apart from one a listing already left out: not given.
  const giving = since > 0 ? give : 0;
  const filesGiving = since > 0 ? files : 0;
  const folder = await imageFolder(ref);
  const pairs: (string | number)[] = [];
  for (const { path, bytes } of settled) {
    const file = fileOf(path, folder);
    if (file && Number.isSafeInteger(bytes) && bytes >= 0) pairs.push(`r:${file}`, bytes);
  }
  if (pairs.length === 0 && giving === 0 && filesGiving === 0) return;
  await redisPipeline([["EVAL", ADJUST, 1, key(folder), giving, filesGiving, since, ...pairs]]).catch((error: unknown) => {
    console.error("could not settle a store's pictures", error);
  });
}

/** Bytes the pictures take (counted and waiting), or null when the counter is not whole or cannot be read. */
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
 * are measured as before (storageUsed) and decide alone whether the door can
 * answer; the pictures add what is known of them: the counter, or while the
 * first listing goes on the bytes listed so far, or nothing when the
 * counter cannot be read (never a refusal of a file for the pictures'
 * sake). `files` is the measured part alone, for noteFilesAuthorized.
 */
export async function spaceUsed(ref: string, brake: number): Promise<StorageUse & { files: number }> {
  const measured = await storageUsed(await storeFolder(ref), brake);
  if (measured.available !== true) return { ...measured, left: 0, full: false, available: false, files: 0 };
  let images = 0;
  try {
    const [values] = isRedisConfigured() ? await redisPipeline([["HMGET", key(await imageFolder(ref)), "held", "pend", "sum"]]) : [null];
    if (Array.isArray(values)) {
      const pend = wholeNumber(values[1]) ?? 0;
      images = (wholeNumber(values[0]) ?? wholeNumber(values[2]) ?? 0) + pend;
    }
  } catch (error) {
    console.error("could not read a store's pictures for a file door", error);
  }
  const bytes = measured.bytes + images;
  if (!Number.isSafeInteger(bytes)) return { ...measured, files: measured.bytes };
  return { bytes, brake, left: Math.max(0, brake - bytes), full: bytes >= brake, available: true, files: measured.bytes };
}

/**
 * Writes down what a file door just signed for, on top of what it measured,
 * so a picture asked for before those bytes are listed still counts them.
 * Best effort: the next door measures them anyway.
 */
export async function noteFilesAuthorized(ref: string, measured: number, authorized: number, now = Date.now()): Promise<void> {
  if (!isRedisConfigured() || !Number.isSafeInteger(measured) || measured < 0 || !Number.isSafeInteger(authorized) || authorized < 0) return;
  await redisPipeline([["EVAL", FILES, 1, key(await imageFolder(ref)), measured, authorized, now, FILES_ARRIVING_MS, IMAGE_SPACE_KEEP_SECONDS]]).catch((error: unknown) => {
    console.error("could not note the bytes a file door signed for", error);
  });
}
