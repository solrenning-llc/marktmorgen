/** A shipped order's protected email, saved before any provider attempt.
 * Pending work has no expiry. Its slots and bytes are reserved first, and a
 * confirmed dispatch barrier is permanent until an explicit outcome/erasure.
 * A lease can recover preparation; it can never recover a submitted email.
 */
import { createHash, randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import { CURRENT_SHIPMENT_MAIL_LIFECYCLE, readShippedRecord, type ShipmentMailLifecycle } from "@/lib/shipment-record";
export { CURRENT_SHIPMENT_MAIL_LIFECYCLE };

type Command = (string | number)[];
export type ShipmentMailPipeline = (commands: Command[]) => Promise<unknown[]>;
export type ShipmentMailMessage = { from: string; to: string; subject: string; text: string; replyTo: string };
export type ShipmentMailState = "queued" | "preparing" | "dispatching" | "refused";
export type ShipmentMailView = { state: "queued" | "on_hold" | "accepted" | "acceptance_unknown" | "refused" | "not_recorded"; delayed: boolean };
export type PendingMailRecoveryGrant = {
  version: 1; revision: number; evidence: string; startsAt: number; until: number;
  maximumAttempts: number; maximumCommandUnits: number; checkpointBytes: number;
  maximumTriggerInvocations: number; triggerEvidence: string;
};
export type ShipmentMailPolicy = {
  reviewId: string;
  evidence: string;
  ongoingStorageFunded: boolean;
  emptyInitializationVerified: boolean;
  globalItems: number;
  globalBytes: number;
  storeItems: number;
  storeBytes: number;
  maxPayloadBytes: number;
  maximumChecks: number;
  retryMilliseconds: number;
  admissionsUntil: number;
  continuedReviewIds?: string[];
  /** Explicit extra source coverage in this same funded envelope; absence
   * preserves legacy physical/shipment coverage, never admits courses. */
  coveredOrigins?: ("course-confirmation")[];
  /** Separate quantified discovery/trigger coverage in this SAME review.
   * Storage funding is not recovery funding. Actual review remains NULL. */
  recovery?: PendingMailRecoveryGrant;
};
/** No verified perpetual pending-storage envelope is supplied by this change. */
export const CURRENT_SHIPMENT_MAIL_POLICY: ShipmentMailPolicy | null = null;
export const SHIPMENT_MAIL_MAX_ROW_BYTES = 131_072;
export const SHIPMENT_MAIL_MAX_INDEX_ITEMS = 10_000;
export const SHIPMENT_MAIL_LEASE_MS = 60_000;
export const SHIPMENT_MAIL_DELAYED_MS = 72 * 3_600_000;
export const SHIPMENT_MAIL_SOURCE_SECONDS = 400 * 86_400;
export const SHIPMENT_MAIL_PRODUCER_MS = 300_000;
export const SHIPMENT_MAIL_ERASURE_FENCE_MS = 600_000;
export const SHIPMENT_MAIL_DUE = "nl:ship:mail:due";
const ALL = "nl:ship:mail:all";
const POOL = "nl:ship:mail:pool";
const SESSION = /^cs_(?:test|live)_[A-Za-z0-9]{10,200}$/;
const STORE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const person = (email: string) => digest(email.trim().toLowerCase());
export const shipmentMailId = (statsId: string, session: string) => digest(`${statsId}\n${session}`);
const rowKey = (id: string) => `nl:ship:mail:row:${id}`;
const storeIndex = (statsId: string) => `nl:ship:mail:store:${statsId}`;
const personIndex = (statsId: string, fingerprint: string) => `nl:ship:mail:person:${statsId}:${fingerprint}`;
const storePool = (statsId: string) => `nl:ship:mail:pool:${statsId}`;
const storeFence = (statsId: string) => `nl:ship:mail:closed:${statsId}`;
const personFence = (statsId: string, fingerprint: string) => `nl:ship:mail:erased:${statsId}:${fingerprint}`;
const context = (id: string) => `shipment-mail|${id}`;

function data(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !Object.hasOwn(field, "value")) return null;
      out[key] = field.value;
    }
    return out;
  } catch { return null; }
}
export function shipmentMailPolicy(value: unknown, now = Date.now(), admission = true): ShipmentMailPolicy | null {
  try {
  const p = data(value);
  const allowed = ["reviewId", "evidence", "ongoingStorageFunded", "emptyInitializationVerified", "globalItems", "globalBytes", "storeItems", "storeBytes", "maxPayloadBytes", "maximumChecks", "retryMilliseconds", "admissionsUntil", "continuedReviewIds", "coveredOrigins", "recovery"];
  if (p && Object.keys(p).some(key => !allowed.includes(key))) return null;
  if (!p || !integer(now) || typeof p.reviewId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(p.reviewId) ||
      typeof p.evidence !== "string" || !p.evidence.trim() || p.ongoingStorageFunded !== true || p.emptyInitializationVerified !== true) return null;
  for (const key of ["globalItems", "globalBytes", "storeItems", "storeBytes", "maxPayloadBytes", "maximumChecks", "retryMilliseconds", "admissionsUntil"]) {
    if (!integer(p[key]) || p[key] === 0) return null;
  }
  if (Number(p.globalItems) > SHIPMENT_MAIL_MAX_INDEX_ITEMS || Number(p.storeItems) > Number(p.globalItems) ||
      Number(p.storeBytes) > Number(p.globalBytes) || Number(p.globalBytes) > 1_000_000_000_000 ||
      Number(p.maxPayloadBytes) > 60_000 || Number(p.maximumChecks) > 10_000 ||
      Number(p.retryMilliseconds) < 60_000 || Number(p.retryMilliseconds) > 86_400_000 || admission && Number(p.admissionsUntil) < now) return null;
  if (p.continuedReviewIds !== undefined) {
    const input = p.continuedReviewIds;
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
    if (!integer(length) || length > 32 || Reflect.ownKeys(input).length !== length + 1) return null;
    const ids: string[] = [];
    for (let i = 0; i < length; i++) {
      const field = Object.getOwnPropertyDescriptor(input, String(i));
      if (!field || !Object.hasOwn(field, "value") || typeof field.value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(field.value)) return null;
      ids.push(field.value);
    }
    p.continuedReviewIds = ids;
  }
  if (p.recovery !== undefined) {
    const r = data(p.recovery);
    const fields = ["version", "revision", "evidence", "startsAt", "until", "maximumAttempts", "maximumCommandUnits", "checkpointBytes", "maximumTriggerInvocations", "triggerEvidence"];
    if (!r || Object.keys(r).length !== fields.length || !fields.every(key => Object.hasOwn(r, key)) || r.version !== 1 ||
        typeof r.evidence !== "string" || !r.evidence.trim() || r.evidence.length > 1000 ||
        typeof r.triggerEvidence !== "string" || !r.triggerEvidence.trim() || r.triggerEvidence.length > 1000) return null;
    for (const key of ["revision", "startsAt", "until", "maximumAttempts", "maximumCommandUnits", "checkpointBytes", "maximumTriggerInvocations"]) if (!integer(r[key])) return null;
    if (Number(r.revision) < 1 || Number(r.startsAt) > now || Number(r['until']) <= now || Number(r['until']) <= Number(r.startsAt) ||
        Number(r.maximumAttempts) < 1 || Number(r.maximumAttempts) > 1000 || Number(r.maximumCommandUnits) < 64 || Number(r.maximumCommandUnits) > 64_000 ||
        Number(r.checkpointBytes) < 4096 || Number(r.checkpointBytes) > 8192 || Number(r.maximumTriggerInvocations) < 1 || Number(r.maximumTriggerInvocations) > 1000) return null;
    p.recovery = r;
  }
  if (p.coveredOrigins !== undefined) {
    const input = p.coveredOrigins;
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
        Object.getOwnPropertyDescriptor(input, "length")?.value !== 1 || Reflect.ownKeys(input).length !== 2) return null;
    const field = Object.getOwnPropertyDescriptor(input, "0");
    if (!field || !Object.hasOwn(field, "value") || field.value !== "course-confirmation") return null;
    p.coveredOrigins = ["course-confirmation"];
  }
  return p as unknown as ShipmentMailPolicy;
  } catch { return null; }
}

