import type { NextRequest } from "next/server";
import { MAX_MEMORY_NOTE, MAX_MEMORY_NOTES, NOTE_REFUSALS } from "@/lib/assistant-memory-rules";
import { MEMORY_STORE_REFUSALS, type MemoryChange, changeNote, dropNote, forgetMemory, keepNote, readMemoryState } from "@/lib/assistant-memory-store";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";

/**
 * The creator's own notes for their assistant: 639 [GL7](40), unit 3. GET
 * lists every note; POST `{ action: "add", kind, text }`, `{ action: "edit",
 * id, kind?, text? }`, `{ action: "remove", id }` or `{ action: "forget" }`
 * (every note at once) changes them. Settings (lib/team-roles.ts): owner and
 * Admin. A note with anyone's details, too long, too short, of no kind or
 * past the most a store keeps is refused with its reason and nothing is
 * written (lib/assistant-memory-rules.ts); a note is never cut. A change
 * made while another one holds the notes is refused as busy (409); notes
 * that are kept but cannot be read are said so (503), never listed as none,
 * and never written over (lib/assistant-memory-store.ts).
 */

const NO_STORE = { "Cache-Control": "private, no-store" };
// The longest note, quoted and escaped, with room for the other fields.
const MAX_BODY_BYTES = MAX_MEMORY_NOTE * 6 + 1_000;
/** What the studio shows instead of "no notes" when the notes are kept but cannot be read. */
const NOTES_UNREADABLE = "Your assistant's notes could not be read just now. Try again in a moment.";

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "settings");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    const read = await readMemoryState(store.statsId);
    if (!read.ok) return Response.json({ ok: false, error: "unreadable", message: NOTES_UNREADABLE }, { status: 503, headers: NO_STORE });
    return Response.json({ ok: true, notes: read.notes, most: MAX_MEMORY_NOTES, longest: MAX_MEMORY_NOTE }, { headers: NO_STORE });
  } catch (error) {
    console.error("reading the assistant's notes failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const statsId = store.statsId;
  if (!statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  const id = typeof body.id === "string" ? body.id.slice(0, 20) : "";
  try {
    const answer = (notes: unknown) => Response.json({ ok: true, notes }, { headers: NO_STORE });
    const reply = (result: MemoryChange) => {
      if (result.ok) return answer(result.notes);
      if (result.error === "busy") return Response.json({ ok: false, error: "busy", message: MEMORY_STORE_REFUSALS.busy }, { status: 409, headers: NO_STORE });
      if (result.error === "unreadable") return Response.json({ ok: false, error: "unreadable", message: MEMORY_STORE_REFUSALS.unreadable }, { status: 503, headers: NO_STORE });
      return Response.json({ ok: false, error: result.error, message: NOTE_REFUSALS[result.error] }, { status: result.error === "unknown" ? 404 : 400 });
    };
    if (body.action === "add") return reply(await keepNote(statsId, { kind: body.kind, text: body.text }, store));
    if (body.action === "edit") return reply(await changeNote(statsId, id, { kind: body.kind, text: body.text }, store));
    if (body.action === "remove") return reply(await dropNote(statsId, id, store));
    if (body.action === "forget") {
      await forgetMemory(statsId, store);
      return answer([]);
    }
    return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("saving the assistant's notes failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
