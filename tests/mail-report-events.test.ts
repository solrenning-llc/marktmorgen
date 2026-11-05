/**
 * Delivery reports belong to the email, never to a recipient.  These checks
 * exercise the signed Resend route and Amazon's event reader, including the
 * distinction between a temporary and a permanent bounce.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { recordSesEvent } from "@/lib/mail-report";
import { healthTags } from "@/lib/mail-health";
import { MAIL_REPORT_TAG, RECORD_MAIL_REPORT, mailReportDay, noteMailReportEvent } from "@/lib/mail-report";
import { readSesEvent } from "@/lib/sns";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import * as callbackCosts from "./plan-cost-registry";

const SECRET = Buffer.from("mail-report-events-test-secret");
const STORE = "0123456789abcdef0123456789abcdef";
const LIST = "fedcba9876543210fedcba9876543210";
const CAMPAIGN = "b-0123456789abcdef01234567";
const EVENT_AT = new Date().toISOString();
let id = 0;

function announce(type: string, data: Record<string, unknown>, sameId?: string): NextRequest {
  const eventId = sameId ?? `report_${++id}`;
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type, created_at: EVENT_AT, data });
  const signature = createHmac("sha256", SECRET).update(`${eventId}.${at}.${body}`).digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: {
      host: "marktmorgen.com",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "svix-id": eventId,
      "svix-timestamp": at,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

const tags = { nl_store: STORE, nl_list: LIST, [MAIL_REPORT_TAG]: CAMPAIGN };

async function main() {
  redis.clear();
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET.toString("base64")}`;
  is("an email with no recorded provider outcome is unavailable", await mailReportDay(STORE, CAMPAIGN), null);

  part("One shared email identity goes to the providers");
  is(
    "the report tag is shared by the whole email and contains no recipient",
    healthTags({ sid: STORE, listId: LIST }, true, CAMPAIGN),
    { nl_store: STORE, nl_list: LIST, [MAIL_REPORT_TAG]: CAMPAIGN },
  );
  is(
    "an arbitrary provider tag cannot create a report field",
    healthTags({ sid: STORE, listId: LIST }, true, "reader@example.test"),
    { nl_store: STORE, nl_list: LIST },
  );

  part("Amazon events retain their distinct meanings");
  is(
    "delivery recipients are read without being retained in the report identity",
    readSesEvent(JSON.stringify({ eventType: "Delivery", delivery: { recipients: ["reader@example.test"] }, mail: { messageId: "ses_delivery_1", tags: { ...tags, other: ["x"] } } })),
    { kind: "delivered", permanent: false, recipients: ["reader@example.test"], tags: { ...tags, other: "x" }, messageId: "ses_delivery_1" },
  );
  is(
    "a transient bounce remains temporary",
    readSesEvent(JSON.stringify({ eventType: "Bounce", bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "full@example.test" }] }, mail: { messageId: "ses_bounce_1", tags } })),
    { kind: "bounced", permanent: false, recipients: ["full@example.test"], tags, messageId: "ses_bounce_1" },
  );
  is(
    "a delivery delay is the provider's other temporary outcome",
    readSesEvent(JSON.stringify({ eventType: "DeliveryDelay", deliveryDelay: { delayedRecipients: [{ emailAddress: "slow@example.test" }] }, mail: { messageId: "ses_delay_1", tags } })),
    { kind: "delayed", permanent: false, recipients: ["slow@example.test"], tags, messageId: "ses_delay_1" },
  );
  const sesCampaign = "b-abcdef0123456789abcdef01";
  const previousDay = new Date(Date.now() - 86_400_000).toISOString();
  is("SES uses the delivery event time, not the earlier send time", readSesEvent(JSON.stringify({ eventType: "Delivery", delivery: { timestamp: EVENT_AT, recipients: ["reader@example.test"] }, mail: { timestamp: previousDay, messageId: "ses_cross_midnight", tags } }))?.occurredAt, Date.parse(EVENT_AT));
  for (const [kind, field] of [["Bounce", "bounce"], ["Complaint", "complaint"], ["DeliveryDelay", "deliveryDelay"]]) {
    is(`${kind} uses its own event timestamp`, readSesEvent(JSON.stringify({ eventType: kind, [field]: { timestamp: EVENT_AT }, mail: { timestamp: previousDay, messageId: `ses_${kind}`, tags } }))?.occurredAt, Date.parse(EVENT_AT));
  }
  const sesTags = { nl_store: STORE, nl_list: LIST, [MAIL_REPORT_TAG]: sesCampaign };
  is("the authenticated SES route action records delivery", await recordSesEvent({ kind: "delivered", permanent: false, recipients: ["ses@example.test"], tags: sesTags, messageId: "ses_delivery_2", occurredAt: Date.now() }), "delivered");
  is("and records a temporary outcome without treating it as permanent", await recordSesEvent({ kind: "delayed", permanent: false, recipients: ["ses@example.test"], tags: sesTags, messageId: "ses_delay_2", occurredAt: Date.now() }), "temporary");
  is("the SES outcomes remain separate", await mailReportDay(STORE, sesCampaign), { delivered: 1, permanentBounces: 0, temporaryBounces: 1, complained: 0 });

  part("Signed outcomes are counted for the email, without recipient data");
  const delivered = await POST(announce("email.delivered", { email_id: "em_1", to: ["reader@example.test"], tags }));
  const delayed = await POST(announce("email.delivery_delayed", { email_id: "em_1", to: ["full@example.test"], tags, bounce: { type: "Transient" } }, "report_delay"));
  is("delivery and delay are acknowledged as report outcomes", [await delivered.json(), await delayed.json()], [
    { ok: true, result: "delivered" },
    { ok: true, result: "temporary" },
  ]);
  is("they are separate counters", await mailReportDay(STORE, CAMPAIGN), {
    delivered: 1,
    permanentBounces: 0,
    temporaryBounces: 1,
    complained: 0,
  });

  await POST(announce("email.delivery_delayed", { email_id: "em_1", to: ["full@example.test"], tags, bounce: { type: "Transient" } }, "report_delay"));
  is("the same signed event is not counted twice", (await mailReportDay(STORE, CAMPAIGN))?.temporaryBounces, 1);
  await POST(announce("email.delivery_delayed", { email_id: "em_1", to: ["full@example.test"], tags, bounce: { type: "Transient" } }));
  is("a provider replay under another webhook id is still the same email outcome", (await mailReportDay(STORE, CAMPAIGN))?.temporaryBounces, 1);
  is("temporary delivery trouble never creates a pause or recipient mark", redis.keys().some((key) => key.startsWith(`nl:mail:paused:${STORE}`) || key.startsWith(`nl:mail:health:${STORE}:seen:`)), false);
  for (const bounceType of ["Transient", "Undetermined"]) {
    const event = readSesEvent(JSON.stringify({ eventType: "Bounce", bounce: { bounceType, timestamp: EVENT_AT, bouncedRecipients: [{ emailAddress: "temporary@example.test" }] }, mail: { messageId: `ses_${bounceType}`, timestamp: EVENT_AT, tags } }));
    is(`${bounceType} is explicitly non-permanent`, event?.permanent, false);
    is(`${bounceType} records only a temporary SES outcome`, event && await recordSesEvent(event), "temporary");
    const answer = await POST(announce("email.bounced", { email_id: `resend_${bounceType}`, to: ["temporary@example.test"], tags, bounce: { type: bounceType } }));
    is(`${bounceType} records only a temporary Resend outcome`, await answer.json(), { ok: true, result: "temporary" });
  }
  is("neither temporary bounce type removes recipients or writes health/pause state", redis.keys().some(key => key.startsWith(`nl:mail:paused:${STORE}`) || key.startsWith(`nl:mail:health:${STORE}:seen:`)), false);
  part("Every delivered email brings its own callback bill");
  const price = (callbackCosts as unknown as { mailReportCallbackCost?: (deliveries: number, attempts: number, snsTransferPerGb: number | null) => { notices: number; invocations: number; redisCommands: number; totalUsd: number } | null }).mailReportCallbackCost;
  is("callback costing is executable, not a null component placeholder", typeof price, "function");
  if (price) {
    const one = price(1, 1, 0.2);
    is("one delivered email is one notice, one invocation and eleven Redis commands", one && [one.notices, one.invocations, one.redisCommands], [1, 1, 11]);
    is("SNS, hosting, commands, transferred/retained bytes all cost money", Boolean(one && one.totalUsd > 0.0012), true);
    is("the whole allowance is counted, with no provider free tier", price(10_000, 1, 0.2)?.totalUsd, one && one.totalUsd * 10_000);
    is("a retry still costs an invocation and commands despite no second outcome", price(1, 101, 0.2)?.invocations, 101);
    is("unknown regional SNS transfer never becomes a zero-cost callback", price(1, 1, null), null);
    for (const bad of [-1, NaN, Infinity, 0.5]) is("invalid counts never acquire a price", price(bad, 1, 0.2), null);
  }
  is("no key or report field contains a recipient address", [
    redis.keys().some((key) => key.includes("reader@") || key.includes("full@")),
    String(redis.run(["HGETALL", `nl:mail:health:${STORE}:${new Date().toISOString().slice(0, 10)}`])).includes("@"),
  ], [false, false]);

  const originalNow = Date.now;
  const reportKey = `nl:mail:health:${STORE}:${new Date().toISOString().slice(0, 10)}`;
  const expiryBefore = Number(redis.run(["TTL", reportKey]));
  try {
    const nextDay = originalNow() + 86_400_000;
    Date.now = () => nextDay;
    await POST(announce("email.delivery_delayed", { email_id: "em_1", to: ["full@example.test"], tags, bounce: { type: "Transient" } }));
    is("a replay after midnight stays in the provider event's original UTC day", await mailReportDay(STORE, CAMPAIGN, nextDay), null);
    is("a replay cannot renew the original hash's lifetime", Number(redis.run(["TTL", reportKey])) <= expiryBefore - 86_400, true);
  } finally {
    Date.now = originalNow;
  }
  const keysBefore = redis.keys();
  const clockNow = Date.now();
  is("a signed provider clock three seconds ahead is retained at its own instant", await noteMailReportEvent(STORE, "b-clock-skew", "delivered", 1, "ses:clock-skew", clockNow + 3000, clockNow), true);
  for (const occurredAt of [undefined, NaN, Infinity, -1, Date.now() + 60_000, Date.now() - 11 * 86_400_000]) {
    is("an unconfirmed, future or expired event time authorizes no report write: " + String(occurredAt), await noteMailReportEvent(STORE, CAMPAIGN, "delivered", 1, "ses:time-invalid", occurredAt), false);
  }
  is("refused timestamps leave every key intact", redis.keys(), keysBefore);

  part("Reading one email has a fixed Redis response envelope");
  const pipeline = redis.pipeline.bind(redis);
  const reads: (string | number)[][] = [];
  redis.pipeline = async (commands) => { reads.push(...commands); return pipeline(commands); };
  try {
    await mailReportDay(STORE, CAMPAIGN);
    is("only the four aggregate fields are read", reads.map((command) => [command[0], command.length - 2]), [["HMGET", 4]]);
  } finally {
    redis.pipeline = pipeline;
  }

  part("A receipt and its aggregate change together");
  const at = Date.now();
  const concurrentCampaign = "b-concurrent-test";
  const repeats = await Promise.all(Array.from({ length: 64 }, () => noteMailReportEvent(STORE, concurrentCampaign, "delivered", 1, "ses:one-concurrent-email", at)));
  is("identical concurrent outcomes are all acknowledged", repeats.every(Boolean), true);
  is("but counted once", (await mailReportDay(STORE, concurrentCampaign))?.delivered, 1);
  const boundedKey = `nl:mail:health:${STORE}:bounded-fixture`;
  const first = ["EVAL", RECORD_MAIL_REPORT, 1, boundedKey, "receipt", "aggregate", 1, Math.floor(at / 1000) + 3600, 2];
  is("the exact field ceiling admits the receipt and aggregate", redis.run(first), 1);
  is("a second receipt is refused before another field is written", redis.run(["EVAL", RECORD_MAIL_REPORT, 1, boundedKey, "receipt2", "aggregate", 1, Math.floor(at / 1000) + 3600, 2]), -1);
  is("refusal preserves both original fields", redis.run(["HGETALL", boundedKey]), ["receipt", "1", "aggregate", "1"]);
  is("a contradictory replay cannot change the count", redis.run(["EVAL", RECORD_MAIL_REPORT, 1, boundedKey, "receipt", "aggregate", 2, Math.floor(at / 1000) + 3600, 2]), -1);

  done();
}

void main().catch((error) => { console.error(error); process.exit(1); });
