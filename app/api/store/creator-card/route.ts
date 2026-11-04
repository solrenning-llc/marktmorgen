import type { NextRequest } from "next/server";
import { CARD_REFUSALS, MAX_CARD_EMAIL, MAX_CARD_NAME, MAX_CARD_NOTE, MAX_CARD_TITLE, dropCreatorCard, readCreatorCard, saveCreatorCard } from "@/lib/creator-card";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";

/**
 * The creator's digital business card: 639 [GL7](22), unit 1. GET gives the
 * card as kept (off and empty when there is none); POST `{ action: "save",
 * on, name, title?, email?, phone?, website?, note? }` keeps it as typed, or
 * `{ action: "remove" }` forgets it. Settings (lib/team-roles.ts): owner and
 * Admin. A value too long or not what it should be is refused with its reason
 * and nothing is written (lib/creator-card.ts); nothing is ever cut.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };
// Every field at its longest, quoted and escaped, with room for the names.
const MAX_BODY_BYTES = (MAX_CARD_NAME + MAX_CARD_TITLE + MAX_CARD_EMAIL + 40 + 200 + MAX_CARD_NOTE) * 6 + 1_000;

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "settings");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    return Response.json({ ok: true, card: await readCreatorCard(store.statsId) }, { headers: NO_STORE });
  } catch (error) {
    console.error("reading the business card failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const statsId = store.statsId;
  if (!statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  try {
    if (body.action === "save") {
      const result = await saveCreatorCard(statsId, body, store);
      return result.ok
        ? Response.json({ ok: true, card: result.card }, { headers: NO_STORE })
        : Response.json({ ok: false, error: result.error, message: CARD_REFUSALS[result.error] }, { status: 400 });
    }
    if (body.action === "remove") {
      await dropCreatorCard(statsId, store);
      return Response.json({ ok: true, card: await readCreatorCard(statsId) }, { headers: NO_STORE });
    }
    return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    console.error("saving the business card failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
