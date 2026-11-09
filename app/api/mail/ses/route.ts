import type { NextRequest } from "next/server";
import { recordSesEvent } from "@/lib/mail-report";
import { redisPipeline } from "@/lib/redis";
import { claimValue, releaseMark } from "@/lib/claim-mark";
import { clientAddress, limited, withinLimit } from "@/lib/request-guard";
import { isSesConfigured, sesConfig } from "@/lib/ses";
import { readSesEvent, readSns, snsUrl, verifySns } from "@/lib/sns";
import { SES_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";

/** An announcement carries one email's headers at most. Anything bigger is not one. */
const MAX_BODY_BYTES = 300_000;
/** Announcements one address may make in a minute: a large bad list bounces by the hundred. */
const PER_MINUTE = 3_000;

export const maxDuration = 30;


/**
 * Amazon's announcement that an email we sent through Amazon SES bounced, or
 * was marked as spam (lib/mail-health.ts): the address is taken off that
 * store's list, and the store is paused if it has had too many. The same
 * thing app/api/mail/inbound does for the other sender.
 *
 * Not found until Amazon is set up (lib/ses.ts). Each announcement is
 * believed only as lib/sns.ts describes — our topic, Amazon's signature, no
 * more than an hour old — and acted on once: its id is kept for a day. One
 * we failed to act on is let go of again and answered with a failure, so
 * Amazon's retry of it is heard.
 *
 * The first thing Amazon posts to a new address is a question: do you want
 * this topic's announcements? It is answered yes, by opening the link in it,
 * only when it passes the same checks and the link is on Amazon's own host.
 */
export async function POST(request: NextRequest) {
  const config = sesConfig();
  if (!config || !isSesConfigured()) return new Response("Not found.", { status: 404 });
  if (!(await withinLimit("mail-ses", clientAddress(request), PER_MINUTE, 60))) {
    return Response.json({ ok: false }, { status: 429 });
  }
  let body: string;
  try {
    body = await (await limited(request, MAX_BODY_BYTES)).text();
  } catch {
    return Response.json({ ok: false }, { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const message = readSns(parsed);
  if (!message) return Response.json({ ok: false }, { status: 400 });
  const verdict = await verifySns(message, config);
  if (verdict !== "ok") return Response.json({ ok: false }, { status: 401 });

  const seenKey = `nl:sns:seen:${message.MessageId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 80)}`;
  // A value only this run writes (lib/claim-mark.ts): letting go after a failure deletes this run's own mark only,
  // never the mark of Amazon's retry that took it after this run's ran out (releaseMark never throws).
  const mine = claimValue();
  const [fresh] = await redisPipeline([["SET", seenKey, mine, "NX", "EX", 86_400]]);
  if (fresh === null) return Response.json({ ok: true });
  const letGo = () => releaseMark(seenKey, mine);

  try {
    if (message.Type === "SubscriptionConfirmation") {
      const link = snsUrl(message.SubscribeURL, config.region);
      if (!link) return Response.json({ ok: false }, { status: 400 });
      const answer = await timed(SES_TIMEOUT_MS, (signal) => fetch(link.href, { cache: "no-store", signal }));
      if (!answer.ok) throw new Error(`Amazon answered ${answer.status} to the confirmation`);
      return Response.json({ ok: true, result: "confirmed" });
    }
    if (message.Type === "UnsubscribeConfirmation") {
      // Somebody ended the subscription at Amazon. Nothing to do here but say so where it is read.
      console.error("Amazon SNS says this address no longer gets the topic's announcements");
      return Response.json({ ok: true });
    }
    const event = readSesEvent(message.Message);
    if (!event) return Response.json({ ok: true });
    const result = await recordSesEvent(event);
    return result === null ? Response.json({ ok: true }) : Response.json({ ok: true, result });
  } catch (error) {
    console.error("an announcement from Amazon could not be acted on", error);
    await letGo();
    return Response.json({ ok: false }, { status: 500 });
  }
}
