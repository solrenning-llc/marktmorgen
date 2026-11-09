import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { setHeardOff } from "@/lib/heard";

/**
 * Whether buyers are asked where they heard of the store (lib/heard.ts):
 * `{ ask: true | false }`. A setting, because it changes what buyers see.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 500);
  if (!guarded.ok) return guarded.response;
  if (typeof guarded.body.ask !== "boolean") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    await setHeardOff(guarded.store, !guarded.body.ask);
    return Response.json({ ok: true, ask: guarded.body.ask }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("changing the question after paying failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
