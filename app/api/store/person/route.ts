import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import { StoreFullError } from "@/lib/store-full";
import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { studioPath } from "@/lib/studio-route";
import { addPersonNote, addressForToken, findToken, forgetFindToken, readAddress, removePersonNote } from "@/lib/buyer-profile";
import { erasePerson } from "@/lib/person-erasure";
import { rightsDateWords } from "@/lib/rights-budget-rules";

/** Said in the studio when a deletion is scheduled (lib/person-erasure.ts, "scheduled"). */
const scheduledWords = (by: number) =>
  `Your store has used up, for this month, what Marktmorgen sets aside for people's requests to delete or copy their data, so this deletion is scheduled. It is done by itself by ${rightsDateWords(by)}, one month after it was asked, as the law requires. It does not take your plan's studio requests, and there is nothing more for you to do.`;

/** How many addresses one store may look up in an hour: each look reads Stripe. */
const FINDS_PER_HOUR = 200;

/**
 * A buyer's page in the studio (lib/buyer-profile.ts), for whoever may read
 * orders with the buyer's address (lib/team-roles.ts, "orders"):
 *
 *   { action: "find", email }            → the address of its page, which carries a token, never the address
 *   { action: "note", person, text }     → adds a note about that person; answers the notes
 *   { action: "unnote", person, id }     → takes one away; answers the notes
 *   { action: "erase", token, confirm }  → deletes the person the page's token found, and
 *                                          everything the store keeps about them
 *                                          (lib/person-erasure.ts); "erase" permission only
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, (body) => (body.action === "erase" ? "erase" : "orders"), 2_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  const noStore = { headers: { "Cache-Control": "no-store" } };
  try {
    if (body.action === "find") {
      const email = readAddress(body.email);
      if (!email) return Response.json({ ok: false, error: "email" }, { status: 400 });
      const refused = await withinServiceWhy("person-find", guarded.store.sid || guarded.store.handle, FINDS_PER_HOUR, 60 * 60, guarded.store);
      if (refused) return serviceRefusedJson(refused, "limited");
      const token = await findToken(guarded.store, email);
      if (!token) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
      return Response.json({ ok: true, href: studioPath(guarded.store, `p=${token}`, "people") }, noStore);
    }

    if (body.action === "erase") {
      // Typed by whoever presses, so a slip of the mouse deletes nobody.
      if (body.confirm !== "DELETE") return Response.json({ ok: false, error: "confirm" }, { status: 400 });
      const token = typeof body.token === "string" ? body.token : "";
      const email = await addressForToken(guarded.store, token);
      if (!email) return Response.json({ ok: false, error: "expired" }, { status: 410 });
      const result = await erasePerson(guarded.store, email, { kind: "team", who: guarded.email, role: guarded.role });
      if (result.ok) {
        await forgetFindToken(token);
        const left = result.notes.includes("discord-roles") ? "&discord=1" : "";
        return Response.json({ ok: true, records: result.records, notes: result.notes, href: studioPath(guarded.store, `erased=1${left}`, "people") }, noStore);
      }
      if (result.reason === "incomplete") return Response.json({ ok: false, error: "incomplete", failed: result.failed }, { status: 503 });
      // The month's budget for people's data requests is used up: scheduled, done by itself by its legal deadline
      // (lib/rights-queue.ts), never refused; the page says by when.
      if (result.reason === "scheduled") {
        await forgetFindToken(token);
        return Response.json({ ok: false, error: "scheduled", message: scheduledWords(result.by) }, { status: 202, ...noStore });
      }
      const said = "message" in result && typeof result.message === "string" ? { message: result.message } : {};
      return Response.json({ ok: false, error: result.reason, ...said }, { status: result.reason === "email" ? 400 : 503 });
    }

    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.store.email);
    if (!store?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    const person = typeof body.person === "string" ? body.person : "";
    if (body.action === "note") {
      const notes = await addPersonNote(store.statsId, person, guarded.email, body.text, store);
      if (!notes) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      return Response.json({ ok: true, notes }, noStore);
    }
    if (body.action === "unnote") {
      return Response.json({ ok: true, notes: await removePersonNote(store.statsId, person, body.id, store) }, noStore);
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("a buyer's page could not do that", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
