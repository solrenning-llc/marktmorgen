import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { addNote, removeNote } from "@/lib/stats-notes";

/**
 * Notes on the numbers (lib/stats-notes.ts): `{ action: "add", day, text }`
 * puts one on a day, `{ action: "remove", id }` takes one away. For whoever
 * may see the numbers. Answers the list as it is after.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "stats", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.ref);
    if (!store?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    if (body.action === "add") {
      const notes = await addNote(store.statsId, body.day, body.text);
      if (!notes) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      return Response.json({ ok: true, notes }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "remove") {
      return Response.json({ ok: true, notes: await removeNote(store.statsId, body.id) }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing a note on the numbers failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
