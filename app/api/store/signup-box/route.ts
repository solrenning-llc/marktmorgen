import type { NextRequest } from "next/server";
import { setJoin } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { parseJoinBox } from "@/lib/store-field-rules";
import { checkRecommended } from "@/lib/join-recommend";

/**
 * Switches the sign-up box on the store page and saves its words:
 * `{ on, heading, line, recommend }` (lib/store-join.ts). It is part of the page, so it
 * needs the "page" permission. The stores it recommends after a sign-up must be
 * real stores other than this one (lib/join-recommend.ts): any that is not is
 * named back, and nothing is saved.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", 2_000);
  if (!guarded.ok) return guarded.response;
  try {
    const check = await checkRecommended(guarded.store, parseJoinBox(guarded.body).recommend);
    if (!check.ok) return Response.json({ ok: false, error: "recommend", refused: check.refused }, { status: 400 });
    const store = await setJoin(guarded.ref, guarded.body);
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 404 });
    return Response.json({ ok: true, join: store.join });
  } catch (error) {
    console.error("saving the sign-up box failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
