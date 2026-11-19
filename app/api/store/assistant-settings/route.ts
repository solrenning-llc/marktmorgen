import type { NextRequest } from "next/server";
import { setAssistReminder, setAssistant, setNextOffer } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { clearAssistantMissed } from "@/lib/store-assistant";
import { readNextExpect } from "@/lib/setting-expect";

/**
 * The Store assistant's setting (lib/store-assistant-rules.ts), from the
 * studio: `{ on, notes }` switches its chat on or off and keeps the
 * creator's notes for it; `{ clear: true }` forgets the questions it could
 * not answer, once read; `{ next: { on, email } }` switches the next
 * product after a purchase on or off, and its line in the confirmation
 * email (lib/next-offer-rules.ts), with `expect`, the setting as the page
 * read it, compared with what is saved under the store's lock ("changed",
 * 409, nothing written: lib/setting-expect.ts); `{ remind: { on } }` switches the box
 * that asks for one checkout reminder on or off (lib/assistant-reminder-rules.ts).
 * What a store's pages say to buyers is the "page"
 * permission. Switching it on is allowed before the add-on is paid for: the
 * chat shows only while it is.
 */
export async function POST(request: NextRequest) {
  // Emptying the list of missed questions cannot be undone: named apart (lib/two-step.ts).
  const guarded = await guardStoreWrite(request, "page", 6_000, (sent) => (sent.clear === true ? "clear" : ""));
  if (!guarded.ok) return guarded.response;
  try {
    if (guarded.body.clear === true) {
      await clearAssistantMissed(guarded.store);
      return Response.json({ ok: true });
    }
    if (guarded.body.next && typeof guarded.body.next === "object") {
      const expect = readNextExpect(guarded.body.expect);
      if (expect === "invalid") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      const changed = await setNextOffer(guarded.ref, guarded.body.next, expect ?? undefined);
      if (changed === "changed") return Response.json({ ok: false, error: "changed" }, { status: 409 });
      if (!changed) return Response.json({ ok: false, error: "none" }, { status: 400 });
      return Response.json({ ok: true, next: changed.nextOffer });
    }
    if (guarded.body.remind && typeof guarded.body.remind === "object") {
      const changed = await setAssistReminder(guarded.ref, guarded.body.remind);
      if (!changed) return Response.json({ ok: false, error: "none" }, { status: 400 });
      return Response.json({ ok: true, remind: changed.assistReminder });
    }
    const store = await setAssistant(guarded.ref, { on: guarded.body.on === true, notes: guarded.body.notes });
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
    return Response.json({ ok: true, on: store.assistant.on });
  } catch (error) {
    console.error("saving the assistant setting failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
