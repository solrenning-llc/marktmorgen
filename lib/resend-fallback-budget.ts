/**
 * A paid, account-wide Resend fallback budget. This module sends no email.
 * GET /usage counts sent AND received in the actual billing period; it does
 * not itself disable paid overages or exclude other keys/SMTP/inbound traffic.
 * Sources checked November 1, 2026:
 * https://resend.com/changelog/account-usage-api
 * https://github.com/resend/resend-openapi/blob/main/resend.yaml
 * https://resend.com/pricing
 *
 * The real review is deliberately absent. A send caller must bind accountId
 * to the authenticated provider read, reserve, then obtain the one-time
 * dispatch receipt before POST. Neither a repeated reservation nor an
 * unknown Redis response authorizes POST. Do not translate a false send
 * result into confirmed_not_accepted: false can conceal uncertain acceptance.
 */
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

export const RESEND_FALLBACK_MAX_EMAILS = 50_000;
export const RESEND_FALLBACK_USAGE_MAX_AGE_MS = 60_000;
export const RESEND_FALLBACK_DISPATCH_MS = 1_000;
export const RESEND_FALLBACK_RECEIPT_MS = 35 * 86_400_000;
export const CURRENT_RESEND_FALLBACK_REVIEW: ResendFallbackReview | null = null;

export type ResendFallbackReview = {
  schema: 1;
  reviewId: string;
  accountId: string;
  paidPlan: "Pro";
  paidForPeriod: true;
  includedEmails: number;
  periodStartMs: number;
  resetsAtMs: number;
  checkedAtMs: number;
  validUntilMs: number;
  evidence: string;
  protection:
    | { kind: "inclusive_provider_hard_cap"; sentAndReceived: true; overagesDisabled: true; capEmails: number; evidence: string }
    | { kind: "isolated_account"; allSendersUseThisLedger: true; smtpDisabled: true; receivingDisabled: true; otherSendingPathsDisabled: true; evidence: string };
  /** Initialization is a separately reviewed action, never a missing-key default. */
  bootstrap?: { noUnresolvedPriorAttempts: true; allPriorUsageIncluded: true; evidence: string };
  /** A new resets_at alone cannot erase the preceding ledger. */
  previousPeriod?: { startMs: number; resetsAtMs: number; used: number; sent: number; received: number; providerPeriodClosed: true; noUnaccountedScheduledActivity: true; confirmedAtMs: number; evidence: string };
};
export type ResendFallbackUsage = {
  source: "resend_usage_api";
  accountId: string;
  observedAtMs: number;
  monthly: { used: number; sent: number; received: number; limit: number; resetsAt: string };
};
export type ResendFallbackSdk = { pipeline(commands: (string | number)[][]): Promise<unknown> };
export type ResendFallbackClaim = {
  accountId: string;
  attemptId: string;
  token: string;
  recipients: number;
  periodStartMs: number;
  resetsAtMs: number;
  validUntilMs: number;
  payloadFingerprint?: string;
  /** Only the one acknowledged dispatch invocation receives this capability. */
  dispatchToken?: string;
};
type Stopped = { status: "denied"; reason: string } | { status: "unknown" };
export type ResendFallbackReservation = Stopped | { status: "reserved" | "already_reserved"; claim: ResendFallbackClaim };
export type ResendFallbackDispatch = Stopped | { status: "dispatch"; claim: ResendFallbackClaim; sendBeforeMs: number; sendBeforeMonotonicMs: number };
export type ResendFallbackOutcome = "accepted" | "confirmed_not_accepted" | "unknown";
export type ResendFallbackSettlement = Stopped | { status: "settled" | "already_settled"; outcome: ResendFallbackOutcome };
export type ResendFallbackCancellation = Stopped | { status: "released" | "already_released" };
export type ResendFallbackAcceptedReceipt = Stopped | {
  status: "accepted"; accountId: string; attemptId: string; payloadFingerprint: string;
  recipients: number; acceptedAtMs: number; expiresAtMs: number;
};