type Row = {
  id: string; statsId: string; session: string; person: string; sourceValue: string;
  sealed: string; fingerprint: string; bytes: number; created: number; authorizedAt: number; next: number;
  state: ShipmentMailState; owner: string; leaseUntil: number; checks: number; reviewId: string;
};
function parseRow(raw: unknown): Row | null {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > SHIPMENT_MAIL_MAX_ROW_BYTES) return null;
    const r = data(JSON.parse(raw));
    const keys = ["id", "statsId", "session", "person", "sourceValue", "sealed", "fingerprint", "bytes", "created", "authorizedAt", "next", "state", "owner", "leaseUntil", "checks", "reviewId"];
    if (!r || Object.keys(r).length !== keys.length || !keys.every(key => Object.hasOwn(r, key)) ||
        typeof r.id !== "string" || !HASH.test(r.id) || typeof r.statsId !== "string" || !STORE.test(r.statsId) ||
        typeof r.session !== "string" || !SESSION.test(r.session) || r.id !== shipmentMailId(r.statsId, r.session) ||
        typeof r.person !== "string" || !HASH.test(r.person) || typeof r.fingerprint !== "string" || !HASH.test(r.fingerprint) ||
        typeof r.sourceValue !== "string" || r.sourceValue.length > 2_000 || typeof r.sealed !== "string" || !r.sealed.startsWith("s1.") ||
        !["queued", "preparing", "dispatching", "refused"].includes(String(r.state)) || typeof r.owner !== "string" || !/^[a-f0-9]{0,48}$/.test(r.owner) ||
        typeof r.reviewId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.reviewId) ||
        ![r.bytes, r.created, r.authorizedAt, r.next, r.leaseUntil, r.checks].every(integer) || Number(r.bytes) < Buffer.byteLength(raw)) return null;
    const source = data(JSON.parse(r.sourceValue));
    if (!source || Object.keys(source).length !== 2 || !integer(source.at) || source.at === 0 || typeof source.tracking !== "string") return null;
    return r as unknown as Row;
  } catch { return null; }
}
function keys(r: Pick<Row, "id" | "session" | "statsId" | "person">): string[] {
  return [rowKey(r.id), `nl:ship:done:${r.session}`, SHIPMENT_MAIL_DUE, storeIndex(r.statsId), personIndex(r.statsId, r.person), POOL, storePool(r.statsId), ALL, storeFence(r.statsId), personFence(r.statsId, r.person)];
}

/** Every mutation checks source+row+indices in one operation. No script treats
 * an expired dispatch lease, absent provider response or a lost ACK as absence.
 * Tests count EVAL itself plus every internal redis.call on real Redis.
 */
