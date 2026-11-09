import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { type TakedownAction, TakedownNoticeUnsent, TakedownNoticeUnsure, openReport, sendOwedNotice, takeDown } from "@/lib/takedown";

/**
 * Acts on a notice (app/takedown/[token]): `{ token, action }`, where the
 * token is the one in the email the notice was sent in. Only the store the
 * notice is about can be touched with it. With `owed: true` (the page's
 * "Send the email to the creator") it only sends the notice still owed, in
 * its kept words, and never takes anything down, even content up again; a
 * takedown never confirmed as landed, whose content is up, answers 409
 * "unconfirmed" and sends nothing. A notice to the creator that may have gone
 * unconfirmed answers "notice_unsure", now and on every later press, and is
 * never sent again.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await (await limited(request, 4_000)).json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const opened = await openReport(typeof body.token === "string" ? body.token : "");
  if (!opened) return Response.json({ ok: false, error: "gone" }, { status: 404 });
  if (!opened.store) return Response.json({ ok: false, error: "no_store" }, { status: 400 });
  const raw = body.action && typeof body.action === "object" ? (body.action as Record<string, unknown>) : {};
  const id = typeof raw.id === "string" ? raw.id.slice(0, 64) : "";
  const action: TakedownAction | null =
    raw.type === "link" && id ? { type: "link", id }
    : raw.type === "product" && id ? { type: "product", id }
    : raw.type === "kit" ? { type: "kit" }
    : raw.type === "store" ? { type: "store", on: raw.on === true }
    : null;
  if (!action) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  const owed = body.owed === true;
  if (owed && action.type === "store" && !action.on) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    if (owed) {
      const sent = await sendOwedNotice(opened.report, opened.store, action, originFrom(request));
      if (sent === "unconfirmed") return Response.json({ ok: false, error: "unconfirmed" }, { status: 409 });
      if (!sent) return Response.json({ ok: false, error: "nothing" }, { status: 409 });
      return Response.json({ ok: true, done: sent.done });
    }
    const done = await takeDown(opened.report, opened.store, action, originFrom(request));
    if (!done) return Response.json({ ok: false, error: "nothing" }, { status: 409 });
    return Response.json({ ok: true, done });
  } catch (error) {
    // Down, but the creator was not told: the operator presses again to send the notice (lib/takedown.ts).
    if (error instanceof TakedownNoticeUnsent) {
      console.error("the takedown notice to the creator was not sent");
      return Response.json({ ok: false, error: "notice_unsent" }, { status: 500 });
    }
    // Down, and the creator's notice may have gone: it is never sent again, so the creator never gets two.
    if (error instanceof TakedownNoticeUnsure) {
      console.error("the takedown notice to the creator may have gone; it is not sent again");
      return Response.json({ ok: false, error: "notice_unsure" }, { status: 500 });
    }
    console.error("taking content down failed", error);
    return Response.json({ ok: false, error: "error" }, { status: 500 });
  }
}