/**
 * Two keys share an account hash tag, including on Redis Cluster. The ledger
 * has no TTL; pending/uncertain claims have none either. Final claims expire
 * after 35 days and are never refreshed on replay. At most 50,000 new claims
 * per reviewed billing period are admitted, even after known refusals, so
 * repeated refusals cannot grow stored tombstones without a bound.
 *
 * seenUsed, local accepted spend and pending reservations are intentionally
 * added conservatively: an observation may already include local accepts.
 * This may defer fallback sooner; it never releases estimated savings.
 */
export const RESEND_FALLBACK_BUDGET_LUA = `-- marktmorgen:resend-fallback-budget:v2
local op, account, token, attempt, fingerprint, dispatch = ARGV[1],ARGV[2],ARGV[3],ARGV[14],ARGV[21] or '',ARGV[22] or ''
local function integer(v)
 if type(v)~='string' or not string.match(v,'^%d+$') then return nil end
 local n=tonumber(v)
 if not n or n<0 or n>9007199254740991 or n~=math.floor(n) or string.format('%.0f',n)~=v then return nil end
 return n
end
local function text(n) return string.format('%.0f',n) end
local function hex(v,n) return type(v)=='string' and #v==n and string.match(v,'^[a-f0-9]+$') end
local function no(reason) return {'denied',reason} end
local now=integer(ARGV[7])
if not now or not hex(account,64) or not hex(attempt,64) or KEYS[1]==KEYS[2] or (fingerprint~='' and not hex(fingerprint,64)) then return no('arguments') end
local clock=redis.call('TIME')
local serverNow=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local kind=redis.call('TYPE',KEYS[1]).ok
local ledger=nil
if kind~='none' then
 if kind~='hash' or redis.call('TTL',KEYS[1])~=-1 or redis.call('HLEN',KEYS[1])~=10 then return no('ledger_shape') end
 ledger=redis.call('HMGET',KEYS[1],'schema','account','start','reset','seenAt','seenUsed','spent','held','attempts','cap')
 if ledger[1]~='1' or ledger[2]~=account then return no('ledger_identity') end
 for i=3,10 do ledger[i]=integer(ledger[i]); if not ledger[i] then return no('ledger_shape') end end
 if ledger[3]>=ledger[4] or ledger[7]>50000 or ledger[8]>50000 or ledger[9]>50000 or ledger[10]<1 or ledger[10]>50000 then return no('ledger_shape') end
end
local function readClaim()
 local claimKind=redis.call('TYPE',KEYS[2]).ok
 if claimKind=='none' then return nil end
 if claimKind~='hash' or redis.call('HLEN',KEYS[2])~=15 then return false end
 local c=redis.call('HMGET',KEYS[2],'schema','account','attempt','token','fingerprint','units','start','reset','until','state','dispatchToken','dispatchAt','dispatchBefore','acceptedAt','expiresAt')
 if c[1]~='2' or c[2]~=account or c[3]~=attempt or not hex(c[4],32) or (c[5]~='' and not hex(c[5],64)) then return false end
 for _,i in ipairs({6,7,8,9,12,13,14,15}) do c[i]=integer(c[i]); if not c[i] then return false end end
 if c[6]<1 or c[6]>100 or c[7]>=c[8] or c[9]<=c[7] or c[9]>c[8] then return false end
 local state=c[10]
 local dispatched=hex(c[11],32) and c[12]>=c[7] and c[12]<c[9] and c[13]>c[12] and c[13]<=math.min(c[12]+1000,c[9],c[8])
 local idle=c[11]=='' and c[12]==0 and c[13]==0
 local expiry=redis.call('PEXPIRETIME',KEYS[2])
 if state=='reserved' then
  if not idle or c[14]~=0 or c[15]~=0 or expiry~=-1 then return false end
 elseif state=='dispatched' or state=='unknown' then
  if not dispatched or c[14]~=0 or c[15]~=0 or expiry~=-1 then return false end
 elseif state=='accepted' then
  if not dispatched or c[14]<c[12] or c[15]~=c[14] + 3024000000 or expiry~=c[15] or serverNow<c[14] or serverNow>=c[15] then return false end
 elseif state=='released' then
  if not (idle or dispatched) or c[14]~=0 or c[15]<c[7] + 3024000000 or expiry~=c[15] or serverNow>=c[15] then return false end
 else return false end
 return c
end
if op=='receipt' then
 if not ledger then return no('uninitialized') end
 local c=readClaim()
 if not c or c[10]~='accepted' or fingerprint=='' or c[5]~=fingerprint or c[6]~=integer(ARGV[4]) then return no('receipt_unknown') end
 return {'accepted',account,attempt,c[5],text(c[6]),text(c[14]),text(c[15]),text(serverNow)}
end
if op=='initialize' or op=='reserve' then
 local start,reset,untilAt,cap,seenAt,seenUsed=integer(ARGV[5]),integer(ARGV[6]),integer(ARGV[8]),integer(ARGV[9]),integer(ARGV[10]),integer(ARGV[11])
 local sent,received=integer(ARGV[12]),integer(ARGV[13])
 if not start or not reset or not untilAt or not cap or not seenAt or not seenUsed or not sent or not received or cap<1 or cap>50000 or start>=reset or now<start or now>=reset or serverNow<start or serverNow>=reset or untilAt<=math.max(now,serverNow) or seenAt>math.min(now,serverNow) or math.max(now,serverNow)-seenAt>60000 or seenAt<start or sent>seenUsed or received~=seenUsed-sent then return no('arguments') end
 if op=='initialize' then
  if ledger then return {'already_initialized'} end
  if ARGV[20]~='bootstrap_reviewed' then return no('unreviewed_bootstrap') end
  if seenUsed>cap then return no('exhausted') end
  redis.call('HSET',KEYS[1],'schema','1','account',account,'start',ARGV[5],'reset',ARGV[6],'seenAt',ARGV[10],'seenUsed',ARGV[11],'spent','0','held','0','attempts','0','cap',ARGV[9])
  return {'initialized'}
 end
 if not ledger then return no('uninitialized') end
 local units=integer(ARGV[4])
 if not units or units<1 or units>100 or not hex(token,32) then return no('arguments') end
 if start~=ledger[3] or reset~=ledger[4] then
  local priorStart,priorReset,finalUsed,finalAt=integer(ARGV[15]),integer(ARGV[16]),integer(ARGV[17]),integer(ARGV[18])
  if ARGV[20]~='period_closed' or not priorStart or not priorReset or not finalUsed or not finalAt or priorStart~=ledger[3] or priorReset~=ledger[4] or start~=priorReset or math.min(now,serverNow)<priorReset or finalAt<priorReset or finalAt>seenAt or finalUsed<ledger[6] or finalUsed<ledger[7] or finalUsed>ledger[10] then return no('unreviewed_reset') end
  redis.call('HSET',KEYS[1],'start',ARGV[5],'reset',ARGV[6],'seenAt',ARGV[10],'seenUsed',ARGV[11],'spent','0','attempts','0','cap',ARGV[9])
  ledger[3],ledger[4],ledger[5],ledger[6],ledger[7],ledger[9],ledger[10]=start,reset,seenAt,seenUsed,0,0,cap
 else
  if seenAt<ledger[5] or seenUsed<ledger[6] then return no('usage_regressed') end
  cap=math.min(cap,ledger[10])
  redis.call('HSET',KEYS[1],'seenAt',ARGV[10],'seenUsed',ARGV[11],'cap',text(cap))
  ledger[5],ledger[6],ledger[10]=seenAt,seenUsed,cap
 end
 local old=readClaim()
 if old==false then return no('claim_shape') end
 if old then
  if old[6]~=units or old[5]~=fingerprint then return no('claim_conflict') end
  if old[10]=='reserved' then return {'already_reserved',old[4],text(old[6]),text(old[7]),text(old[8]),text(old[9])} end
  if old[10]~='released' then return no(old[10]=='accepted' and 'completed' or 'already_dispatched') end
 end
 if ledger[9]>=50000 then return no('attempt_capacity') end
 if ledger[6]>cap or ledger[7]+ledger[8]+units>cap-ledger[6] then return no('exhausted') end
 redis.call('HINCRBY',KEYS[1],'held',units)
 redis.call('HINCRBY',KEYS[1],'attempts',1)
 redis.call('HSET',KEYS[2],'schema','2','account',account,'attempt',attempt,'token',token,'fingerprint',fingerprint,'units',ARGV[4],'start',ARGV[5],'reset',ARGV[6],'until',ARGV[8],'state','reserved','dispatchToken','','dispatchAt','0','dispatchBefore','0','acceptedAt','0','expiresAt','0')
 if old then redis.call('PERSIST',KEYS[2]) end
 return {'reserved',token,ARGV[4],ARGV[5],ARGV[6],ARGV[8]}
end
if not ledger then return no('uninitialized') end
local c=readClaim()
if not c then return no('claim_shape') end
local units,start,reset,untilAt=c[6],c[7],c[8],c[9]
if c[4]~=token or c[5]~=fingerprint or units~=integer(ARGV[4]) or start~=integer(ARGV[5]) or reset~=integer(ARGV[6]) or untilAt~=integer(ARGV[8]) then return no('claim_conflict') end
if op=='cancel' then
 if c[10]=='released' then return {'already_released'} end
 if c[10]~='reserved' then return no('not_reserved') end
 if ledger[8]<units then return no('ledger_shape') end
 local expiry=serverNow + 3024000000
 redis.call('HSET',KEYS[2],'state','released','expiresAt',text(expiry))
 redis.call('PEXPIREAT',KEYS[2],expiry)
 redis.call('HINCRBY',KEYS[1],'held',-units)
 return {'released'}
end
if op=='dispatch' then
 if c[10]~='reserved' then return no('already_dispatched') end
 if not hex(dispatch,32) then return no('arguments') end
 if math.max(now,serverNow)>=untilAt or math.max(now,serverNow)>=reset or serverNow<start or start~=ledger[3] or reset~=ledger[4] then return no('expired') end
 if ledger[6]>ledger[10] or ledger[7]+ledger[8]>ledger[10]-ledger[6] then return no('exhausted') end
 local deadline=math.min(now+1000,serverNow+1000,untilAt,reset)
 if deadline<=math.max(now,serverNow) then return no('expired') end
 redis.call('HSET',KEYS[2],'state','dispatched','dispatchToken',dispatch,'dispatchAt',text(serverNow),'dispatchBefore',text(deadline))
 return {'dispatch',token,text(units),text(deadline),dispatch,text(serverNow)}
end
if op~='settle' then return no('operation') end
if not hex(dispatch,32) or c[11]~=dispatch then return no('dispatch_conflict') end
if c[10]=='accepted' then return {'already_settled','accepted'} end
if c[10]=='released' then return {'already_settled','confirmed_not_accepted'} end
if c[10]~='dispatched' and c[10]~='unknown' then return no('not_dispatched') end
local outcome=ARGV[19]
if outcome=='unknown' then
 redis.call('HSET',KEYS[2],'state','unknown')
 return {'settled','unknown'}
end
if outcome~='accepted' and outcome~='confirmed_not_accepted' then return no('outcome') end
if outcome=='accepted' and (serverNow>=ledger[4] or serverNow<ledger[3] or serverNow<c[12]) then return no('unreviewed_acceptance_period') end
if ledger[8]<units then return no('ledger_shape') end
-- Terminal provenance precedes financial effects. A partial failure can
-- retain excess hold/spend, but the same dispatch can never release twice.
local expiry=serverNow + 3024000000
redis.call('HSET',KEYS[2],'state',outcome=='accepted' and 'accepted' or 'released','acceptedAt',outcome=='accepted' and text(serverNow) or '0','expiresAt',text(expiry))
redis.call('PEXPIREAT',KEYS[2],expiry)
if outcome=='accepted' then redis.call('HINCRBY',KEYS[1],'spent',units) end
redis.call('HINCRBY',KEYS[1],'held',-units)
return {'settled',outcome}`;

