import { runLaunches } from "@/lib/waitlist";
import { runPreorderReleases } from "@/lib/preorders";
import { preorderDeps } from "@/lib/purchase-email";
import { readListing } from "@/lib/catalog";
import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isSenderConfigured, sendQueuedShipmentMail } from "@/lib/email";
import { runShipmentMail } from "@/lib/shipment-mail-outbox";
import { runOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { storeForHandle } from "@/lib/store";
import { advanceAll } from "@/lib/broadcasts";
import { advanceAnnouncements } from "@/lib/community-mail";
import { advanceUpdates } from "@/lib/product-updates";
import { sendDueSteps } from "@/lib/flows";
import { sendCallReminders } from "@/lib/call-reminders";
import { runEventQueue } from "@/lib/community-event-mail";
import { SITE_URL } from "@/lib/site-url";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { sendAsked } from "@/lib/checkout-ask";
import { sendAssistReminders } from "@/lib/assistant-reminder";
import { deliverDue, watchStripe } from "@/lib/webhooks";
import { settlePendingOffers } from "@/lib/upsell";
import { sendReviewRequests } from "@/lib/review-requests";
import { syncDue } from "@/lib/email-sync";
import { syncMeetings } from "@/lib/call-meetings";
import { withCutoff } from "@/lib/fetch-timeout";

export const maxDuration = 60;

/**
 * Run every few minutes by Vercel: confirms purchases whose buyer never
 * reached the thanks page and sends the one reminder after an abandoned
 * checkout (lib/checkout-sweep.ts), starts scheduled emails when their time
 * comes, finishes long ones, sends each step of a sequence when it is due,
 * sends the reminders before booked calls (lib/call-reminders.ts), which
 * need this job's five-minute rhythm to arrive an hour before and not later,
 * then the same for the community's live events — reminders a day and an
 * hour before, the emails about a moved or cancelled event, and the
 * creator's phone fifteen minutes before (lib/community-event-mail.ts) —
 * finishes a community announcement's email (lib/community-mail.ts), and
 * sends the review requests that are due (lib/review-requests.ts).
 * Last, it reads each store's Stripe events for the creator's webhooks and
 * retries the webhook deliveries that are due (lib/webhooks.ts), then the
 * people waiting to be sent to a creator's own email platform
 * (lib/email-sync.ts) — which need
 * Redis and Stripe but not email, so they run even where sending is off, as
 * does writing down the sales that came through an affiliate's link (the
 * checkout pass). Right after the checkout pass, the one-click offers still
 * waiting on Stripe are settled (lib/upsell.ts), so an offer the bank
 * confirmed later gets its email and its affiliate credit without waiting
 * for the buyer to come back.
 *
 * The run has sixty seconds (maxDuration), shared out so that nothing
 * starves what comes after it. Each part starts no new piece of work after
 * its mark, and every piece is bounded, so a part ends at most one piece
 * past its mark:
 *
 *    0–12 s  the checkout pass
 *   –16 s    the one-click offers waiting on Stripe
 *   –22 s    the Store assistant's checkout reminders (lib/assistant-reminder.ts):
 *            one piece is a Stripe read and at most 8 s of the model
 *   –30 s    the creators' emails: broadcasts, sequence steps, waitlist launches, community
 *            announcements (the announcements check each member's access
 *            25 at a time, lib/mail.ts CHECKED_BATCH_SIZE, so one piece is
 *            a few seconds, not a hundred Stripe lookups)
 *   –40 s    call reminders: at least ten seconds even after a long send
 *   –43 s    live events' reminders and notices: at least three seconds,
 *            members checked 25 at a time as above
 *   –44 s    review requests, the least urgent: a day late is no harm
 *   –50 s    the webhook pass: Stripe's events read until 47; webhook
 *            retries started until 50, one try up to 8 s more (58); Google
 *            Meet and Zoom meetings (lib/call-meetings.ts) until 50, with
 *            every request to Google or Zoom given up by 55 whatever it is
 *            (withCutoff); email platforms started until 50, one try up to
 *            9 s more (59).
 *
 * The marks assume Redis, Stripe and the email service answer in a second or
 * two, as they do. Each of their requests is given up after its own limit
 * (lib/fetch-timeout.ts: Redis 5 s, Stripe 20 s, Resend 10 s), and the whole
 * run is under one cutoff at 57 s, so however slow one of them is that day,
 * no request is still waiting when Vercel stops the job at sixty; the
 * requests to other people's servers — webhook endpoints, email platforms,
 * Google and Zoom — carry hard timeouts of their own. Without email, live
 * events still get their phone notification, in the same place.
 */
export async function GET(request: NextRequest) {
  // Every request below is given up by 57 s (lib/fetch-timeout.ts). A run
  // that reaches it leaves its lock to run out by itself (90 s), long
  // before the next run.
  const started = Date.now();
  return withCutoff(started + 57_000, () => run(request, started));
}

async function run(request: NextRequest, started: number): Promise<Response> {
  // Vercel sends the secret with every scheduled run, compared here in
  // constant time. Without one set, only a local development server runs the
  // job on request; in production that is a closed door, not an open one.
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const [got] = await redisPipeline([["SET", "nl:mail:lock", "1", "NX", "EX", 90]]);
  if (got === null) return Response.json({ ok: true, busy: true });
  const webhooksBy = started + 50_000;
  const meetingsCutoff = started + 55_000;
  try {
    // Saved shipment messages have their own exact payload and lifetime
    // barrier. They remain eligible after the checkout sweep's 24h window.
    // Start both independent queues inside the same existing five-second
    // slice. A slow shipping acknowledgement cannot consume every pass
    // before an already-paid confirmation is even allowed to start.
    const saved = await Promise.allSettled([
      runShipmentMail(started + 5_000, sendQueuedShipmentMail),
      runOrderConfirmationMail(started + 5_000, sendQueuedShipmentMail),
    ]);
    for (const result of saved) {
      if (result.status === "rejected") console.error("saved order mail could not be checked", result.reason);
    }
    // First, and with a budget of its own: a buyer waiting for what they paid
    // for matters more than a newsletter going out a few minutes sooner, and
    // the budget keeps the newsletter from waiting on it for long. Without
    // email it still writes down affiliates' sales.
    let checkouts = null;
    try {
      checkouts = await sweepCheckouts(started + 12_000);
    } catch (error) {
      console.error("the checkout pass failed", error);
    }
    // The reminders buyers asked for themselves on the way back from a
    // checkout (lib/checkout-ask.ts): due an hour after they asked, and few.
    try {
      await sendAsked(storeForHandle, started + 20_000);
    } catch (error) {
      console.error("sending asked-for checkout reminders failed", error);
    }
    // The Store assistant's reminders, asked for with its box at checkout
    // (lib/assistant-reminder.ts): due an hour after the checkout closed.
    try {
      await sendAssistReminders(storeForHandle, started + 22_000);
    } catch (error) {
      console.error("sending the Store assistant's checkout reminders failed", error);
    }
    let offers = null;
    try {
      offers = await settlePendingOffers(storeForHandle, Math.max(Date.now(), started + 12_000) + 4_000);
    } catch (error) {
      console.error("settling waiting offers failed", error);
    }
    if (!isSenderConfigured()) {
      let events = null;
      try {
        events = await runEventQueue(storeForHandle, started + 43_000, { mail: false });
      } catch (error) {
        console.error("live event notifications failed", error);
      }
      return Response.json({ ok: true, mail: "unavailable", checkouts, offers, events, webhooks: await runWebhooks(webhooksBy, meetingsCutoff) }, { headers: { "Cache-Control": "no-store" } });
    }
    const deadline = started + 30_000;
    // Each kept apart: one failing never skips the others for this run.
    let broadcasts = 0;
    try {
      broadcasts = await advanceAll(storeForHandle, deadline);
    } catch (error) {
      console.error("sending broadcasts failed", error);
    }
    let steps = { sent: 0, dropped: 0, later: 0 };
    try {
      steps = await sendDueSteps(storeForHandle, deadline);
    } catch (error) {
      console.error("sending sequence steps failed", error);
    }
    let announcements = 0;
    try {
      announcements = await advanceAnnouncements(storeForHandle, deadline);
    } catch (error) {
      console.error("sending community announcements failed", error);
    }
    // A product's buyers told it was updated (lib/product-updates.ts).
    let updates = 0;
    try {
      updates = await advanceUpdates(storeForHandle, deadline);
    } catch (error) {
      console.error("sending product updates failed", error);
    }
    // The one email to a waitlist when its product goes on sale
    // (lib/waitlist.ts), in the same slot as the creators' other emails.
    let launches = 0;
    try {
      launches = await runLaunches(storeForHandle, readListing, deadline);
    } catch (error) {
      console.error("sending waitlist launches failed", error);
    }
    // Pre-orders of products put on sale, handed over and emailed (lib/preorders.ts).
    let preorders = 0;
    try {
      preorders = await runPreorderReleases(storeForHandle, readListing, preorderDeps, deadline);
    } catch (error) {
      console.error("handing over pre-orders failed", error);
    }
    // Reminders are kept apart from the creators' own emails: one failing
    // never stops the other, and the next run picks up whatever was left.
    // They get ten seconds even after a long send, so a busy newsletter day
    // cannot push a reminder past its hour, but nothing past forty, so live
    // events and the webhooks always have their turn.
    let calls = null;
    try {
      calls = await sendCallReminders(storeForHandle, Math.min(started + 40_000, Math.max(deadline, Date.now() + 10_000)), SITE_URL);
    } catch (error) {
      console.error("sending call reminders failed", error);
    }
    // Live events next: a reminder an hour before has to arrive before the
    // start, so they have at least three seconds, and nothing past forty-three.
    let events = null;
    try {
      events = await runEventQueue(storeForHandle, Math.min(started + 43_000, Math.max(started + 33_000, Date.now() + 3_000)), { mail: true });
    } catch (error) {
      console.error("live event reminders failed", error);
    }
    // Review requests are the least urgent email here: a day late is no harm.
    let reviews = null;
    try {
      reviews = await sendReviewRequests(storeForHandle, started + 44_000);
    } catch (error) {
      console.error("sending review requests failed", error);
    }
    // Nothing started after fifty: a webhook try can take eight more, and the
    // whole run has sixty.
    const webhooks = await runWebhooks(webhooksBy, meetingsCutoff);
    return Response.json({ ok: true, checkouts, offers, broadcasts, announcements, updates, launches, preorders, ...steps, calls, events, reviews, webhooks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("the email job failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:mail:lock"]]).catch(() => {});
  }
}

/**
 * The webhook pass: new Stripe events first, then the retries due, then the
 * Google Meet and Zoom meetings, then the email platforms' sends and
 * retries. One failing never stops the others.
 */
async function runWebhooks(deadline: number, cutoff: number) {
  let stripe = null;
  let deliveries = null;
  let emailPlatforms = null;
  let meetings = null;
  try {
    stripe = await watchStripe(deadline - 3_000);
  } catch (error) {
    console.error("reading Stripe for webhooks failed", error);
  }
  try {
    deliveries = await deliverDue(deadline);
  } catch (error) {
    console.error("retrying webhooks failed", error);
  }
  // Google Meet and Zoom meetings for calls and live events: tries again what
  // failed, and removes the meetings of refunded bookings
  // (lib/call-meetings.ts). Six seconds of starting new ones at most, so the
  // email platforms keep their turn, and every request to Google or Zoom is
  // given up by `cutoff`, however long a piece of it would take.
  try {
    meetings = await withCutoff(cutoff, () => syncMeetings(storeForHandle, Math.min(deadline, Date.now() + 6_000), SITE_URL));
  } catch (error) {
    console.error("keeping meetings in step failed", error);
  }
  try {
    emailPlatforms = await syncDue(deadline);
  } catch (error) {
    console.error("sending to email platforms failed", error);
  }
  return { stripe, deliveries, emailPlatforms, meetings };
}