export const SHIPMENT_MAIL_SCRIPT = `-- marktmorgen:shipment-mail-outbox:v1
local op, expected, supplied = ARGV[1], ARGV[2], ARGV[3]
local now, maxbytes = tonumber(ARGV[4]), tonumber(ARGV[5])
if not now or now < 0 or not maxbytes or maxbytes > 131072 then return {'unknown'} end
local types = {'string','string','zset','set','set','hash','hash','set','string','string'}
local seen = {}
for i=1,10 do
 if not KEYS[i] or seen[KEYS[i]] then return {'unknown'} end
 seen[KEYS[i]] = true
 local kind = redis.call('TYPE',KEYS[i]).ok
 if kind ~= 'none' and kind ~= types[i] then return {'unknown'} end
end
local raw = redis.call('GETRANGE',KEYS[1],0,maxbytes)
if #raw > maxbytes then return {'unknown'} end
local source = redis.call('GET',KEYS[2])
local r = nil
if raw ~= '' then
 local ok,v = pcall(cjson.decode,raw)
 if not ok or type(v) ~= 'table' or type(v.bytes) ~= 'number' or v.bytes < #raw then return {'unknown'} end
 r=v
end
local function pool(key)
 local v=redis.call('HMGET',key,'items','bytes')
 if not v[1] and not v[2] then return nil end
 local function canonical(value)
  return type(value)=='string' and (value=='0' or string.match(value,'^[1-9][0-9]*$')) and #value<=16
 end
 if not canonical(v[1]) or not canonical(v[2]) then return false end
 local n,b=tonumber(v[1]),tonumber(v[2])
 if not n or not b or n<0 or b<0 or n>9007199254740991 or b>9007199254740991 or n%1~=0 or b%1~=0 then return false end
 return {n,b}
end
local function drop()
 local a,b=pool(KEYS[6]),pool(KEYS[7])
 -- Erasure is never blocked by corrupt financial counters. Keep an uncertain
 -- reserve charged rather than releasing any amount that cannot be proved.
 if a and b and a[1]>=1 and b[1]>=1 and a[2]>=r.bytes and b[2]>=r.bytes then
  redis.call('HINCRBY',KEYS[6],'items',-1); redis.call('HINCRBY',KEYS[6],'bytes',-r.bytes)
  redis.call('HINCRBY',KEYS[7],'items',-1); redis.call('HINCRBY',KEYS[7],'bytes',-r.bytes)
  if b[1]==1 and b[2]==r.bytes then redis.call('DEL',KEYS[7]) end
 end
 redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[3],r.id)
 redis.call('SREM',KEYS[4],r.id); redis.call('SREM',KEYS[5],r.id); redis.call('SREM',KEYS[8],r.id)
 -- Pending work owns its source for as long as it waits. Start the existing
 -- shipment-record retention only once the payload has a terminal outcome.
 if source == r.sourceValue then redis.call('EXPIRE',KEYS[2],34560000) end
end
if op == 'enqueue' then
 if r then return {'existing',raw,source or ''} end
 if source then return {'legacy',source} end
 local ok,n=pcall(cjson.decode,supplied)
 local good,p=pcall(cjson.decode,ARGV[6])
 if not ok or not good or type(n)~='table' or type(p)~='table' or #supplied>maxbytes or n.bytes < #supplied or n.bytes > p.storeBytes or n.bytes > p.globalBytes or type(n.authorizedAt)~='number' or n.authorizedAt>now or now-n.authorizedAt>300000 or now>p.admissionsUntil then return {'unknown'} end
 -- Courses are a reserve/readback construction only. Funding must explicitly
 -- cover this origin in the SAME policy; no physical funding inheritance.
 if n.originKind~=nil then
  if n.originKind~='course' or n.phase~='course_reserved' or n.state~='queued' or n.next~=0 or type(n.courseBindingFingerprint)~='string' or #n.courseBindingFingerprint~=64 or string.find(n.courseBindingFingerprint,'[^a-f0-9]') or
     type(p.coveredOrigins)~='table' or #p.coveredOrigins~=1 or p.coveredOrigins[1]~='course-confirmation' then return {'unknown'} end
 end
 if redis.call('EXISTS',KEYS[9],KEYS[10])~=0 then return {'unknown'} end
 local a,b=pool(KEYS[6]),pool(KEYS[7])
 if a==false or b==false then return {'unknown'} end
 if not a then
  if redis.call('SCARD',KEYS[8])~=0 or redis.call('ZCARD',KEYS[3])~=0 or not p.emptyInitializationVerified then return {'unknown'} end
  a={0,0}
 end
 if not b then if redis.call('SCARD',KEYS[4])~=0 then return {'unknown'} end; b={0,0} end
 if a[1]>=p.globalItems or b[1]>=p.storeItems or a[2]+n.bytes>p.globalBytes or b[2]+n.bytes>p.storeBytes then return {'full'} end
 redis.call('HSET',KEYS[6],'items',a[1]+1,'bytes',a[2]+n.bytes)
 redis.call('HSET',KEYS[7],'items',b[1]+1,'bytes',b[2]+n.bytes)
 redis.call('SET',KEYS[1],supplied)
 redis.call('SET',KEYS[2],n.sourceValue)
 -- Reserve-only courses have no worker stage. Keep their protected source
 -- in the existing ownership indices, without an unbounded polling member.
 if n.originKind==nil then redis.call('ZADD',KEYS[3],now,n.id) end
 redis.call('SADD',KEYS[4],n.id); redis.call('SADD',KEYS[5],n.id); redis.call('SADD',KEYS[8],n.id)
 return {'queued',supplied}
end
if not r then return {'missing'} end
if raw ~= expected then return {'changed'} end
if op == 'cancel' then drop(); return {'canceled'} end
-- This construction has no claim, dispatch or acceptance protocol for courses.
if r.originKind~=nil then return {'unknown'} end
if source ~= r.sourceValue then return {'unknown'} end
if redis.call('EXISTS',KEYS[9],KEYS[10])~=0 then return {'held',raw} end
local good,p=pcall(cjson.decode,ARGV[6])
if not good or type(p)~='table' then return {'unknown'} end
local supported = r.reviewId==p.reviewId
if type(p.continuedReviewIds)=='table' then for _,id in ipairs(p.continuedReviewIds) do if id==r.reviewId then supported=true end end end
if not supported then return {'unknown'} end
if op == 'claim' then
 if r.state~='queued' and not (r.state=='preparing' and r.leaseUntil<=now) then return {'held',raw} end
 if r.next>now then return {'held',raw} end
 if r.checks>=p.maximumChecks then
  r.state='queued'; r.owner=''; r.leaseUntil=0; r.next=0
 else
  r.state='preparing'; r.owner=ARGV[7]; r.leaseUntil=now+60000; r.next=r.leaseUntil; r.checks=r.checks+1; r.reviewId=p.reviewId
 end
elseif op == 'dispatch' then
 if r.state~='preparing' or r.owner~=ARGV[7] or r.leaseUntil<now then return {'held',raw} end
 r.state='dispatching'; r.leaseUntil=0; r.next=0
elseif op == 'defer' then
 if r.state~='preparing' or r.owner~=ARGV[7] then return {'held',raw} end
 r.state='queued'; r.owner=''; r.leaseUntil=0; r.next=now+p.retryMilliseconds
elseif op == 'not-accepted' then
 if r.state~='dispatching' or r.owner~=ARGV[7] then return {'held',raw} end
 r.state='queued'; r.owner=''; r.next=now+p.retryMilliseconds
elseif op == 'refused' then
 if r.state~='dispatching' or r.owner~=ARGV[7] then return {'held',raw} end
 r.state='refused'; r.next=0
elseif op == 'accepted' then
 if r.state~='dispatching' or r.owner~=ARGV[7] then return {'held',raw} end
 drop(); return {'accepted'}
else return {'unknown'} end
if r.state=='queued' and r.checks>=p.maximumChecks then r.next=0 end
local encoded=cjson.encode(r)
if #encoded>maxbytes or #encoded>r.bytes then return {'unknown'} end
redis.call('SET',KEYS[1],encoded)
if r.state=='queued' and r.next==0 and r.checks>=p.maximumChecks then redis.call('ZADD',KEYS[3],-r.checks,r.id)
elseif r.next>0 and (r.state=='preparing' or r.checks<p.maximumChecks) then redis.call('ZADD',KEYS[3],r.next,r.id) else redis.call('ZREM',KEYS[3],r.id) end
return {r.state,encoded}
`;