const denied = (reason: string): Stopped => ({ status: "denied", reason });
const unknown = (): Stopped => ({ status: "unknown" });
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const label = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:_./-]{1,160}$/.test(value);
const evidence = (value: unknown): value is string => typeof value === "string" && value.trim().length >= 3 && value.length <= 2_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function resendFallbackBudgetKeys(accountId: string, attemptId: string): [string, string] {
  const account = digest(accountId);
  return [`nl:resend-budget:{${account}}:ledger`, `nl:resend-budget:{${account}}:claim:${digest(attemptId)}`];
}
type Parsed = { accountId: string; start: number; reset: number; validUntil: number; cap: number; seenAt: number; used: number; sent: number; received: number; bootstrap: boolean; prior: number[] };
function parse(review: unknown, usage: unknown, now: number): Parsed | null {
  try {
    const accountId = own(review, "accountId");
    if (!integer(now) || own(review, "schema") !== 1 || !label(own(review, "reviewId")) || !label(accountId) || own(review, "paidPlan") !== "Pro" || own(review, "paidForPeriod") !== true || !evidence(own(review, "evidence"))) return null;
    const start = own(review, "periodStartMs"), reset = own(review, "resetsAtMs"), checked = own(review, "checkedAtMs"), validUntil = own(review, "validUntilMs"), included = own(review, "includedEmails");
    if (![start, reset, checked, validUntil, included].every(integer) || !integer(start) || !integer(reset) || !integer(checked) || !integer(validUntil) || !integer(included) || included < 1 || start >= reset || reset - start < 20 * 86_400_000 || reset - start > 40 * 86_400_000 || now < start || now >= reset || checked > now || validUntil <= now || validUntil > reset) return null;
    const protection = own(review, "protection");
    if (!evidence(own(protection, "evidence"))) return null;
    const protectionKind = own(protection, "kind");
    let protectionCap = RESEND_FALLBACK_MAX_EMAILS;
    if (protectionKind === "inclusive_provider_hard_cap") {
      const hard = own(protection, "capEmails");
      if (own(protection, "sentAndReceived") !== true || own(protection, "overagesDisabled") !== true || !integer(hard) || hard < 1) return null;
      protectionCap = hard;
    } else if (protectionKind === "isolated_account") {
      if (["allSendersUseThisLedger", "smtpDisabled", "receivingDisabled", "otherSendingPathsDisabled"].some(key => own(protection, key) !== true)) return null;
    } else return null;
    if (own(usage, "source") !== "resend_usage_api" || own(usage, "accountId") !== accountId) return null;
    const seenAt = own(usage, "observedAtMs"), monthly = own(usage, "monthly");
    const used = own(monthly, "used"), sent = own(monthly, "sent"), received = own(monthly, "received"), limit = own(monthly, "limit"), resetsAt = own(monthly, "resetsAt");
    if (!integer(seenAt) || seenAt < checked || seenAt < start || seenAt > now || now - seenAt > RESEND_FALLBACK_USAGE_MAX_AGE_MS || !integer(used) || !integer(sent) || !integer(received) || !integer(limit) || limit < 1 || sent > used || received !== used - sent || typeof resetsAt !== "string" || resetsAt.length > 30 || Date.parse(resetsAt) !== reset || new Date(reset).toISOString() !== resetsAt) return null;
    const cap = Math.min(RESEND_FALLBACK_MAX_EMAILS, included, limit);
    // A provider hard cap above the included quota is not sufficient protection.
    if (protectionKind === "inclusive_provider_hard_cap" && protectionCap > cap) return null;
    const bootstrap = own(review, "bootstrap");
    const boot = own(bootstrap, "noUnresolvedPriorAttempts") === true && own(bootstrap, "allPriorUsageIncluded") === true && evidence(own(bootstrap, "evidence"));
    const previous = own(review, "previousPeriod");
    let prior = [0, 0, 0, 0];
    if (previous !== undefined) {
      const ps = own(previous, "startMs"), pr = own(previous, "resetsAtMs"), pu = own(previous, "used"), sentBefore = own(previous, "sent"), receivedBefore = own(previous, "received"), confirmed = own(previous, "confirmedAtMs");
      if (!integer(ps) || !integer(pr) || !integer(pu) || !integer(sentBefore) || !integer(receivedBefore) || !integer(confirmed) || ps >= pr || pr !== start || sentBefore > pu || receivedBefore !== pu - sentBefore || confirmed < pr || confirmed > seenAt || own(previous, "providerPeriodClosed") !== true || own(previous, "noUnaccountedScheduledActivity") !== true || !evidence(own(previous, "evidence"))) return null;
      prior = [ps, pr, pu, confirmed];
    }
    return { accountId, start, reset, validUntil, cap: Math.min(cap, protectionCap), seenAt, used, sent, received, bootstrap: !!boot, prior };
  } catch { return null; }
}
function claimData(value: unknown): ResendFallbackClaim | null {
  try {
    const accountId = own(value, "accountId"), attemptId = own(value, "attemptId"), token = own(value, "token"), recipients = own(value, "recipients"), start = own(value, "periodStartMs"), reset = own(value, "resetsAtMs"), until = own(value, "validUntilMs");
    const payloadFingerprint = own(value, "payloadFingerprint"), dispatchToken = own(value, "dispatchToken");
    if (!label(accountId) || !label(attemptId) || typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token) || !integer(recipients) || recipients < 1 || recipients > 100 || !integer(start) || !integer(reset) || !integer(until) || start >= reset || until > reset || until <= start
      || payloadFingerprint !== undefined && (typeof payloadFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payloadFingerprint))
      || dispatchToken !== undefined && (typeof dispatchToken !== "string" || !/^[a-f0-9]{32}$/.test(dispatchToken))) return null;
    return { accountId, attemptId, token, recipients, periodStartMs: start, resetsAtMs: reset, validUntilMs: until,
      ...(payloadFingerprint ? { payloadFingerprint } : {}), ...(dispatchToken ? { dispatchToken } : {}) };
  } catch { return null; }
}
function arrayData(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !integer(length.value) || length.value > 12
    || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== length.value + 1) return null;
  const copy: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    copy.push(descriptor.value);
  }
  return copy;
}
async function execute(sdk: ResendFallbackSdk, accountId: string, attemptId: string, args: (string | number)[]): Promise<unknown[] | null> {
  try {
    const reply = arrayData(await sdk.pipeline([["EVAL", RESEND_FALLBACK_BUDGET_LUA, 2, ...resendFallbackBudgetKeys(accountId, attemptId), ...args]]));
    return reply?.length === 1 ? arrayData(reply[0]) : null;
  } catch { return null; }
}
const stoppedReply = (reply: unknown[] | null): Stopped => reply?.length === 2 && reply[0] === "denied" && typeof reply[1] === "string" && /^[a-z_]{1,80}$/.test(reply[1]) ? denied(reply[1]) : unknown();
const asInteger = (value: unknown): number | null => typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
function argsFor(op: string, data: Parsed, attemptId: string, token: string, recipients: number, now: number): (string | number)[] {
  return [op, digest(data.accountId), token, recipients, data.start, data.reset, now, data.validUntil, data.cap, data.seenAt, data.used, data.sent, data.received, digest(attemptId), ...data.prior, "", data.prior[1] ? "period_closed" : ""];
}
export async function initializeResendFallbackBudget(input: { review?: unknown; usage: unknown }, sdk: ResendFallbackSdk): Promise<Stopped | { status: "initialized" | "already_initialized" }> {
  let data: Parsed | null;
  const now = Date.now();
  try { data = parse(own(input, "review") ?? CURRENT_RESEND_FALLBACK_REVIEW, own(input, "usage"), now); } catch { data = null; }
  if (!data || !data.bootstrap) return denied("unreviewed_bootstrap");
  const args = argsFor("initialize", data, "bootstrap", "", 0, now); args[19] = "bootstrap_reviewed";
  const reply = await execute(sdk, data.accountId, "bootstrap", args);
  return reply?.length === 1 && (reply[0] === "initialized" || reply[0] === "already_initialized") ? { status: reply[0] } : stoppedReply(reply);
}
/** attemptId identifies a send intent, never just a payload hash. Callers
 * without a stable final idempotency key must use a fresh per-call nonce in
 * that identity. Equal bodies alone do not mean the same intentional send.
 */
