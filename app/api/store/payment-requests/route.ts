import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { ensureStoreId } from "@/lib/store";
import { DRAFT_PROBLEMS, ID_PATTERN, readDraft, readOutside } from "@/lib/payment-request-rules";
import { cancelRequest, createRequest, deleteRequest } from "@/lib/payment-request-store";
import { markPaidOutside, remindNow, requestsOpen, sendRequestEmail } from "@/lib/payment-requests";

/**
 * The studio's payment requests (lib/payment-request-rules.ts), for a role
 * that may email people for the store ("send": the owner and admins):
 *
 *   { action: "create", email, name, lines: [{ text, quantity, amount }], note, dueDate, autoReminders, consent }
 *   { action: "remind" | "cancel" | "delete", id }
 *   { action: "outside", id, method: "cash" | "transfer" | "other", date: "2026-11-02", note }   paid outside Stripe (639 [GL7](30))
 *
 * Creating keeps the request within every count and emails it at once, from
 * the store's emails for the month. Answers `{ ok, sent? }` or `{ ok: false,
 * error, message }` with a sentence to show.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", 16_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  let store = guarded.store;
  const refuse = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });
  try {
    const action = text(body.action, 20);
    if (action === "create") {
      if (!requestsOpen(store)) return refuse("closed", "Payment requests can be sent once your Stripe account takes payments and your plan, or free trial, is running.", 409);
      if (!store.sid) store = (await ensureStoreId(guarded.ref)) ?? store;
      const read = readDraft(body, store.currency);
      if (!read.ok) return refuse(read.problem, read.line !== undefined ? `Line ${read.line + 1}: ${DRAFT_PROBLEMS[read.problem]}` : DRAFT_PROBLEMS[read.problem]);
      const created = await createRequest(store, read.draft);
      if (!created.ok) return refuse(created.reason, created.message, created.reason === "unavailable" ? 503 : 409);
      const done = await sendRequestEmail(store, created.request);
      return Response.json({ ok: true, id: created.request.id, sent: done.sent });
    }
    const id = text(body.id, 40);
    if (!ID_PATTERN.test(id)) return refuse("invalid", "That request is not one of this store's. Reload the page.");
    if (action === "remind") {
      if (!requestsOpen(store)) return refuse("closed", "Your store can't take payments right now, so nothing was sent.", 409);
      const done = await remindNow(store, id);
      if (!done.ok) return refuse("not_now", done.why, 409);
      return Response.json({ ok: true, sent: done.sent });
    }
    if (action === "outside") {
      const mark = readOutside(body);
      if (!mark) return refuse("method", "Choose how it was paid: cash, bank transfer or another way.");
      const day = text(body.date, 10);
      const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T12:00:00Z`) : NaN;
      // A day that has come, in the last year: a later one is not a payment yet.
      if (!Number.isFinite(at) || at - 12 * 3_600_000 > Date.now() || Date.now() - at > 366 * 86_400_000) return refuse("date", "Type the day it was paid: today or a day in the last year.");
      const done = await markPaidOutside(store, id, { ...mark, paidAt: at });
      if (done.ok) return Response.json({ ok: true });
      const why: Record<typeof done.reason, [string, number]> = {
        gone: ["Only an open request can be marked as paid. Reload the page.", 409],
        busy: ["The buyer is opening the payment page right now. Try again in a minute.", 409],
        paid_online: ["It was paid online through its payment page, so it is now marked as paid that way. Nothing else was changed.", 409],
        processing: ["The buyer's online payment is still being processed. Wait for it, then reload the page.", 409],
        error: ["Its payment page could not be closed on Stripe, so nothing was marked. Try again in a minute.", 502],
      };
      return refuse(done.reason, why[done.reason][0], why[done.reason][1]);
    }
    if (action === "cancel") {
      const done = await cancelRequest(store, id);
      if (done === null) return refuse("gone", "That request is gone. Reload the page.", 404);
      if (done === "not_open") return refuse("not_open", "Only an open request can be canceled.", 409);
      return Response.json({ ok: true });
    }
    if (action === "delete") {
      const done = await deleteRequest(store, id);
      if (done === null) return refuse("gone", "That request is gone. Reload the page.", 404);
      if (done === "open") return refuse("open", "Cancel the request before deleting it.", 409);
      return Response.json({ ok: true });
    }
    return refuse("invalid", "That is not something this page can do.");
  } catch (error) {
    console.error("a payment request action failed", error);
    return refuse("server_error", "That could not be done right now. Try again in a minute.", 500);
  }
}
