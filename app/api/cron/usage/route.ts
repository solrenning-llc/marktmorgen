import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import {
  DELIVERY_ALLOWANCE_BYTES,
  FREE_PAUSE_ABOVE_BYTES,
  bytesWords,
  ownersOf,
  storesOverAllowance,
} from "@/lib/delivery";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { PLANS_ON_SALE } from "@/lib/opening";
import { largerPlanFor } from "@/lib/larger-plan";
import { SITE_URL } from "@/lib/site-url";
import { SETUP_VIDEO_SECONDS, costsPaused, standingOf, videoLimitFor } from "@/lib/plan-standing";
import { watchedFolders, watchedIn } from "@/lib/watch";
import { firstWord, settleAll, storeOf } from "@/lib/watch-billing";
import { allowanceWindow, calendarWindow, resetWords } from "@/lib/allowance-window";

import { centsWords } from "@/lib/watch-rules";
import { videoUsageNotice } from "@/lib/video-usage-notice";
import { visitedFolders, visitsIn } from "@/lib/traffic";
import { firstWordOnVisits } from "@/lib/traffic-billing";
import { SETUP_VISITS, countWords, publicVisitLimit, visitLimitFor, visitsWords } from "@/lib/traffic-rules";
import { firstWordOnOrders } from "@/lib/orders-billing";
import { orderedFolders, ordersIn } from "@/lib/orders";
import { ORDERS_INCLUDED, ordersWords, paidOrdersLimitFor } from "@/lib/order-rules";

/** The folders a calendar-month index lists this month and the last, once each. */
async function foldersOfTwoMonths(read: (month: string) => Promise<string[]>): Promise<string[]> {
  const now = Date.now();
  const last = calendarWindow(calendarWindow(now).start - 1).id;
  return [...new Set([...(await read(calendarWindow(now).id)), ...(await read(last))])].sort();
}

/**
 * The daily run that writes to a creator who has gone past the allowance.
 *
 * Section 5 of the Terms promises that a store far above the published
 * limits is written to first, with the figures, and given time to answer,
 * before anything is limited. That promise was the last thing in this system
 * that needed a person: everything else — the pause on free downloads, the
 * brake on storage — acts by itself, while the letter sat waiting for
 * somebody to notice and write it.
 *
 * A promise that depends on somebody noticing is not a promise. So the
 * letter is sent from here, to the creator, by name, with their own number
 * in it, the morning after they cross. Nobody has to be watching, and the
 * clause in the Terms is kept by the machine that made it necessary.
 *
 * Once per store per calendar month. A store that is over stays over until
 * the counter rolls, and a mail every morning for three weeks is how a
 * notice stops being read.
 *
 * Nothing in here blocks or limits anything. It writes.
 *
 * It also settles lesson video watched past the hours a plan covers
 * (lib/watch-billing.ts). Since 31 October 2026 (232 [CA1] unit 3) that
 * meter owes nothing, so nothing is ever put on an invoice after use; each
 * creator is written to the first time a month's videos are paused
 * (lib/learn.ts).
 *
 * Visits and orders are not billed (since 17 October 2026, when their prices
 * past a plan no longer kept the owner's 60% after tax). Each creator is
 * written to once a month instead: when a month's visits rest the store's
 * public pages (lib/traffic-rules.ts), and when a paid store's orders reach
 * its plan's figure and new orders stop (lib/order-admission.ts).
 */
export const maxDuration = 60;

const TOLD = "nl:usage-watch:told";

type VideoRun = { stores: number; billed: number; cents: number; paused: number; failed: number; told: number };