export type ShipmentMailRuntime = { policy?: ShipmentMailPolicy | null; lifecycle?: ShipmentMailLifecycle; pipeline?: ShipmentMailPipeline; now?: () => number };
/** Operational checkpoint only: at most25 existing ALL references. No new
 * source, financial approval, send permission or provider replay is created.
 * A ticket reserves64 command units before bounded variable source reads.
 * The first/denied EVAL and pre-server network failures require the separately
 * reviewed fixed trigger envelope; this counter cannot fund itself. */
export const PENDING_MAIL_RECOVERY_SCRIPT = `-- marktmorgen:pending-mail-recovery:v1
local op=ARGV[1]
local ok,g=pcall(cjson.decode,ARGV[2])
local fp,owner,family=ARGV[3],ARGV[4],ARGV[5]
local now=tonumber(ARGV[6])
if not ok or type(g)~='table' or type(g.recovery)~='table' or not now then return {'unknown'} end
local r=g.recovery
local clock=redis.call('TIME')
local serverNow=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
if math.abs(now-serverNow)>60000 or now<r.startsAt or now>=r['until'] or r.version~=1 or r.revision<1 or r.revision%1~=0 or r.maximumAttempts<1 or r.maximumAttempts>1000 or r.maximumCommandUnits<64 or r.maximumCommandUnits>64000 or r.checkpointBytes<4096 or r.checkpointBytes>8192 or r.maximumTriggerInvocations<1 or r.maximumTriggerInvocations>1000 then return {'unknown'} end
now=serverNow
if now<r.startsAt or now>=r['until'] or (family~='shipment' and family~='confirmation') or #fp~=64 or #owner~=48 then return {'unknown'} end
local pt,at=redis.call('TYPE',KEYS[1]).ok,redis.call('TYPE',KEYS[2]).ok
if (pt~='none' and pt~='hash') or (at~='none' and at~='set') then return {'unknown'} end
if pt=='none' then return {at=='none' and 'empty' or 'unknown'} end
local financial=redis.call('HMGET',KEYS[1],'items','bytes')
for _,value in ipairs(financial) do
 if type(value)~='string' or (#value>1 and string.sub(value,1,1)=='0') or string.find(value,'[^0-9]') or #value>16 or not tonumber(value) or tonumber(value)>9007199254740991 then return {'unknown'} end
end
if not financial[1] or not financial[2] or tonumber(financial[1])>g.globalItems or tonumber(financial[2])>g.globalBytes then return {'unknown'} end
local raw=redis.call('HGET',KEYS[1],'pendingRecovery')
local c=nil
if raw then
 if #raw>8192 then return {'unknown'} end
 local good,v=pcall(cjson.decode,raw)
 if not good or type(v)~='table' or v.version~=1 or type(v.ids)~='table' or #v.ids>25 then return {'unknown'} end
 local expected={version=true,revision=true,fingerprint=true,reviewId=true,maximumChecks=true,attempts=true,units=true,ids=true,index=true,family=true,phase=true,owner=true,leaseUntil=true}
 local count=0
 for field,_ in pairs(v) do if not expected[field] then return {'unknown'} end;count=count+1 end
 if count~=13 then return {'unknown'} end
 for _,field in ipairs({'revision','maximumChecks','attempts','units','index','leaseUntil'}) do
  local n=v[field];if type(n)~='number' or n<0 or n>9007199254740991 or n%1~=0 then return {'unknown'} end
 end
 if v.revision<1 or v.maximumChecks<1 or v.maximumChecks>10000 or v.attempts>1000 or v.units~=v.attempts*64 or v.index<1 or v.index>#v.ids+1 or type(v.fingerprint)~='string' or #v.fingerprint~=64 or string.find(v.fingerprint,'[^a-f0-9]') or type(v.reviewId)~='string' or #v.reviewId<1 or #v.reviewId>128 or (v.family~='shipment' and v.family~='confirmation') or (v.phase~='capturing' and v.phase~='active' and v.phase~='done' and v.phase~='unsupported') or type(v.owner)~='string' or (v.owner~='' and (#v.owner~=48 or string.find(v.owner,'[^a-f0-9]'))) or ((v.owner=='')~=(v.leaseUntil==0)) then return {'unknown'} end
 local seen={};local size=0
 for key,id in pairs(v.ids) do
  if type(key)~='number' or key<1 or key>#v.ids or key%1~=0 or type(id)~='string' or #id~=64 or string.find(id,'[^a-f0-9]') or seen[id] then return {'unknown'} end
  seen[id]=true;size=size+1
 end
 if size~=#v.ids or (v.phase=='active' and (size==0 or v.index>size)) then return {'unknown'} end
 c=v
end
local function save()
 local text=cjson.encode(c)
 if #text>r.checkpointBytes then return false end
 redis.call('HSET',KEYS[1],'pendingRecovery',text)
 return true
end
if op=='next' then
 if c and (r.revision<c.revision or (r.revision==c.revision and fp~=c.fingerprint)) then return {'held'} end
 if not c or r.revision>c.revision then
  if c and (g.reviewId==c.reviewId or g.maximumChecks<=c.maximumChecks) then return {'held'} end
  c={version=1,revision=r.revision,fingerprint=fp,reviewId=g.reviewId,maximumChecks=g.maximumChecks,attempts=0,units=0,ids={},index=1,family='shipment',phase='capturing',owner='',leaseUntil=0}
 end
 if c.phase=='done' or c.phase=='unsupported' then return {c.phase} end
 if c.attempts>=r.maximumAttempts or c.attempts>=r.maximumTriggerInvocations or c.units+64>r.maximumCommandUnits then return {'exhausted'} end
 c.attempts=c.attempts+1;c.units=c.units+64
 -- Write-ahead charge: a failed enumeration cannot restore its budget.
 if not save() then return {'unknown'} end
 if c.phase=='capturing' then
  local count=redis.call('SCARD',KEYS[2])
  if count~=tonumber(financial[1]) then return {'unknown'} end
  if count>25 then c.phase='unsupported';save();return {'unsupported'} end
  local ids=redis.call('SMEMBERS',KEYS[2])
  for _,id in ipairs(ids) do if #id~=64 or string.find(id,'[^a-f0-9]') then return {'unknown'} end end
  table.sort(ids);c.ids=ids;c.index=1;c.family='shipment';c.phase=#ids==0 and 'done' or 'active'
  if not save() then return {'unknown'} end
 end
 if c.phase~='active' then return {c.phase} end
 if c.family~=family or (c.owner~='' and c.leaseUntil>now) then return {'held'} end
 c.owner=owner;c.leaseUntil=math.min(now+60000,r['until'])
 if not save() then return {'unknown'} end
 return {'ticket',c.ids[c.index],tostring(c.index)}
end
if op~='finish' or not c or c.revision~=r.revision or c.fingerprint~=fp or c.phase~='active' or c.family~=family or c.owner~=owner or c.leaseUntil<=now then return {'held'} end
local id=c.ids[c.index]
local prefix=family=='shipment' and 'nl:ship:mail:row:' or 'nl:order-confirmation:row:'
local sourcePrefix=family=='shipment' and 'nl:ship:done:' or 'nl:order-confirmation:source:'
if KEYS[3]~=prefix..id then return {'unknown'} end
local rt=redis.call('TYPE',KEYS[3]).ok
local current=''
if rt=='string' then current=redis.call('GETRANGE',KEYS[3],0,131072) elseif rt~='none' then return {'unknown'} end
if current~=ARGV[7] or #current>131072 then return {'changed'} end
local result='skipped'
if current~='' and ARGV[8]=='valid' then
 local good,row=pcall(cjson.decode,current)
 if not good or type(row)~='table' or row.id~=id then return {'unknown'} end
 do
  if (family=='shipment' and row.kind~=nil) or (family=='confirmation' and (row.kind~='confirmation' or row.originKind~=nil)) then return {'unknown'} end
  if KEYS[4]~=sourcePrefix..(family=='shipment' and row.session or id) or type(row.statsId)~='string' or type(row.person)~='string' then return {'unknown'} end
  local dt,st=redis.call('TYPE',KEYS[5]).ok,redis.call('TYPE',KEYS[4]).ok
  if (dt~='none' and dt~='zset') or st~='string' or redis.call('GET',KEYS[4])~=row.sourceValue then return {'unknown'} end
  local fencePrefix=family=='shipment' and 'nl:ship:mail:' or 'nl:order-confirmation:'
  if KEYS[6]~=fencePrefix..'closed:'..row.statsId or KEYS[7]~=fencePrefix..'erased:'..row.statsId..':'..row.person then return {'unknown'} end
  local supported=row.reviewId==g.reviewId
  for _,review in ipairs(g.continuedReviewIds) do if row.reviewId==review then supported=true end end
  -- A supported in-flight preparation may later become an eligible parked
  -- hold. Do not permanently skip it from this finite snapshot while its
  -- original bounded lease/ordinary worker can still settle the transition.
  if supported and row.state=='preparing' then return {'busy'} end
  local phaseOk=family=='shipment' or row.phase=='queued' or row.phase=='awaiting_payment'
  local erased=false
  if family=='confirmation' then
   if row.erasureSaturated~=false or type(row.erasedPeople)~='string' or #row.erasedPeople>4096 or #row.erasedPeople%64~=0 then erased=true
   else for i=1,#row.erasedPeople,64 do if string.sub(row.erasedPeople,i,i+63)==row.person then erased=true end end end
  end
  if supported and phaseOk and not erased and row.state=='queued' and row.next==0 and type(row.checks)=='number' and row.checks>=0 and row.checks%1==0 and row.checks<g.maximumChecks and redis.call('EXISTS',KEYS[6],KEYS[7])==0 then
   local score=redis.call('ZSCORE',KEYS[5],id)
   -- Zero means immediately eligible without copying a new timestamp into
   -- the original row or depending on the caller clock's millisecond edge.
   if not score or tonumber(score)<0 then redis.call('ZADD',KEYS[5],0,id);result='rearmed' else result='already' end
  end
 end
end
-- No source write or dispatch is involved. Progress is committed AFTER the
-- idempotent membership effect; a lost/failed progress ACK keeps this item.
c.index=c.index+1;c.owner='';c.leaseUntil=0
if c.index>#c.ids then
 if c.family=='shipment' then c.family='confirmation';c.index=1 else c.phase='done' end
end
if not save() then return {'unknown'} end
return {result}
`;