export async function reserveResendFallback(input: { review?: unknown; usage: unknown; attemptId: string; recipients: number; payloadFingerprint?: string }, sdk: ResendFallbackSdk): Promise<ResendFallbackReservation> {
  const now = Date.now();
  let data: Parsed | null, attemptId: unknown, recipients: unknown, payloadFingerprint: unknown;
  try { data = parse(own(input, "review") ?? CURRENT_RESEND_FALLBACK_REVIEW, own(input, "usage"), now); attemptId = own(input, "attemptId"); recipients = own(input, "recipients"); payloadFingerprint = own(input, "payloadFingerprint"); } catch { return denied("unreviewed_account"); }
  if (!data || !label(attemptId) || !integer(recipients) || recipients < 1 || recipients > 100
    || payloadFingerprint !== undefined && (typeof payloadFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payloadFingerprint))) return denied("unreviewed_account");
  const token = randomBytes(16).toString("hex");
  const args = [...argsFor("reserve", data, attemptId, token, recipients, now), payloadFingerprint ?? "", ""];
  const reply = await execute(sdk, data.accountId, attemptId, args);
  if (reply?.length !== 6 || reply[0] !== "reserved" && reply[0] !== "already_reserved") return stoppedReply(reply);
  const claim = claimData({ accountId: data.accountId, attemptId, token: reply[1], recipients: asInteger(reply[2]), periodStartMs: asInteger(reply[3]), resetsAtMs: asInteger(reply[4]), validUntilMs: asInteger(reply[5]), ...(payloadFingerprint ? { payloadFingerprint } : {}) });
  if (!claim || claim.recipients !== recipients || reply[0] === "reserved" && (claim.token !== token || claim.periodStartMs !== data.start || claim.resetsAtMs !== data.reset || claim.validUntilMs !== data.validUntil)) return unknown();
  return { status: reply[0], claim };
}
const claimArgs = (op: string, claim: ResendFallbackClaim, now: number, outcome = "") => [op, digest(claim.accountId), claim.token, claim.recipients, claim.periodStartMs, claim.resetsAtMs, now, claim.validUntilMs, 0, 0, 0, 0, 0, digest(claim.attemptId), 0, 0, 0, 0, outcome, "", claim.payloadFingerprint ?? "", claim.dispatchToken ?? ""];
export async function markResendFallbackDispatched(value: ResendFallbackClaim, sdk: ResendFallbackSdk): Promise<ResendFallbackDispatch> {
  const claim = claimData(value), now = Date.now();
  if (!claim || !integer(now) || now < claim.periodStartMs || now >= claim.validUntilMs || now >= claim.resetsAtMs) return denied("expired");
  const dispatchToken = randomBytes(16).toString("hex");
  // Start BEFORE the RPC: treating the complete RTT as elapsed consumes more
  // of Redis's remaining authorization, never less. Worker UTC may be stale
  // or frozen; it cannot supply the post-ACK lifetime of this permission.
  const startedMonotonicMs = performance.now();
  const reply = await execute(sdk, claim.accountId, claim.attemptId, claimArgs("dispatch", { ...claim, dispatchToken }, now));
  const deadline = reply?.length === 6 ? asInteger(reply[3]) : null;
  const serverNow = reply?.length === 6 ? asInteger(reply[5]) : null;
  if (reply?.[0] !== "dispatch" || reply[1] !== claim.token || reply[4] !== dispatchToken || asInteger(reply[2]) !== claim.recipients || deadline === null || serverNow === null
    || serverNow < claim.periodStartMs || deadline <= Math.max(now, serverNow)
    || deadline > Math.min(now + RESEND_FALLBACK_DISPATCH_MS, serverNow + RESEND_FALLBACK_DISPATCH_MS, claim.validUntilMs, claim.resetsAtMs)) return stoppedReply(reply);
  const sendBeforeMonotonicMs = startedMonotonicMs + (deadline - serverNow);
  // No permission is returned if a delayed ACK already consumed it. A caller
  // must recheck BOTH this monotonic deadline and sendBeforeMs immediately
  // before POST, with no intervening await or callback.
  if (!Number.isFinite(startedMonotonicMs) || startedMonotonicMs < 0 || !Number.isFinite(sendBeforeMonotonicMs) || performance.now() >= sendBeforeMonotonicMs) return unknown();
  return { status: "dispatch", claim: { ...claim, dispatchToken }, sendBeforeMs: deadline, sendBeforeMonotonicMs };
}
/** Local refusal before dispatch is not an HTTP outcome. This CAS cannot
 * release a shared reservation after another invocation won dispatch.
 */
