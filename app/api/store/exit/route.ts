import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { closingOf } from "@/lib/plan-closing";
import { chooseExitNotice } from "@/lib/store";

/**
 * The owner of a closing store gives, changes or takes away (`to` empty) the
 * new address shown for 90 days at the store's old addresses once it has
 * closed (97 [D2-OPEN-EXIT]; app/studio/moved). Only before the closing day
 * of a store that closes whole, read from the store's own closing here, never
 * from the request. The settings permission.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 4_000, () => "exit");
  if (!guarded.ok) return guarded.response;
  const to = guarded.body.to;
  if (to !== undefined && to !== null && typeof to !== "string") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    const closing = await closingOf(guarded.store);
    if (!closing) return Response.json({ ok: false, error: "not_closing" }, { status: 409 });
    const result = await chooseExitNotice(guarded.ref, to ?? "", closing);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "not_closing" || result.reason === "none" ? 409 : 400 });
    return Response.json({ ok: true, to: result.store.exitNotice?.to ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("keeping a closing store's new address failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