type RecoveryObservation = { raw: string; keys?: string[] };
/** Unknown transport must return null, never an observation that advances
 * the cursor. A known absent row is represented by an acknowledged raw="". */
export async function recoverPendingMail(family: "shipment" | "confirmation", deadline: number,
 runtime: ShipmentMailRuntime, observe: (id: string) => Promise<RecoveryObservation | null>): Promise<void> {
 if (lifecycle(runtime) !== "active") return;
 const now = runtime.now ?? Date.now, p = shipmentMailPolicy(runtime.policy === undefined ? CURRENT_SHIPMENT_MAIL_POLICY : runtime.policy, now(), false);
 if (!p?.recovery || !integer(deadline) || now() >= deadline) return;
 const grant = { recovery: p.recovery, reviewId: p.reviewId, maximumChecks: p.maximumChecks, globalItems: p.globalItems, globalBytes: p.globalBytes, continuedReviewIds: p.continuedReviewIds ?? [] };
 const proof = JSON.stringify(grant), fp = digest(proof), owner = randomBytes(24).toString("hex"), pipeline = runtime.pipeline ?? redisPipeline;
 try {
  const response = ownArray(await pipeline([["EVAL", PENDING_MAIL_RECOVERY_SCRIPT, 2, POOL, ALL, "next", proof, fp, owner, family, now(), "", ""]]));
  const ticket = response?.length === 1 ? ownArray(response[0]) : null;
  if (ticket?.length !== 3 || ticket[0] !== "ticket" || typeof ticket[1] !== "string" || !HASH.test(ticket[1]) || now() >= deadline) return;
  const id = ticket[1], found = await observe(id);
  if (!found || now() >= deadline) return;
  const keyset = found.keys;
  const base = family === "shipment" ? `nl:ship:mail:row:${id}` : `nl:order-confirmation:row:${id}`;
  // Missing/known unsupported observations cannot authorize a rearm.
  const selected = keyset ? [POOL, ALL, keyset[0], keyset[1], keyset[2], keyset[8], keyset[9]] : [POOL, ALL, base];
  await pipeline([["EVAL", PENDING_MAIL_RECOVERY_SCRIPT, selected.length, ...selected, "finish", proof, fp, owner, family, now(), found.raw, keyset ? "valid" : "skip"]]);
 } catch { /* Charged work/unknown transport retains this checkpoint item. */ }
}