export async function cancelResendFallbackReserved(value: ResendFallbackClaim, sdk: ResendFallbackSdk): Promise<ResendFallbackCancellation> {
  const claim = claimData(value), now = Date.now();
  if (!claim || !integer(now)) return denied("arguments");
  const reply = await execute(sdk, claim.accountId, claim.attemptId, claimArgs("cancel", claim, now));
  return reply?.length === 1 && (reply[0] === "released" || reply[0] === "already_released") ? { status: reply[0] } : stoppedReply(reply);
}
export async function settleResendFallback(value: ResendFallbackClaim, outcome: ResendFallbackOutcome, sdk: ResendFallbackSdk): Promise<ResendFallbackSettlement> {
  const claim = claimData(value), now = Date.now();
  if (!claim || !integer(now) || !["accepted", "confirmed_not_accepted", "unknown"].includes(outcome)) return denied("arguments");
  if (!claim.dispatchToken) return denied("unconfirmed_dispatch");
  const reply = await execute(sdk, claim.accountId, claim.attemptId, claimArgs("settle", claim, now, outcome));
  if (reply?.length === 2 && (reply[0] === "settled" && reply[1] === outcome || reply[0] === "already_settled" && (reply[1] === "accepted" || reply[1] === "confirmed_not_accepted"))) return { status: reply[0], outcome: reply[1] as ResendFallbackOutcome };
  return stoppedReply(reply);
}

