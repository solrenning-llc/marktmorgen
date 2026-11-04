/**
 * Whether an announcement is Amazon's own, from the one topic we listen to.
 *
 * Amazon SES tells us that an email bounced, or was marked as spam, by
 * posting to app/api/mail/ses through Amazon SNS. That address is public, as
 * every address a service posts to is, so each announcement is believed only
 * when all of this holds:
 *
 *   - it names the topic set in AWS_SES_TOPIC_ARN. Anybody with an Amazon
 *     account can make a topic and have Amazon sign what they post to it, so
 *     a true signature is not enough: it must be our topic;
 *   - it is signed with the certificate Amazon publishes for that region,
 *     fetched over HTTPS from sns.<region>.amazonaws.com and from nowhere
 *     else, whatever address the announcement itself gives;
 *   - the signature covers exactly the fields Amazon says it covers, in
 *     Amazon's order (docs.aws.amazon.com/sns/latest/dg/
 *     sns-verify-signature-of-message-verify-message-signature.html, read
 *     October 6, 2026);
 *   - it is no more than an hour old.
 */
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { SES_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import type { SesConfig } from "@/lib/ses";

export type SnsMessage = {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
};

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** The announcement's fields, each a string of a sane length, or null. */
export function readSns(raw: unknown): SnsMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const Type = v.Type;
  if (Type !== "Notification" && Type !== "SubscriptionConfirmation" && Type !== "UnsubscribeConfirmation") return null;
  const MessageId = text(v.MessageId, 200);
  const TopicArn = text(v.TopicArn, 400);
  const Message = text(v.Message, 250_000);
  const Timestamp = text(v.Timestamp, 40);
  const SignatureVersion = text(v.SignatureVersion, 4);
  const Signature = text(v.Signature, 2_000);
  const SigningCertURL = text(v.SigningCertURL, 500);
  if (!MessageId || !TopicArn || !Message || !Timestamp || !SignatureVersion || !Signature || !SigningCertURL) return null;
  const Subject = text(v.Subject, 1_000) ?? undefined;
  const Token = text(v.Token, 2_000) ?? undefined;
  const SubscribeURL = text(v.SubscribeURL, 2_000) ?? undefined;
  if (Type !== "Notification" && (!Token || !SubscribeURL)) return null;
  return { Type, MessageId, TopicArn, Message, Timestamp, SignatureVersion, Signature, SigningCertURL, Subject, Token, SubscribeURL };
}

/** An address on Amazon SNS's own host for this region, over HTTPS, or null. */
export function snsUrl(value: string | undefined, region: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    return url.hostname === `sns.${region}.amazonaws.com` ? url : null;
  } catch {
    return null;
  }
}

/** Exactly what Amazon signs: the fields it names, in its order, each on a line of its own. */
export function stringToSign(m: SnsMessage): string {
  const fields: [string, string | undefined][] =
    m.Type === "Notification"
      ? [["Message", m.Message], ["MessageId", m.MessageId], ["Subject", m.Subject], ["Timestamp", m.Timestamp], ["TopicArn", m.TopicArn], ["Type", m.Type]]
      : [["Message", m.Message], ["MessageId", m.MessageId], ["SubscribeURL", m.SubscribeURL], ["Timestamp", m.Timestamp], ["Token", m.Token], ["TopicArn", m.TopicArn], ["Type", m.Type]];
  return fields.filter((f): f is [string, string] => f[1] !== undefined).map(([name, value]) => `${name}\n${value}\n`).join("");
}

/** Amazon's certificates, by address. They change every few years; a function instance lives minutes. */
const certificates = new Map<string, KeyObject>();

