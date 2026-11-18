import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { MAX_SUPPORT_TEXT, requestNumber, sendSupportRequest } from "@/lib/help-support";

/**
 * "Send this to support" from the studio's help (lib/help-support.ts): `{ text, screen, number }`, the number made
 * once by the form for this request (a fresh one when it is missing or not in the shape of one). Anybody on the store's
 * team may send; the request goes from their own signed-in address, with the store and its plan read here, never
 * from the request. Nothing is sent unless they pressed the button on words they could see and edit.
 */
const STATUS = { short: 400, long: 413, busy: 429, unknown: 503, unconfirmed: 502 } as const;

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "member", MAX_SUPPORT_TEXT * 4 + 1_000);
  if (!guarded.ok) return guarded.response;
  const done = await sendSupportRequest({ store: guarded.store, from: guarded.email, text: guarded.body.text, screen: guarded.body.screen }, requestNumber(guarded.body.number));
  if (!done.ok) {
    const wait = done.problem === "busy" && typeof done.retryInSeconds === "number" ? { "Retry-After": String(done.retryInSeconds) } : undefined;
    return Response.json({ ok: false, error: done.problem, words: done.words, retryInSeconds: done.retryInSeconds ?? null, ...(done.number ? { number: done.number } : {}) }, { status: STATUS[done.problem], headers: wait });
  }
  return Response.json({ ok: true, value: { number: done.number, copied: done.copied } });
}