/** Bills video past the plan's hours, and writes to each creator the first time a month passes them. */
async function videoRun(): Promise<VideoRun> {
  const out: VideoRun = { stores: 0, billed: 0, cents: 0, paused: 0, failed: 0, told: 0 };
  let settled: Awaited<ReturnType<typeof settleAll>> = [];
  try {
    settled = await settleAll();
  } catch (error) {
    console.error("settling video hours failed", error);
    return out;
  }
  for (const row of settled) {
    out.stores += 1;
    if (row.added > 0) {
      out.billed += 1;
      out.cents += row.added;
    }
    if (row.state === "failed") out.failed += 1;
  }

  // Each creator is written to once about the month that is running: the
  // first time their hours pass what a plan covers, or, where there is no
  // plan to charge, the first time their videos are paused. A store with no
  // plan has far fewer hours than one in a trial (lib/plan-standing.ts), so
  // every store watched for at least the smallest figure is looked at.
  // The stores are found by the calendar month (this one and the last, where
  // a billing month may have begun); each is read in its own window
  // (lib/allowance-window.ts), and written to once a window.
  let watchedStores: string[] = [];
  try {
    watchedStores = await foldersOfTwoMonths(watchedFolders);
  } catch (error) {
    console.error("could not read the stores whose video was watched", error);
  }
  for (const folder of watchedStores) {
    try {
      const store = await storeOf(folder);
      const month = store ? allowanceWindow(store)?.id : null;
      if (!store || !month) continue;
      const seconds = await watchedIn(folder, month);
      if (seconds < SETUP_VIDEO_SECONDS) continue;
      const limit = videoLimitFor(store);
      const paused = limit !== null && seconds >= limit;
      if (!paused) continue;
      if (paused) out.paused += 1;
      // A renewal Stripe could not collect pauses video for its own reason, and the
      // creator is told that one (232 [CA1] unit 4): not a plan's hours used up.
      if (costsPaused(store)) continue;
      if (!isSenderConfigured() || !(await firstWord(folder, month))) continue;
      const notice = videoUsageNotice({ seconds, limit, standing: standingOf(store),
        studioUrl: `${SITE_URL}/studio`, supportEmail: SUPPORT_EMAIL });
      const sent = await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: store.email,
        replyTo: SUPPORT_EMAIL,
        ...notice,
      }).catch((error) => {
        console.error("sending the video hours notice failed", error);
        return false;
      });
      if (sent !== false) out.told += 1;
    } catch (error) {
      console.error("writing to a creator about video hours failed", error);
    }
  }
  console.log(
    out.stores === 0 && out.paused === 0
      ? "video-watch: every store inside its hours"
      : `video-watch: ${out.stores} past a plan's hours, ${out.billed} billed ${centsWords(out.cents)}, ${out.paused} playback paused, ${out.failed} failed, ${out.told} written to`,
  );
  return out;
}

type VisitsRun = { stores: number; resting: number; failed: number; told: number };

/**
 * Writes to each creator the first time a month's visits rest their public
 * pages. Nothing is billed: since 17 October 2026 visits past a plan's figure
 * are not sold (lib/traffic-rules.ts); the pages rest instead, for every
 * standing, and what buyers already have goes on until the whole figure.
 */
async function visitsRun(): Promise<VisitsRun> {
  const out: VisitsRun = { stores: 0, resting: 0, failed: 0, told: 0 };
  let visited: string[] = [];
  try {
    visited = await foldersOfTwoMonths(visitedFolders);
  } catch (error) {
    console.error("could not read the stores that were visited", error);
  }
  for (const folder of visited) {
    try {
      const store = await storeOf(folder);
      const month = store ? allowanceWindow(store)?.id : null;
      if (!store || !month) continue;
      const visits = await visitsIn(folder, month);
      if (visits < publicVisitLimit(SETUP_VISITS)) continue;
      const limit = visitLimitFor(store);
      const shown = publicVisitLimit(limit);
      if (visits < shown) continue;
      out.stores += 1;
      out.resting += 1;
      if (!isSenderConfigured() || !(await firstWordOnVisits(folder, month))) continue;
      const standing = standingOf(store);
      const sent = await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: store.email,
        replyTo: SUPPORT_EMAIL,
        subject: "Your store's pages are resting",
        text: [
          `Your store has had ${visitsWords(visits)} ${standing === "paid" ? "this billing month" : standing === "trial" ? "in its free trial" : "this month"}. ${standing === "paid" ? "Your plan covers" : standing === "trial" ? "A free trial has" : "A store without a paid plan has"}`,
          `${countWords(limit)}${standing === "trial" ? "" : " a month"}: its public pages rest at ${countWords(shown)}, and the last`,
          `${countWords(limit - shown)} are kept for what your buyers already have.`,
          "",
          "So your store's page, products and blog are resting: a visitor is told the",
          "page will be open again soon. Your buyers' courses, lessons, community and",
          "podcasts stay open until all of these visits are used, and then rest",
          "too, with a page that says their access is kept. Nothing is charged for",
          "visits, and nothing anyone bought is taken away.",
          "",
          ...(standing === "paid"
            ? [resetWords(store), ...(largerPlanFor(store) ? ["Moving to a larger plan opens them at once."] : [])]
            : PLANS_ON_SALE || standing === "trial"
              ? ["Your pages open again as soon as your plan is paid, or when the month", "turns, whichever comes first."]
              : ["Your pages open again when the month turns. Plans are not on sale yet."]),
          "",
          "A visit is one person opening your store on one day, however many of its",
          "pages they look at. You are never counted, and neither is a robot that",
          "says it is one. Your studio shows the count as it grows:",
          `${SITE_URL}/studio`,
          "",
          `If the figure surprises you, reply to this email or write to ${SUPPORT_EMAIL}.`,
        ].join("\n"),
      }).catch((error) => {
        console.error("sending the visits notice failed", error);
        return false;
      });
      if (sent !== false) out.told += 1;
    } catch (error) {
      out.failed += 1;
      console.error("writing to a creator about visits failed", error);
    }
  }
  console.log(
    out.resting === 0
      ? "visits-watch: every store inside its visits"
      : `visits-watch: ${out.resting} resting, ${out.failed} failed, ${out.told} written to`,
  );
  return out;
}

