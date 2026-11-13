import type { NextRequest } from "next/server";
import { recordSesEvent } from "@/lib/mail-report";
import { redisPipeline } from "@/lib/redis";
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
  // Amazon's certificate host did not answer: not known whether this is Amazon's, so it is asked again (5xx), never
  // refused (4xx), which Amazon does not try again, losing the bounce or complaint for good (j-mail-8).
  if (verdict === "unreachable") return Response.json({ ok: false }, { status: 503 });
  if (verdict !== "ok") return Response.json({ ok: false }, { status: 401 });

  // Acted on once (j-mail-8): taken while at work for less than Amazon's 20 seconds between tries, and kept a day
  // only once the work is done. Taken for the day before the work, a failure whose letting go failed too (the same
  // unwell Redis) answered every next delivery "done", and the bounce or complaint was never written.
  const seenKey = `nl:sns:seen:${message.MessageId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 80)}`;
  const [fresh] = await redisPipeline([["SET", seenKey, "w", "NX", "EX", 15]]);
  if (fresh === null) {
    const [mark] = await redisPipeline([["GET", seenKey]]);
    // Done before: acknowledged. At work in another delivery (or a failure's mark not yet gone): asked again later.
    return mark === "1" ? Response.json({ ok: true }) : Response.json({ ok: false }, { status: 503 });
  }
  const letGo = () => redisPipeline([["DEL", seenKey]]).catch(() => {});
  const done = async (response: Response) => {
    // Kept a day once acted on. Lost, the 15-second mark ends, and a later delivery acts once more, harmlessly:
    // taking an address off a list and counting a notice (lib/mail-health.ts, its own mark) are each done once.
    await redisPipeline([["SET", seenKey, "1", "EX", 86_400]]).catch(() => {});
    return response;
  };

  try {
    if (message.Type === "SubscriptionConfirmation") {
      const link = snsUrl(message.SubscribeURL, config.region);
      if (!link) return Response.json({ ok: false }, { status: 400 });
      const answer = await timed(SES_TIMEOUT_MS, (signal) => fetch(link.href, { cache: "no-store", signal }));
      if (!answer.ok) throw new Error(`Amazon answered ${answer.status} to the confirmation`);
      return done(Response.json({ ok: true, result: "confirmed" }));
    }
    if (message.Type === "UnsubscribeConfirmation") {
      // Somebody ended the subscription at Amazon. Nothing to do here but say so where it is read.
      console.error("Amazon SNS says this address no longer gets the topic's announcements");
      return done(Response.json({ ok: true }));
    }
    const event = readSesEvent(message.Message);
    if (!event) return done(Response.json({ ok: true }));
    const result = await recordSesEvent(event);
    return done(result === null ? Response.json({ ok: true }) : Response.json({ ok: true, result }));
  } catch (error) {
    console.error("an announcement from Amazon could not be acted on", error);
    await letGo();
    return Response.json({ ok: false }, { status: 500 });
  }
}
