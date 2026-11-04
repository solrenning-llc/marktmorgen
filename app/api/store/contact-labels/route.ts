import type { NextRequest } from "next/server";
import { MAX_BULK_BODY_BYTES } from "@/lib/bulk-label-rules";
import { BULK_REFUSALS, applyBulk, readBulk, reviewBulk } from "@/lib/bulk-labels";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * A label put on or taken off many contacts at once: 639 [GL7](3), unit 1.
 * POST `{ action: "review", label, change: "add" | "remove", text }` says what
 * it would do and writes nothing; `{ action: "apply", ... }` does it and
 * answers with the addresses it changed, how many it left and why, and on a
 * removal the label each contact lost as it was written there (`removed`);
 * the undo of an add is `{ action: "apply", label, change: "remove", emails:
 * <those addresses> }`, and the undo of a removal `{ action: "apply", label,
 * change: "add", restore: <removed> }`, which puts each contact's own label
 * back where it stood. The body may be as long as the longest of these at
 * their limits (MAX_BULK_BODY_BYTES), so an undo always fits. The same
 * permission as importing contacts ("send"). It starts no automation
 * (lib/bulk-labels.ts).
 */

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", MAX_BULK_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (body.action !== "review" && body.action !== "apply") return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const read = readBulk(body);
  if (!read.ok) return Response.json({ ok: false, error: read.error, message: BULK_REFUSALS[read.error] }, { status: 400 });
  if (!store.listId) return Response.json({ ok: true, review: { changes: 0, already: 0, notOnList: read.ask.emails.length, full: 0, skipped: read.ask.skipped }, asked: read.ask.emails.length, changed: [], already: 0, full: 0, notOnList: read.ask.emails.length, noRoom: 0, removed: [] }, { headers: NO_STORE });
  try {
    if (body.action === "review") return Response.json({ ok: true, review: await reviewBulk(store.listId, read.ask) }, { headers: NO_STORE });
    const done = await applyBulk(store.listId, read.ask, store);
    return Response.json({ ok: true, label: read.ask.label, change: read.ask.change, asked: done.asked, changed: done.changed, already: done.already, full: done.full, notOnList: done.notOnList, noRoom: done.noRoom, removed: done.removed }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    console.error("changing labels in bulk failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