/** Read-only proof of a previously confirmed HTTP acceptance. This never
 * grants dispatch and never interprets a denial's text as a successful send.
 * Legacy claims lacking a payload fingerprint cannot supply this receipt.
 */
export async function readAcceptedResendFallbackReceipt(input: { accountId: string; attemptId: string; payloadFingerprint: string; recipients: number }, sdk: ResendFallbackSdk): Promise<ResendFallbackAcceptedReceipt> {
  try {
    const accountId = own(input, "accountId"), attemptId = own(input, "attemptId"), fp = own(input, "payloadFingerprint"), units = own(input, "recipients"), now = Date.now();
    if (!label(accountId) || !label(attemptId) || typeof fp !== "string" || !/^[a-f0-9]{64}$/.test(fp) || !integer(units) || units < 1 || units > 100 || !integer(now)) return denied("arguments");
    const args = ["receipt", digest(accountId), "", units, 0, 0, now, 0, 0, 0, 0, 0, 0, digest(attemptId), 0, 0, 0, 0, "", "", fp, ""];
    const reply = await execute(sdk, accountId, attemptId, args);
    if (reply?.length !== 8 || reply[0] !== "accepted" || reply[1] !== digest(accountId) || reply[2] !== digest(attemptId) || reply[3] !== fp || asInteger(reply[4]) !== units) return unknown();
    const acceptedAt = asInteger(reply[5]), expiresAt = asInteger(reply[6]), serverNow = asInteger(reply[7]);
    if (acceptedAt === null || expiresAt === null || serverNow === null || acceptedAt < 1 || expiresAt - acceptedAt !== RESEND_FALLBACK_RECEIPT_MS || serverNow < acceptedAt || serverNow >= expiresAt) return unknown();
    return { status: "accepted", accountId, attemptId, payloadFingerprint: fp, recipients: units, acceptedAtMs: acceptedAt, expiresAtMs: expiresAt };
  } catch { return unknown(); }
}
