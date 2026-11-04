import type { NextRequest } from "next/server";
import { MAX_BULK_BODY_BYTES } from "@/lib/bulk-label-rules";
import { BULK_REFUSALS, applyBulk, readBulk, reviewBulk } from "@/lib/bulk-labels";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * A label put on or taken off many contacts at once: 639 [GL7](3), unit 1.
 * POST `{ action: "review", label, change: "add" | "remove", text }` says what
 * it would do and writes nothing; `{ action: "apply", ... }` does it and
 * answers with the addresses it changed, how many it left and why, and the
 * form each contact lost on a removal (`removed`) or had replaced on an add
 * (`replaced`); an undo is `{ action: "apply", label, change: <the opposite>,
 * emails: <the other addresses changed>, restore: <removed or replaced> }`,
 * which puts each contact's own form back where it stood. When something
 * fails after some contacts were written, those are answered with the rest
 * counted (`noRoom`, `failed`), so the undo still works. The body may be as long as the longest of these at
 * their limits (MAX_BULK_BODY_BYTES), so an undo always fits. The same
 * permission as importing contacts ("send"). It starts no automation
 * (lib/bulk-labels.ts).
 */

/** Seconds this route may run (route segment config): 1,000 contacts are read and written 200 at a time, each write tried up to three times, as the contacts import does. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", MAX_BULK_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (body.action !== "review" && body.action !== "apply") return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const read = readBulk(body);
  if (!read.ok) return Response.json({ ok: false, error: read.error, message: BULK_REFUSALS[read.error] }, { status: 400 });
  if (!store.listId) return Response.json({ ok: true, review: { changes: 0, already: 0, notOnList: read.ask.emails.length, full: 0, skipped: read.ask.skipped }, asked: read.ask.emails.length, changed: [], already: 0, full: 0, notOnList: read.ask.emails.length, noRoom: 0, failed: 0, removed: [], replaced: [] }, { headers: NO_STORE });
  try {
    if (body.action === "review") return Response.json({ ok: true, review: await reviewBulk(store.listId, read.ask) }, { headers: NO_STORE });
    const done = await applyBulk(store.listId, read.ask, store);
    return Response.json({ ok: true, label: read.ask.label, change: read.ask.change, asked: done.asked, changed: done.changed, already: done.already, full: done.full, notOnList: done.notOnList, noRoom: done.noRoom, failed: done.failed, removed: done.removed, replaced: done.replaced }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    console.error("changing labels in bulk failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