const lifecycle = (runtime: ShipmentMailRuntime) => runtime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE;
function ownArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || value.length > 3 || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !Object.hasOwn(d, "value")) return null;
      out.push(d.value);
    }
    return out;
  } catch { return null; }
}
async function mutate(op: string, row: Row, expected: string, p: ShipmentMailPolicy | null, runtime: ShipmentMailRuntime, owner = ""): Promise<unknown[] | null> {
  const pipeline = runtime.pipeline ?? redisPipeline;
  try {
    const reply = ownArray(await pipeline([["EVAL", SHIPMENT_MAIL_SCRIPT, 10, ...keys(row), op, expected, JSON.stringify(row), (runtime.now ?? Date.now)(), SHIPMENT_MAIL_MAX_ROW_BYTES, JSON.stringify(p), owner]]));
    return reply?.length === 1 ? ownArray(reply[0]) : null;
  } catch { return null; }
}
async function read(id: string, pipeline: ShipmentMailPipeline): Promise<{ row: Row; raw: string } | null | "unknown"> {
  try {
    if (!HASH.test(id)) return "unknown";
    const got = ownArray(await pipeline([["TYPE", rowKey(id)], ["GETRANGE", rowKey(id), 0, SHIPMENT_MAIL_MAX_ROW_BYTES]]));
    if (!got || got.length !== 2 || typeof got[1] !== "string") return "unknown";
    if (got[0] === "none" && got[1] === "") return null;
    if (got[0] !== "string") return "unknown";
    const row = parseRow(got[1]);
    return row?.id === id ? { row, raw: got[1] } : "unknown";
  } catch { return "unknown"; }
}
function view(row: Row, now: number): ShipmentMailView {
  return { state: row.state === "dispatching" ? "acceptance_unknown" : row.state === "refused" ? "refused" : row.state === "queued" && row.next === 0 ? "on_hold" : "queued", delayed: now - row.created >= SHIPMENT_MAIL_DELAYED_MS };
}
export async function shipmentMailStatus(statsId: string | null, session: string, runtime: ShipmentMailRuntime = {}): Promise<ShipmentMailView | null> {
  if (!statsId || !STORE.test(statsId) || !SESSION.test(session)) return null;
  if (lifecycle(runtime) === "never_activated") return { state: "not_recorded", delayed: false };
  if (!["active", "retired"].includes(lifecycle(runtime))) return null;
  const found = await read(shipmentMailId(statsId, session), runtime.pipeline ?? redisPipeline);
  return found === "unknown" ? null : found ? view(found.row, (runtime.now ?? Date.now)()) : { state: "not_recorded", delayed: false };
}

