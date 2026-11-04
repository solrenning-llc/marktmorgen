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
  let observed = false;
  for (let i = 0; i < reply[0].length; i += 2) {
    const field: unknown = reply[0][i];
    if (typeof field !== "string") return null;
    const event = (Object.keys(wanted) as MailReportEvent[]).find((kind) => field.startsWith(wanted[kind]));
    if (!event) continue;
    observed = true;
    if (!/^[0-9a-f]{32}$/.test(field.slice(wanted[event].length))) return null;
    const count = readCount(reply[0][i + 1]);
    if (count === null || !Number.isSafeInteger(total[event] + count)) return null;
    total[event] += count;
  }
  if (!observed) return null;
  return { delivered: total.delivered, permanentBounces: total["permanent-bounce"], temporaryBounces: total["temporary-bounce"], complained: total.complained };
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
  const reported = await noteMailReportEvent(event.tags[STORE_TAG] ?? "", event.tags[MAIL_REPORT_TAG] ?? "", reportEvent, event.recipients.length, event.messageId ? `ses:${event.messageId}` : "");
  if (!reported && (event.kind === "delivered" || event.kind === "delayed")) return null;
  const reportResult = reportEvent === "delivered" ? "delivered" : reportEvent === "temporary-bounce" ? "temporary" : "counted";
  return results.includes("paused") ? "paused" : results.includes("counted") ? "counted" : reported ? reportResult : "ignored";
}
