import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { closingOf } from "@/lib/plan-closing";
import { giveBackUnused } from "@/lib/closing-refunds";

/** Seconds this route may run (route segment config, node_modules/next/dist/docs/.../maxDuration.md); the refunds stop well before it and say what is left. */
export const maxDuration = 60;

/**
 * The creator gives back the time members paid for past the store's closing
 * day, after reading every amount on the review screen
 * (app/studio/closing-refunds; queue item 307 [EC1], part 4). `mark` is that
 * screen's fingerprint: when what Stripe says changed since it was drawn,
 * nothing is done and the screen is drawn again. From the creator's own
 * Stripe account only, each refund once (lib/closing-refunds.ts). The
 * owner's billing permission, never counted against a paused studio.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "billing");
  if (!guarded.ok) return guarded.response;
  const mark = typeof guarded.body.mark === "string" && /^[0-9a-f]{64}$/.test(guarded.body.mark) ? guarded.body.mark : null;
  if (!mark) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  const until = Date.now() + 40_000;
  try {
    const closing = await closingOf(guarded.store);
    if (!closing) return Response.json({ ok: false, error: "not_closing" }, { status: 409 });
    const result = await giveBackUnused(guarded.store, closing.day, { mark, until });
    if (result === "changed") return Response.json({ ok: false, error: "changed" }, { status: 409 });
    if (result === "busy") return Response.json({ ok: false, error: "busy" }, { status: 409 });
    if (result === "unavailable") return Response.json({ ok: false, error: "unavailable" }, { status: 409 });
    return Response.json({
      ok: true,
      done: result.done.length,
      given: result.done.map((row) => ({ amount: row.amount, cur: row.cur })),
      short: result.short.map((row) => ({ amount: row.amount, cur: row.cur })),
      pending: result.pending,
      disputed: result.disputed,
      none: result.none,
      over: result.over,
      failed: result.failed,
      left: result.left,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("giving back members' unused time from the studio failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