export async function enqueueShipmentMail(input: { statsId: string | null; session: string; authorizedAt: number; shipped: { at: number; tracking: string }; message: ShipmentMailMessage }, runtime: ShipmentMailRuntime = {}): Promise<{ ok: true; mail: ShipmentMailView } | { ok: false; reason: "unknown" | "full" }> {
  if (lifecycle(runtime) !== "active") return { ok: false, reason: "unknown" };
  const snapshot = data(input);
  if (!snapshot) return { ok: false, reason: "unknown" };
  input = snapshot as typeof input;
  const now = (runtime.now ?? Date.now)();
  const p = shipmentMailPolicy(runtime.policy === undefined ? CURRENT_SHIPMENT_MAIL_POLICY : runtime.policy, now);
  if (!p || typeof input.statsId !== "string" || !STORE.test(input.statsId) ||
      typeof input.session !== "string" || !SESSION.test(input.session) || !integer(input.authorizedAt) || !canSeal()) return { ok: false, reason: "unknown" };
  try {
    const message = data(input.message);
    if (!message || Object.keys(message).length !== 5 || !["from", "to", "subject", "text", "replyTo"].every(key => typeof message[key] === "string")) return { ok: false, reason: "unknown" };
    const shipped = data(input.shipped);
    const source = readShippedRecord(shipped);
    if (!shipped || Object.keys(shipped).length !== 2 || !source) return { ok: false, reason: "unknown" };
    const plain = JSON.stringify(message);
    if (Buffer.byteLength(plain) > p.maxPayloadBytes) return { ok: false, reason: "full" };
    const id = shipmentMailId(input.statsId, input.session);
    const row: Row = { id, statsId: input.statsId, session: input.session, person: person(String(message.to)), sourceValue: JSON.stringify(source), sealed: seal(plain, context(id)), fingerprint: digest(plain), bytes: 0, created: now, authorizedAt: input.authorizedAt, next: now, state: "queued", owner: "", leaseUntil: 0, checks: 0, reviewId: p.reviewId };
    // Reserve all row growth, key/index overhead and pool bookkeeping before
    // writing. Real Redis memory measurements must cover this bound too.
    row.bytes = Buffer.byteLength(JSON.stringify(row)) + keys(row).reduce((n, key) => n + Buffer.byteLength(key), 0) * 2 + 8_192;
    if (!parseRow(JSON.stringify(row))) return { ok: false, reason: "unknown" };
    const result = await mutate("enqueue", row, "", p, runtime);
    if (result?.[0] === "full") return { ok: false, reason: "full" };
    if (result?.[0] === "legacy") return { ok: true, mail: { state: "not_recorded", delayed: false } };
    if (result?.[0] !== "queued" && result?.[0] !== "existing") return { ok: false, reason: "unknown" };
    const saved = parseRow(result[1]);
    if (!saved || saved.id !== id || saved.statsId !== row.statsId || saved.session !== row.session ||
        (result[0] === "queued" && (saved.fingerprint !== row.fingerprint || saved.sourceValue !== row.sourceValue)) ||
        (result[0] === "existing" && result[2] !== saved.sourceValue)) return { ok: false, reason: "unknown" };
    return { ok: true, mail: view(saved, now) };
  } catch { return { ok: false, reason: "unknown" }; }
}

