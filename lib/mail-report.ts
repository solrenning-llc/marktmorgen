/** Aggregate provider outcomes for one broadcast or sequence email. */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import {
  HEALTH_ID,
  LIST_TAG,
  STORE_TAG,
  heardFromSender,
  MAIL_HEALTH_DAY_SECONDS,
  MAIL_REPORT_TAG,
  mailHealthDayKey,
  mailReportCampaign,
} from "@/lib/mail-health";

import type { SesEvent } from "@/lib/sns";
import { SCALE_MONTHLY_EMAILS, TRIAL_MONTHLY_EMAILS } from "@/lib/plan";

export { MAIL_REPORT_TAG };

export type MailReportEvent = "delivered" | "permanent-bounce" | "temporary-bounce" | "complained";
export type MailReportCounts = {
  delivered: number;
  permanentBounces: number;
  temporaryBounces: number;
  complained: number;
};

const CODE: Record<MailReportEvent, string> = {
  delivered: "d",
  "permanent-bounce": "p",
  "temporary-bounce": "t",
  complained: "c",
};
const prefixes = (campaign: string) => Object.fromEntries(
  Object.entries(CODE).map(([event, code]) => [event, `r:${campaign}:${code}:`]),
) as Record<MailReportEvent, string>;

/** Two billing windows can overlap the retained ten UTC days. Each sent
 * message leaves at most four receipts and four campaign counter fields.
 * This is an internal storage bound derived from existing send allowances. */
export const MAIL_REPORT_MAX_FIELDS = 3 + 2 * Math.max(SCALE_MONTHLY_EMAILS, TRIAL_MONTHLY_EMAILS) * 8;
export const RECORD_MAIL_REPORT = `-- marktmorgen:mail-report:v1
local t=redis.call('TYPE',KEYS[1]).ok
if t~='none' and t~='hash' then return -1 end
local old=redis.call('HGET',KEYS[1],ARGV[1])
if old then
  if old==ARGV[3] then return 2 end
  return -1
end
local total=redis.call('HGET',KEYS[1],ARGV[2])
if total and (not string.match(total,'^%d+$') or tonumber(total)>1000000000) then return -1 end
local size=redis.call('HLEN',KEYS[1])
local need=total and 1 or 2
if size+need>tonumber(ARGV[5]) then return -1 end
redis.call('HSET',KEYS[1],ARGV[1],ARGV[3])
redis.call('HINCRBY',KEYS[1],ARGV[2],ARGV[3])
redis.call('EXPIREAT',KEYS[1],ARGV[4])
return 1`;

/** Count one signed provider event. No recipient identifier is accepted or kept. */
export async function noteMailReportEvent(
  store: string,
  campaign: string,
  event: MailReportEvent,
  count: number,
  providerIdentity: string,
  occurredAt: number | undefined,
  now = Date.now(),
): Promise<boolean> {
  const report = mailReportCampaign(campaign);
  if (!HEALTH_ID.test(store) || !report || !Number.isSafeInteger(count) || count <= 0 || count > 50 ||
      typeof providerIdentity !== "string" || providerIdentity.length < 3 || providerIdentity.length > 240 ||
      typeof occurredAt !== "number" || !Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > now + 5_000 ||
      now - occurredAt >= MAIL_HEALTH_DAY_SECONDS * 1000 || !isRedisConfigured()) return false;
  const key = mailHealthDayKey(store, occurredAt);
  const expiresAt = Math.floor(occurredAt / 86_400_000) * 86_400 + MAIL_HEALTH_DAY_SECONDS;
  if (expiresAt * 1000 <= now) return false;
  const identity = createHash("sha256").update(providerIdentity).digest("hex").slice(0, 32);
  const prefix = prefixes(report)[event];
  const reply = await redisPipeline([["EVAL", RECORD_MAIL_REPORT, 1, key, `${prefix}${identity}`, prefix, count, expiresAt, MAIL_REPORT_MAX_FIELDS]]);
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== 1 && reply[0] !== 2)) throw new Error("The delivery report write is unconfirmed");
  return true;
}

const readCount = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
};

/** One confirmed UTC day's aggregate. Null means the stored answer was not trustworthy. */
export async function mailReportDay(store: string, campaign: string, now = Date.now()): Promise<MailReportCounts | null> {
  const report = mailReportCampaign(campaign);
  if (!HEALTH_ID.test(store) || !report || !isRedisConfigured()) return null;
  const wanted = prefixes(report);
  const reply = await redisPipeline([["HMGET", mailHealthDayKey(store, now), wanted.delivered, wanted["permanent-bounce"], wanted["temporary-bounce"], wanted.complained]]);
  if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(reply[0]) || reply[0].length !== 4 || reply[0].every(value => value === null)) return null;
  const counts = reply[0].map(value => value === null ? 0 : readCount(value));
  if (counts.some(value => value === null)) return null;
  return { delivered: counts[0]!, permanentBounces: counts[1]!, temporaryBounces: counts[2]!, complained: counts[3]! };
}

/** Apply one already-authenticated SES outcome. Kept separate so its aggregate behavior is tested without bypassing POST authentication. */
export async function recordSesEvent(event: SesEvent): Promise<"paused" | "counted" | "delivered" | "temporary" | "ignored" | null> {
  const results: string[] = [];
  if ((event.kind === "bounced" || event.kind === "complained") && (event.kind === "complained" || event.permanent)) {
    for (const to of event.recipients) {
      results.push(await heardFromSender({ kind: event.kind, permanent: event.permanent, to, store: event.tags[STORE_TAG] ?? "", list: event.tags[LIST_TAG] ?? "" }));
    }
  }
  const reportEvent: MailReportEvent = event.kind === "delivered"
    ? "delivered"
    : event.kind === "complained"
      ? "complained"
      : event.permanent ? "permanent-bounce" : "temporary-bounce";
  const reported = await noteMailReportEvent(event.tags[STORE_TAG] ?? "", event.tags[MAIL_REPORT_TAG] ?? "", reportEvent, event.recipients.length, event.messageId ? `ses:${event.messageId}` : "", event.occurredAt);
  if (!reported && (event.kind === "delivered" || event.kind === "delayed")) return null;
  const reportResult = reportEvent === "delivered" ? "delivered" : reportEvent === "temporary-bounce" ? "temporary" : "counted";
  return results.includes("paused") ? "paused" : results.includes("counted") ? "counted" : reported ? reportResult : "ignored";
}
