import type { NextRequest } from "next/server";
import { BULK_REFUSALS, applyBulk, readBulk, reviewBulk } from "@/lib/bulk-labels";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * A label put on or taken off many contacts at once: 639 [GL7](3), unit 1.
 * POST `{ action: "review", label, change: "add" | "remove", text }` says what
 * it would do and writes nothing; `{ action: "apply", ... }` does it and
 * answers with the addresses it changed; an undo is `{ action: "apply",
 * label, change: <the opposite>, emails: <those addresses> }`. The same
 * permission as importing contacts ("send"). It starts no automation
 * (lib/bulk-labels.ts).
 */

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", 450_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (body.action !== "review" && body.action !== "apply") return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const read = readBulk(body);
  if (!read.ok) return Response.json({ ok: false, error: read.error, message: BULK_REFUSALS[read.error] }, { status: 400 });
  if (!store.listId) return Response.json({ ok: true, review: { changes: 0, already: 0, notOnList: read.ask.emails.length, full: 0, skipped: read.ask.skipped }, changed: [] }, { headers: NO_STORE });
  try {
    if (body.action === "review") return Response.json({ ok: true, review: await reviewBulk(store.listId, read.ask) }, { headers: NO_STORE });
    const done = await applyBulk(store.listId, read.ask, store);
    return Response.json({ ok: true, label: read.ask.label, change: read.ask.change, changed: done.changed, already: done.already }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    console.error("changing labels in bulk failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
