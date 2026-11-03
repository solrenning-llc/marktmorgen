import type { NextRequest } from "next/server";
import { MAX_MEMORY_NOTE, MAX_MEMORY_NOTES, NOTE_REFUSALS } from "@/lib/assistant-memory-rules";
import { changeNote, dropNote, forgetMemory, keepNote, readMemory } from "@/lib/assistant-memory-store";
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
 * written (lib/assistant-memory-rules.ts); a note is never cut.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };
// The longest note, quoted and escaped, with room for the other fields.
const MAX_BODY_BYTES = MAX_MEMORY_NOTE * 6 + 1_000;

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "settings");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    return Response.json({ ok: true, notes: await readMemory(store.statsId), most: MAX_MEMORY_NOTES, longest: MAX_MEMORY_NOTE }, { headers: NO_STORE });
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
    const refuse = (error: keyof typeof NOTE_REFUSALS) => Response.json({ ok: false, error, message: NOTE_REFUSALS[error] }, { status: error === "unknown" ? 404 : 400 });
    if (body.action === "add") {
      const result = await keepNote(statsId, { kind: body.kind, text: body.text }, store);
      return result.ok ? answer(result.notes) : refuse(result.error);
    }
    if (body.action === "edit") {
      const result = await changeNote(statsId, id, { kind: body.kind, text: body.text }, store);
      return result.ok ? answer(result.notes) : refuse(result.error);
    }
    if (body.action === "remove") return answer(await dropNote(statsId, id, store));
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
