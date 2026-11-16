import type { NextRequest } from "next/server";
import { canHearResend, forwardInbound, inboundSigned, isInboundConfigured } from "@/lib/inbound-mail";
import { HEALTH_ID, LIST_TAG, STORE_TAG, heardFromSender, mailReportCampaign } from "@/lib/mail-health";
import { MAIL_REPORT_TAG, type MailReportEvent, noteMailReportEvent } from "@/lib/mail-report";
import { redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { clientAddress, limited, withinLimit } from "@/lib/request-guard";

/** An announcement names a message; it does not carry it. Anything bigger is not one. */
const MAX_BODY_BYTES = 256_000;
/** Announcements one address may make in a minute. */
const PER_MINUTE = 600;

// Reading a message, fetching its files and sending it on.
export const maxDuration = 60;

/** An announcement acted on is kept this long, and the same one again is acknowledged and ignored. */
const SEEN_SECONDS = 86_400;
/**
 * An announcement being acted on is held only this long: longer than one try
 * can run, shorter than Resend's second retry (five minutes after its first).
 * A try that failed and could not let go of it, or was stopped before it
 * could, is so heard again on that retry, never taken as done.
 */
const ACTING_SECONDS = maxDuration * 2;
const ACTING = "acting";
const SEEN = "1";

/** Marks an announcement as acted on, for the day. Already acted on: a failure here only lets a later duplicate be heard again. */
async function markSeen(seenKey: string): Promise<void> {
  try {
    const [set] = repliesFor(await redisPipeline([["SET", seenKey, SEEN, "EX", SEEN_SECONDS]]), 1) ?? [];
    if (set !== "OK") console.error("an announcement acted on could not be marked as seen", set);
  } catch (error) {
    console.error("an announcement acted on could not be marked as seen", error);
  }
}

/** Lets go of an announcement not acted on, so Resend's retry is heard; if this does not land, the hold runs out by itself. */
async function letGo(seenKey: string): Promise<void> {
  try {
    const [gone] = repliesFor(await redisPipeline([["DEL", seenKey]]), 1) ?? [];
    const count = countOf(gone);
    if (count !== 0 && count !== 1) console.error(`an announcement not acted on could not be let go of; it is heard again after ${ACTING_SECONDS} seconds`, gone);
  } catch (error) {
    console.error(`an announcement not acted on could not be let go of; it is heard again after ${ACTING_SECONDS} seconds`, error);
  }
}

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
 * acted on once: its id is held while it is being acted on, then kept for a
 * day, and the same one again is acknowledged and ignored. One still being
 * acted on is answered with a failure, so Resend offers it again later. One we
 * failed to act on is let go of again and answered with a failure, so
 * Resend's retry of it is heard; if it could not be let go of, the hold runs
 * out before that retry.
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
  try {
    const [claim, held] = repliesFor(await redisPipeline([["SET", seenKey, ACTING, "NX", "EX", ACTING_SECONDS], ["GET", seenKey]]), 2) ?? [];
    // Acted on already: acknowledged and ignored.
    if (claim === null && held === SEEN) return Response.json({ ok: true });
    // Only an exact "OK" with this request's hold read back proves the claim
    // was won (rule 24). Anything else (still being acted on, or a reply not
    // read in its exact shape) is neither done nor ours: answered with a
    // failure and nothing acted on, so Resend offers it again; a hold this
    // request may have taken runs out by itself.
    if (claim !== "OK" || held !== ACTING) return Response.json({ ok: false }, { status: 409 });
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
      await markSeen(seenKey);
      if (!reported && !bad) return Response.json({ ok: true });
      const reportResult = event === "delivered" ? "delivered" : event === "temporary-bounce" ? "temporary" : "counted";
      return Response.json({ ok: true, result: result !== "ignored" ? result : reported ? reportResult : "ignored" });
    } catch (error) {
      // Not acted on: let go of, so the retry is heard.
      console.error("a delivery report could not be recorded", error);
      await letGo(seenKey);
      return Response.json({ ok: false }, { status: 500 });
    }
  }

  const emailId = typeof notice.data?.email_id === "string" ? notice.data.email_id : "";

  const result = await forwardInbound(emailId);
  if (result === "retry") {
    await letGo(seenKey);
    return Response.json({ ok: false }, { status: 500 });
  }
  await markSeen(seenKey);
  return Response.json({ ok: true, result });
}
