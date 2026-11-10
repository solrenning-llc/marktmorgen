import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { MAX_SUPPORT_TEXT, sendSupportRequest } from "@/lib/help-support";

/**
 * "Send this to support" from the studio's help (lib/help-support.ts): `{ text, screen }`. Anybody on the store's
 * team may send; the request goes from their own signed-in address, with the store and its plan read here, never
 * from the request. Nothing is sent unless they pressed the button on words they could see and edit.
 */
const STATUS = { short: 400, long: 413, busy: 429, unknown: 503, unsent: 502 } as const;

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "member", MAX_SUPPORT_TEXT * 4 + 1_000);
  if (!guarded.ok) return guarded.response;
  const done = await sendSupportRequest({ store: guarded.store, from: guarded.email, text: guarded.body.text, screen: guarded.body.screen });
  if (!done.ok) {
    const wait = done.problem === "busy" && typeof done.retryInSeconds === "number" ? { "Retry-After": String(done.retryInSeconds) } : undefined;
    return Response.json({ ok: false, error: done.problem, words: done.words, retryInSeconds: done.retryInSeconds ?? null }, { status: STATUS[done.problem], headers: wait });
  }
  return Response.json({ ok: true, value: { number: done.number, copied: done.copied } });
}