export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  const video = await videoRun();
  const visits = await visitsRun();
  const orders = await ordersRun();

  // The delivery part on its own: a list or total Redis answered in an unknown shape (CX-123 rule 24) is never
  // "nobody is over". It is said as unknown, nobody is written to on it and its told list is left as it was; the
  // other parts above have run whatever it does, and the run answers an error only here, at the end.
  let over: Awaited<ReturnType<typeof storesOverAllowance>>;
  try {
    over = await storesOverAllowance();
  } catch (error) {
    console.error("usage-watch: the stores over the delivery allowance are unknown today; nobody was written to about it", error);
    return Response.json(
      { ok: false, unread: ["delivery"], video, visits, orders },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const allowance = bytesWords(DELIVERY_ALLOWANCE_BYTES);

  console.log(
    over.length === 0
      ? "usage-watch: every store inside the delivery allowance"
      : `usage-watch: ${over.length} over ${allowance} — ${over.map((s) => `${s.folder} ${bytesWords(s.bytes)}`).join(", ")}`,
  );

  const [seenRaw] = await redisPipeline([["GET", TOLD]]);
  const seen = new Set<string>(typeof seenRaw === "string" ? (JSON.parse(seenRaw) as string[]) : []);
  const fresh = over.filter((s) => !seen.has(s.folder));
  if (fresh.length === 0) {
    return Response.json(
      { ok: true, over: over.length, told: 0, video, visits, orders },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const owners = await ownersOf(fresh.map((s) => s.folder));
  let told = 0;
  const unknown: string[] = [];

  for (let i = 0; i < fresh.length; i += 1) {
    const store = fresh[i];
    const email = owners[i];
    if (!email) {
      unknown.push(store.folder);
      continue;
    }
    if (!isSenderConfigured()) break;
    const sent = await sendEmail({ meter: { by: "company" },
      from: NIMBUS_FROM,
      to: email,
      replyTo: SUPPORT_EMAIL,
      subject: `Your store has sent out ${bytesWords(store.bytes)} this month`,
      text: [
        `Your store has handed out ${bytesWords(store.bytes)} of files so far this month. The`,
        `subscription covers ${allowance} a month, so you are past it.`,
        "",
        "Nothing has been stopped, and nothing will be stopped for this. Your buyers",
        "are getting what they paid for, at any number — we do not take money for a",
        "sale and then not complete it.",
        "",
        "Two things are worth knowing.",
        "",
        `Free downloads — copies given away rather than bought — pause on their own if a`,
        `store passes ${bytesWords(FREE_PAUSE_ABOVE_BYTES)} in a month, and start again when the month turns.`,
        "Anything anyone has bought is never affected by that.",
        "",
        "And if your store stays far above the allowance month after month, we will",
        "want to talk about a plan that fits what you are doing. This email is that",
        "conversation starting, which is what our Terms say we do before anything",
        "else happens. You have time, and you have a person to answer: reply to this",
        `email, or write to ${SUPPORT_EMAIL}.`,
        "",
        "If this is a surprise, it is worth checking whether a free product of yours",
        "has been shared somewhere you did not expect. Your studio shows the month's",
        "total under your plan.",
        "",
        `${SITE_URL}/studio`,
      ].join("\n"),
    }).catch((error) => {
      console.error("sending the allowance notice failed", error);
      return false;
    });
    if (sent !== false) told += 1;
  }

  /*
    A store whose owner we cannot name is the one case left that a person has
    to look at — and it can only happen to a store that has delivered files
    without ever uploading one through the studio, which should not occur.
    It is said out loud rather than passed over in silence.
  */
  if (unknown.length > 0 && isSenderConfigured()) {
    await sendEmail({ meter: { by: "company" },
      from: NIMBUS_FROM,
      to: SUPPORT_EMAIL,
      subject: `${unknown.length} store(s) over the allowance could not be written to`,
      text: [
        "These folders are past the delivery allowance, and we have no address on",
        "file for whoever owns them, so the notice our Terms promise could not be",
        "sent automatically:",
        "",
        ...unknown.map((f) => `  ${f}`),
      ].join("\n"),
    }).catch((error) => console.error("sending the unknown-owner notice failed", error));
  }

  await redisPipeline([
    ["SET", TOLD, JSON.stringify([...new Set([...seen, ...over.map((s) => s.folder)])]), "EX", 40 * 86_400],
  ]);

  return Response.json(
    { ok: true, over: over.length, told, unknown: unknown.length, video, visits, orders },
    { headers: { "Cache-Control": "no-store" } },
  );
}

type OrdersRun = { stores: number; failed: number; told: number };

/**
 * Writes to each creator the first time a month's orders reach their plan's
 * figure, where new orders stop (lib/order-admission.ts). Nothing is billed:
 * since 17 October 2026 orders past a plan's figure are not sold.
 */
async function ordersRun(): Promise<OrdersRun> {
  const out: OrdersRun = { stores: 0, failed: 0, told: 0 };
  let ordered: string[] = [];
  try {
    ordered = await foldersOfTwoMonths(orderedFolders);
  } catch (error) {
    console.error("could not read the stores with orders", error);
    return out;
  }
  for (const folder of ordered) {
    try {
      const store = await storeOf(folder);
      const month = store ? allowanceWindow(store)?.id : null;
      if (!store || !month) continue;
      const orders = await ordersIn(folder, month);
      if (orders < Math.min(...Object.values(ORDERS_INCLUDED))) continue;
      const limit = paidOrdersLimitFor(store);
      if (limit === null || orders < limit) continue;
      out.stores += 1;
      if (!isSenderConfigured() || !(await firstWordOnOrders(folder, month))) continue;
      const sent = await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: store.email,
        replyTo: SUPPORT_EMAIL,
        subject: `Your store has had ${ordersWords(orders)} ${standingOf(store) === "trial" ? "in its free trial" : "this billing month"}`,
        text: [
          `Your store has had ${ordersWords(orders)} ${standingOf(store) === "trial" ? "in its free trial" : "this billing month"}, which is the ${countWords(limit)} ${standingOf(store) === "trial" ? "a free trial" : "your plan"}`,
          "covers, so new orders are paused.",
          resetWords(store),
          ...(largerPlanFor(store) ? ["Moving to a larger plan opens them at once."] : []),
          "",
          "A buyer who presses buy now is told plainly that the store is not taking new",
          "orders right now, and nothing is charged. Anybody who was already paying",
          "finishes and gets everything they bought. Nothing is billed for orders, and",
          "nothing is asked of you.",
          "",
          "An order is a purchase confirmed, an offer taken after paying, a place in a",
          "purchase for several people, or a free copy sent; a call booked counts as two. An order whose sale paid",
          "your plan's share is not counted. Your studio shows the count as it grows,",
          `under your plan: ${SITE_URL}/studio`,
          "",
          `If the figure surprises you, reply to this email or write to ${SUPPORT_EMAIL}.`,
        ].join("\n"),
      }).catch((error) => {
        console.error("sending the orders notice failed", error);
        return false;
      });
      if (sent !== false) out.told += 1;
    } catch (error) {
      out.failed += 1;
      console.error("writing to a creator about orders failed", error);
    }
  }
  console.log(
    out.stores === 0
      ? "orders-watch: every store inside its orders"
      : `orders-watch: ${out.stores} at a plan's orders, ${out.failed} failed, ${out.told} written to`,
  );
  return out;
}