export type ShipmentMailDispatch = (message: ShipmentMailMessage, beforePost: () => Promise<boolean>, context: { id: string }) => Promise<"accepted" | "waiting" | "not_accepted" | "refused" | "unknown">;
export async function runShipmentMail(deadline: number, dispatch: ShipmentMailDispatch, runtime: ShipmentMailRuntime = {}, onlyId?: string): Promise<{ accepted: number; waiting: number; unknown: number }> {
  if (lifecycle(runtime) !== "active") return { accepted: 0, waiting: 0, unknown: 1 };
  const counts = { accepted: 0, waiting: 0, unknown: 0 };
  const now = runtime.now ?? Date.now;
  const p = shipmentMailPolicy(runtime.policy === undefined ? CURRENT_SHIPMENT_MAIL_POLICY : runtime.policy, now(), false);
  if (!p) return { ...counts, unknown: 1 };
  const pipeline = runtime.pipeline ?? redisPipeline;
  if (onlyId === undefined && p.recovery) await recoverPendingMail("shipment", deadline, runtime, async id => {
    // Capture a successful raw observation separately from transport failure;
    // only the former may finish this snapshot position as known unsupported.
    try {
      const reply = ownArray(await pipeline([["TYPE", rowKey(id)], ["GETRANGE", rowKey(id), 0, SHIPMENT_MAIL_MAX_ROW_BYTES]]));
      if (!reply || reply.length !== 2 || typeof reply[1] !== "string") return null;
      if (reply[0] === "none" && reply[1] === "") return { raw: "" };
      if (reply[0] !== "string" || Buffer.byteLength(reply[1]) > SHIPMENT_MAIL_MAX_ROW_BYTES) return null;
      const row = parseRow(reply[1]);
      if (!row || row.id !== id) return { raw: reply[1] };
      const opened = unseal(row.sealed, context(id));
      if (!opened.ok || digest(opened.value) !== row.fingerprint) return { raw: reply[1] };
      return { raw: reply[1], keys: keys(row) };
    } catch { return null; }
  });
  let ids: unknown[] | null = null;
  try {
    if (onlyId !== undefined) {
      if (!HASH.test(onlyId)) throw Error("unknown shipment");
      ids = [onlyId];
    } else {
    const result = ownArray(await pipeline([["TYPE", SHIPMENT_MAIL_DUE], ["ZRANGEBYSCORE", SHIPMENT_MAIL_DUE, 0, now(), "LIMIT", 0, 25]]));
    if (!result || !["none", "zset"].includes(String(result[0])) || !Array.isArray(result[1]) || result[1].length > 25) throw Error("unknown queue");
    ids = result[1];
    if (ids.some(id => typeof id !== "string" || !HASH.test(id)) || new Set(ids).size !== ids.length) throw Error("unknown queue");
    }
  } catch { return { ...counts, unknown: 1 }; }
  for (const id of ids) {
    if (now() >= deadline) break;
    const found = await read(String(id), pipeline);
    if (!found || found === "unknown") { counts.unknown++; continue; }
    const owner = randomBytes(24).toString("hex");
    const claim = await mutate("claim", found.row, found.raw, p, runtime, owner);
    const claimed = claim?.[0] === "preparing" ? parseRow(claim[1]) : null;
    if (!claimed || claimed.owner !== owner || claimed.id !== id) { counts.unknown++; continue; }
    let raw = String(claim![1]);
    let row = claimed;
    const opened = unseal(row.sealed, context(row.id));
    let message: ShipmentMailMessage | null = null;
    if (opened.ok && digest(opened.value) === row.fingerprint) {
      try {
        const value = data(JSON.parse(opened.value));
        if (value && Object.keys(value).length === 5 && ["from", "to", "subject", "text", "replyTo"].every(key => typeof value[key] === "string") && person(String(value.to)) === row.person) message = value as unknown as ShipmentMailMessage;
      } catch { /* Retain protected evidence; it cannot authorize sending. */ }
    }
    let barrier = false;
    const beforePost = async () => {
      if (barrier || now() >= deadline || !shipmentMailPolicy(p, now(), false)) return false;
      const result = await mutate("dispatch", row, raw, p, runtime, owner);
      const next = result?.[0] === "dispatching" ? parseRow(result[1]) : null;
      if (!next || next.id !== row.id || next.owner !== owner) return false;
      raw = String(result![1]); row = next; barrier = true; return true;
    };
    let outcome: Awaited<ReturnType<ShipmentMailDispatch>> = "waiting";
    if (message) {
      try { outcome = await dispatch(message, beforePost, { id: row.id }); } catch { outcome = "unknown"; }
    }
    // A provider result without this call's confirmed barrier is never proof.
    if (!barrier) {
      const deferred = await mutate("defer", row, raw, p, runtime, owner);
      if (outcome === "waiting" && deferred?.[0] === "queued") counts.waiting++; else counts.unknown++;
      continue;
    }
    if (outcome === "unknown" || outcome === "waiting") { counts.unknown++; continue; }
    const result = await mutate(outcome === "accepted" ? "accepted" : outcome === "not_accepted" ? "not-accepted" : "refused", row, raw, p, runtime, owner);
    if (outcome === "accepted" && result?.[0] === "accepted") counts.accepted++;
    else if (outcome === "not_accepted" && result?.[0] === "queued") counts.waiting++;
    else counts.unknown++;
  }
  return counts;
}

/** No expiring generic erasure index: this bounded index lives with pending
 * payloads, including work older than 401 days. Erasure wins before dispatch
 * when its atomic cancellation precedes the dispatch barrier.
 */
export async function forgetShipmentMail(statsId: string | null | undefined, email?: string, runtime: ShipmentMailRuntime = {}): Promise<number> {
  if (lifecycle(runtime) === "never_activated") return 0;
  if (!["active", "retired"].includes(lifecycle(runtime))) throw Error("Shipment mail cleanup lifecycle is unknown");
  if (!statsId) return 0;
  if (!STORE.test(statsId)) throw Error("Shipment mail ownership is unknown");
  const pipeline = runtime.pipeline ?? redisPipeline;
  const index = email === undefined ? storeIndex(statsId) : personIndex(statsId, person(email));
  const fence = email === undefined ? storeFence(statsId) : personFence(statsId, person(email));
  const guarded = ownArray(await pipeline([["SET", fence, randomBytes(24).toString("hex")]]));
  if (!guarded || guarded.length !== 1 || guarded[0] !== "OK") throw Error("Shipment mail erasure fence was not confirmed");
  const got = ownArray(await pipeline([["TYPE", index], ["SCARD", index]]));
  if (!got || !["none", "set"].includes(String(got[0])) || !integer(got[1]) || got[1] > SHIPMENT_MAIL_MAX_INDEX_ITEMS) throw Error("Shipment mail deletion index is unknown");
  if (got[1] === 0) {
    const completed = ownArray(await pipeline([["PEXPIRE", fence, SHIPMENT_MAIL_ERASURE_FENCE_MS]]));
    if (!completed || completed.length !== 1 || completed[0] !== 1) throw Error("Shipment mail erasure completion was not confirmed");
    return 0;
  }
  const result = ownArray(await pipeline([["SMEMBERS", index]]));
  const ids = result?.length === 1 && Array.isArray(result[0]) ? result[0] as unknown[] : null;
  if (!ids || ids.length > SHIPMENT_MAIL_MAX_INDEX_ITEMS || ids.some(id => typeof id !== "string" || !HASH.test(id)) || new Set(ids).size !== ids.length) throw Error("Shipment mail deletion index is incomplete");
  let deleted = 0;
  for (const id of ids) {
    const found = await read(String(id), pipeline);
    if (!found || found === "unknown" || found.row.statsId !== statsId || (email !== undefined && found.row.person !== person(email))) throw Error("Shipment mail deletion ownership is unknown");
    const changed = await mutate("cancel", found.row, found.raw, null, runtime);
    if (changed?.[0] !== "canceled") throw Error("Shipment mail deletion was not confirmed");
    deleted++;
  }
  const completed = ownArray(await pipeline([["PEXPIRE", fence, SHIPMENT_MAIL_ERASURE_FENCE_MS]]));
  if (!completed || completed.length !== 1 || completed[0] !== 1) throw Error("Shipment mail erasure completion was not confirmed");
  return deleted;
}
