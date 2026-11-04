/** Aggregate provider outcomes for one broadcast or sequence email. */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import {
  HEALTH_ID,
  MAIL_HEALTH_DAY_SECONDS,
  MAIL_REPORT_TAG,
  mailHealthDayKey,
  mailReportCampaign,
} from "@/lib/mail-health";

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

/** Count one signed provider event. No recipient identifier is accepted or kept. */
export async function noteMailReportEvent(
  store: string,
  campaign: string,
  event: MailReportEvent,
  count: number,
  providerIdentity: string,
  now = Date.now(),
): Promise<boolean> {
  const report = mailReportCampaign(campaign);
  if (!HEALTH_ID.test(store) || !report || !Number.isSafeInteger(count) || count <= 0 || count > 50 ||
      typeof providerIdentity !== "string" || providerIdentity.length < 3 || providerIdentity.length > 240 || !isRedisConfigured()) return false;
  const key = mailHealthDayKey(store, now);
  const identity = createHash("sha256").update(providerIdentity).digest("hex").slice(0, 32);
  await redisPipeline([
    // One field per provider email/outcome: a replay overwrites the same
    // value, even when its webhook delivery carries a new id.
    ["HSET", key, `${prefixes(report)[event]}${identity}`, count],
    ["EXPIRE", key, MAIL_HEALTH_DAY_SECONDS],
  ]);
  return true;
}

const readCount = (value: unknown): number | null => {
  if (value === null) return 0;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
};

/** One confirmed UTC day's aggregate. Null means the stored answer was not trustworthy. */
export async function mailReportDay(store: string, campaign: string, now = Date.now()): Promise<MailReportCounts | null> {
  const report = mailReportCampaign(campaign);
  if (!HEALTH_ID.test(store) || !report || !isRedisConfigured()) return null;
  const reply = await redisPipeline([["HGETALL", mailHealthDayKey(store, now)]]);
  if (!Array.isArray(reply) || !Array.isArray(reply[0]) || reply[0].length % 2 !== 0) return null;
  const wanted = prefixes(report);
  const total: Record<MailReportEvent, number> = { delivered: 0, "permanent-bounce": 0, "temporary-bounce": 0, complained: 0 };
  for (let i = 0; i < reply[0].length; i += 2) {
    const field: unknown = reply[0][i];
    if (typeof field !== "string") return null;
    const event = (Object.keys(wanted) as MailReportEvent[]).find((kind) => field.startsWith(wanted[kind]));
    if (!event) continue;
    if (!/^[0-9a-f]{32}$/.test(field.slice(wanted[event].length))) return null;
    const count = readCount(reply[0][i + 1]);
    if (count === null || !Number.isSafeInteger(total[event] + count)) return null;
    total[event] += count;
  }
  return { delivered: total.delivered, permanentBounces: total["permanent-bounce"], temporaryBounces: total["temporary-bounce"], complained: total.complained };
}
