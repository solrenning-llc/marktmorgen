import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { fileAppeal, sendAgain } from "@/lib/takedown-appeals";
import { MAX_APPEAL_TEXT } from "@/lib/takedown-appeal-rules";

/**
 * "Ask us to look again" at a decision that took content down or switched the store off (646 [WG6], unit 2;
 * lib/takedown-appeals.ts).
 *
 * `{ action: "file", decision, explanation }` keeps the request and tells our support inbox; `{ action: "again",
 * decision }` tells the inbox again about a kept request it was never told of. The owner and admins may do either
 * ("settings", lib/team-roles.ts), a store switched off included: that is when it matters most. Free; nothing is
 * counted against the plan. Nothing else is read or written.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", MAX_APPEAL_TEXT * 4 + 1_000);
  if (!guarded.ok) return guarded.response;
  const noStore = { "Cache-Control": "private, no-store" };
  const action = text(guarded.body.action, 10);
  const decision = text(guarded.body.decision, 200);
  if ((action !== "file" && action !== "again") || !decision) return Response.json({ ok: false, error: "invalid" }, { status: 400, headers: noStore });
  const origin = request.nextUrl.origin;
  try {
    const done = action === "file"
      ? await fileAppeal(guarded.store, decision, { explanation: guarded.body.explanation }, new Date(), origin)
      : await sendAgain(guarded.store, decision, origin);
    if (!done) return Response.json({ ok: false, error: "decision" }, { status: 404, headers: noStore });
    if (!done.ok) {
      // Kept but not passed on: the request exists, with its number; the page offers to send it again.
      const status = done.problem === "unsent" ? 202 : done.problem === "unknown" ? 503 : done.problem === "already" ? 409 : 400;
      return Response.json({ ok: false, error: done.problem, message: done.words }, { status, headers: noStore });
    }
    return Response.json({ ok: true, number: done.kept.appeal.number, state: done.kept.appeal.state, told: done.kept.told }, { headers: noStore });
  } catch (error) {
    console.error("appeal failed", error);
    // "file" may not have kept anything; "again" works on a request that is kept, so it is never said to be lost.
    const message = action === "file" ? "We could not keep your request just now, so nothing was sent. Try again in a moment." : "We could not check your request just now. It is still kept. Try again in a moment.";
    return Response.json({ ok: false, error: "server_error", message }, { status: 503, headers: noStore });
  }
}
