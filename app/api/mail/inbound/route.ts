import type { NextRequest } from "next/server";
import { canHearResend, forwardInbound, inboundSigned, isInboundConfigured } from "@/lib/inbound-mail";
import { HEALTH_ID, LIST_TAG, STORE_TAG, heardFromSender, mailReportCampaign } from "@/lib/mail-health";
import { MAIL_REPORT_TAG, type MailReportEvent, noteMailReportEvent } from "@/lib/mail-report";
import { redisPipeline } from "@/lib/redis";
import { claimValue, releaseMark } from "@/lib/claim-mark";
import { clientAddress, limited, withinLimit } from "@/lib/request-guard";

/** An announcement names a message; it does not carry it. Anything bigger is not one. */
const MAX_BODY_BYTES = 256_000;
/** Announcements one address may make in a minute. */
const PER_MINUTE = 600;

// Reading a message, fetching its files and sending it on.
export const maxDuration = 60;

/** A tag's value, from the two shapes a sender writes tags in: { name: value } or [{ name, value }]. */
function tagOf(tags: unknown, name: string): string {
  if (Array.isArray(tags)) {
    const found = tags.find((t) => t && typeof t === "object" && (t as { name?: unknown }).name === name) as { value?: unknown } | undefined;
    return typeof found?.value === "string" ? found.value : "";
  }
  const value = tags && typeof tags === "object" ? (tags as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : "";
}

/**
 * Resend's announcements, of two kinds:
 *
 *   - a message arrived at one of the site's own addresses
 *     (lib/inbound-mail.ts): it is fetched and sent on to the inbox that
 *     reads it;
 *   - an email we sent bounced, or was marked as spam (lib/mail-health.ts):
 *     the address is taken off that store's list, and the store is paused
 *     if it has had too many.
 *
 * Not found until the setting that signs them is there. Every announcement
 * must carry Resend's signature from the last five minutes, and each is
 * acted on once: its id is kept for a day, and the same one again is
 * acknowledged and ignored. One we failed to act on is let go of again and
 * answered with a failure, so Resend's retry of it is heard.
 *
 * Anything else is acknowledged and ignored.
 */
export async function POST(request: NextRequest) {
  if (!canHearResend()) return new Response("Not found.", { status: 404 });
  if (!(await withinLimit("mail-inbound", clientAddress(request), PER_MINUTE, 60))) {
    return Response.json({ ok: false }, { status: 429 });
  }
  let body: string;
  try {
    body = await (await limited(request, MAX_BODY_BYTES)).text();
  } catch {
    return Response.json({ ok: false }, { status: 413 });
  }
  const id = request.headers.get("svix-id");
  if (!inboundSigned(body, id, request.headers.get("svix-timestamp"), request.headers.get("svix-signature"))) {
    return Response.json({ ok: false }, { status: 401 });
  }

  let notice: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; to?: unknown; tags?: unknown; bounce?: { type?: unknown } } };
  try {
    notice = JSON.parse(body) as typeof notice;
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const bad = notice.type === "email.bounced" || notice.type === "email.complained";
  const report = bad || notice.type === "email.delivered" || notice.type === "email.delivery_delayed";
  if (!report && notice.type !== "email.received") return Response.json({ ok: true });
  if (!bad && report && (!HEALTH_ID.test(tagOf(notice.data?.tags, STORE_TAG)) || !mailReportCampaign(tagOf(notice.data?.tags, MAIL_REPORT_TAG)))) return Response.json({ ok: true });
  // Mail to the site's own addresses needs the other two settings as well,
  // and is not found without them, as it always was: an announcement not
  // acknowledged is one Resend offers again.
  if (!report && !isInboundConfigured()) return new Response("Not found.", { status: 404 });

  const seenKey = `nl:inbound:seen:${id}`;
  // A value only this run writes (lib/claim-mark.ts): letting go after a failure deletes this run's own mark only,
  // never the mark of Resend's retry that took it after this run's ran out (releaseMark never throws).
  const mine = claimValue();
  try {
    const [fresh] = await redisPipeline([["SET", seenKey, mine, "NX", "EX", 86_400]]);
    if (fresh === null) return Response.json({ ok: true });
  } catch {
    // Without Redis the sender's idempotency key still keeps a repeat from
    // being delivered twice; carry on.
  }

  if (report) {
    const recipients = (Array.isArray(notice.data?.to) ? notice.data.to : [notice.data?.to])
      .filter((to): to is string => typeof to === "string" && to.length > 0 && to.length <= 320)
      .slice(0, 50);
    const to = recipients[0] ?? "";
    try {
      const store = tagOf(notice.data?.tags, STORE_TAG);
      const permanent = notice.type === "email.bounced" && notice.data?.bounce?.type === "Permanent";
      let result: "counted" | "paused" | "ignored" = "ignored";
      if (notice.type === "email.complained" || permanent) {
        result = await heardFromSender({
          kind: notice.type === "email.complained" ? "complained" : "bounced",
          permanent,
          to,
          store,
          list: tagOf(notice.data?.tags, LIST_TAG),
        });
      }
      const event: MailReportEvent = notice.type === "email.delivered"
        ? "delivered"
        : notice.type === "email.complained"
          ? "complained"
          : permanent ? "permanent-bounce" : "temporary-bounce";
      const emailId = typeof notice.data?.email_id === "string" && notice.data.email_id.length <= 200 ? notice.data.email_id : "";
      const occurredAt = typeof notice.created_at === "string" ? Date.parse(notice.created_at) : undefined;
      const reported = await noteMailReportEvent(store, tagOf(notice.data?.tags, MAIL_REPORT_TAG), event, recipients.length, emailId ? `resend:${emailId}` : "", occurredAt);
      if (!reported && !bad) return Response.json({ ok: true });
      const reportResult = event === "delivered" ? "delivered" : event === "temporary-bounce" ? "temporary" : "counted";
      return Response.json({ ok: true, result: result !== "ignored" ? result : reported ? reportResult : "ignored" });
    } catch (error) {
      // Not acted on: let go of, so the retry is heard.
      console.error("a delivery report could not be recorded", error);
      await releaseMark(seenKey, mine);
      return Response.json({ ok: false }, { status: 500 });
    }
  }

  const emailId = typeof notice.data?.email_id === "string" ? notice.data.email_id : "";

  const result = await forwardInbound(emailId);
  if (result === "retry") {
    await releaseMark(seenKey, mine);
    return Response.json({ ok: false }, { status: 500 });
  }
  return Response.json({ ok: true, result });
}