async function certificate(url: URL): Promise<KeyObject | null> {
  const held = certificates.get(url.href);
  if (held) return held;
  try {
    const response = await timed(SES_TIMEOUT_MS, (signal) => fetch(url.href, { cache: "no-store", signal }));
    if (!response.ok) return null;
    const pem = (await response.text()).slice(0, 20_000);
    const key = createPublicKey(pem);
    if (certificates.size > 20) certificates.clear();
    certificates.set(url.href, key);
    return key;
  } catch (error) {
    console.error("Amazon's signing certificate could not be read", error);
    return null;
  }
}

export type SnsVerdict = "ok" | "topic" | "old" | "certificate" | "signature";

/** Whether the announcement is Amazon's, from our topic, and recent. */
export async function verifySns(m: SnsMessage, config: SesConfig, now = Date.now()): Promise<SnsVerdict> {
  if (m.TopicArn !== config.topicArn) return "topic";
  const at = Date.parse(m.Timestamp);
  if (!Number.isFinite(at) || Math.abs(now - at) > 3_600_000) return "old";
  const algorithm = m.SignatureVersion === "1" ? "RSA-SHA1" : m.SignatureVersion === "2" ? "RSA-SHA256" : null;
  const url = snsUrl(m.SigningCertURL, config.region);
  if (!algorithm || !url || !url.pathname.endsWith(".pem")) return "certificate";
  const key = await certificate(url);
  if (!key) return "certificate";
  try {
    return createVerify(algorithm).update(stringToSign(m), "utf8").verify(key, m.Signature, "base64") ? "ok" : "signature";
  } catch {
    return "signature";
  }
}

/** What one announcement from Amazon SES says became of an email: who bounced or complained, and the email's own tags. */
export type SesEvent = {
  kind: "delivered" | "delayed" | "bounced" | "complained";
  permanent: boolean;
  recipients: string[];
  tags: Record<string, string>;
  messageId: string;
  occurredAt?: number;
};

/** The delivery event inside an announcement, or null when it is not one we report. */
export function readSesEvent(message: string): SesEvent | null {
  let v: {
    eventType?: unknown;
    notificationType?: unknown;
    bounce?: { bounceType?: unknown; bouncedRecipients?: unknown };
    complaint?: { complainedRecipients?: unknown };
    delivery?: { recipients?: unknown };
    deliveryDelay?: { delayedRecipients?: unknown };
    mail?: { tags?: unknown; messageId?: unknown; timestamp?: unknown };
  };
  try {
    v = JSON.parse(message) as typeof v;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const type = typeof v.eventType === "string" ? v.eventType : typeof v.notificationType === "string" ? v.notificationType : "";
  const addresses = (list: unknown): string[] =>
    Array.isArray(list)
      ? list
          .map((r) => typeof r === "string" ? r : (r && typeof r === "object" ? (r as { emailAddress?: unknown }).emailAddress : null))
          .filter((a): a is string => typeof a === "string" && a.length > 0 && a.length <= 320)
          .slice(0, 50)
      : [];
  const tags: Record<string, string> = {};
  const raw = v.mail?.tags;
  if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string") tags[name] = first;
    }
  }
  const messageId = typeof v.mail?.messageId === "string" && v.mail.messageId.length <= 200 ? v.mail.messageId : "";
  const at = typeof v.mail?.timestamp === "string" ? Date.parse(v.mail.timestamp) : NaN;
  const occurred = Number.isSafeInteger(at) ? { occurredAt: at } : {};
  if (type === "Bounce") return { kind: "bounced", permanent: v.bounce?.bounceType === "Permanent", recipients: addresses(v.bounce?.bouncedRecipients), tags, messageId, ...occurred };
  if (type === "Complaint") return { kind: "complained", permanent: false, recipients: addresses(v.complaint?.complainedRecipients), tags, messageId, ...occurred };
  if (type === "Delivery") return { kind: "delivered", permanent: false, recipients: addresses(v.delivery?.recipients), tags, messageId, ...occurred };
  if (type === "DeliveryDelay") return { kind: "delayed", permanent: false, recipients: addresses(v.deliveryDelay?.delayedRecipients), tags, messageId, ...occurred };
  return null;
}
