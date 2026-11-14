import type { NextRequest } from "next/server";
import { setHasDiscounts, storeForEmail } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";
import { createCode, listCodes, stopCode } from "@/lib/discount";
import { readCodeAsked } from "@/lib/discount-input";
import { guardStoreWrite, text } from "@/lib/store-request";
import { countStudio } from "@/lib/studio-route";
import { SCHEDULE_UNITS, readWindow } from "@/lib/discount-schedule-rules";
import { cancelSchedule, dropSchedule, readSchedules, scheduleCode } from "@/lib/discount-schedule";

const ACTIONS = new Set(["list", "add", "stop", "schedule", "unschedule"]);

/**
 * The creator's discount codes, which live on their own Stripe account.
 *
 * Every answer here is read from Stripe rather than from anything we keep, so
 * the redemption counts are the real ones and a code the creator switched off
 * in their own dashboard shows as off here too. The only thing written on our
 * side is the one bit the buyer's checkout needs: whether to show a box at all.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;

  const { ref, body } = guarded;
  const action = text(body.action, 10);
  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    const store = await storeForEmail(ref);
    if (!store) {
      return Response.json({ ok: false, error: "none" }, { status: 400 });
    }
    // A code discounts a charge, and a store that cannot charge has nothing to
    // discount. Said here rather than letting Stripe refuse it later.
    if (!store.stripeAccountId || !canSell(store)) {
      return Response.json({ ok: false, error: "not_selling" }, { status: 400 });
    }
    const account = store.stripeAccountId;
    // What a cancel did, for the studio to say it in words: "done" (it never started and stays off) or
    // "stopped" (it had no schedule left, so it may have started, and Stripe now has it off).
    let cancelState: "done" | "stopped" | null = null;

    if (action === "add") {
      // Read the same way as the API's (lib/discount-input.ts).
      const read = readCodeAsked(body, store.currency);
      if (!read.ok) {
        return Response.json(
          { ok: false, error: "code", reason: read.reason },
          { status: 400 },
        );
      }
      const { code, off, maxRedemptions, minimum } = read.asked;

      const made = await createCode(account, code, off, maxRedemptions, minimum);
      if (!made.ok) {
        return Response.json(
          { ok: false, error: made.reason },
          { status: made.reason === "taken" ? 409 : 502 },
        );
      }
      await setHasDiscounts(ref, true);
    } else if (action === "schedule") {
      // A code with a start and an end set ahead (511 [CK3], lib/discount-schedule.ts).
      const read = readCodeAsked(body, store.currency);
      if (!read.ok) {
        return Response.json({ ok: false, error: "code", reason: read.reason }, { status: 400 });
      }
      const now = Math.floor(Date.now() / 1000);
      const window = readWindow(body, now);
      if (!window.ok) {
        return Response.json({ ok: false, error: "schedule", reason: window.reason }, { status: 400 });
      }
      // Every try the five-minute job may make is paid for now, before Stripe is asked anything.
      const paid = await countStudio(store, null, SCHEDULE_UNITS);
      if (!paid.ok) {
        return Response.json({ ok: false, error: "studio_used", message: paid.message }, { status: 429 });
      }
      const made = await scheduleCode(store, read.asked, { start: window.start, end: window.end }, now);
      if (!made.ok) {
        if (made.reason === "full" || made.reason === "busy") {
          return Response.json({ ok: false, error: "schedule", reason: made.reason }, { status: made.reason === "busy" ? 409 : 400 });
        }
        if (made.reason === "unknown") {
          return Response.json({ ok: false, error: "server_error" }, { status: 503 });
        }
        // "live": Stripe made it live at once and did not confirm it off; it is kept for the studio to list.
        return Response.json({ ok: false, error: made.reason }, { status: made.reason === "taken" ? 409 : 502 });
      }
    } else if (action === "unschedule") {
      const id = text(body.id, 80);
      if (!id) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      const canceled = await cancelSchedule(store, id);
      if (canceled === "busy") {
        return Response.json({ ok: false, error: "schedule", reason: "busy" }, { status: 409 });
      }
      // Either answer means Stripe confirmed the code off; anything else is never said to be off.
      if (canceled !== "done" && canceled !== "stopped") {
        return Response.json({ ok: false, error: "stripe" }, { status: 502 });
      }
      cancelState = canceled;
    } else if (action === "stop") {
      const id = text(body.id, 80);
      if (!id) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      // A code waiting for its start loses its schedule first, so the job never switches it back on.
      const dropped = await dropSchedule(store, id);
      if (dropped === "busy") {
        return Response.json({ ok: false, error: "schedule", reason: "busy" }, { status: 409 });
      }
      if (dropped !== "done") {
        return Response.json({ ok: false, error: "stripe" }, { status: 502 });
      }
      if (!(await stopCode(account, id))) {
        return Response.json({ ok: false, error: "stripe" }, { status: 502 });
      }
    }

    // Listed last on every path, so the answer the creator gets back is what
    // Stripe says now rather than what we believe we just did.
    const list = await listCodes(account);
    // The schedules beside them, read exactly: a code waiting for its start is never shown as simply off.
    const kept = await readSchedules(store.statsId);
    if (list.state !== "ok" || !kept.ok) {
      // A make, a stop or a schedule change Stripe already did is said as
      // done, so it is not pressed again; only the list after it is
      // unconfirmed, and nothing is written from it. The studio shows its
      // "could not confirm" words.
      if (action !== "list") return Response.json({ ok: true, done: action, listed: false });
      return Response.json({ ok: false, error: "stripe" }, { status: 502 });
    }
    // A live code on the page is enough for the box; "no live code" only
    // from a list read to its end. A page with more behind it leaves the bit
    // as it was (rule 24), and the studio says it shows the newest codes.
    const live = list.codes.some((entry) => entry.active);
    if (live || list.complete) await setHasDiscounts(ref, live);

    return Response.json({ ok: true, codes: list.codes, complete: list.complete, schedules: kept.schedules, ...(cancelState ? { canceled: cancelState } : {}) });
  } catch (error) {
    console.error("changing a discount code failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
