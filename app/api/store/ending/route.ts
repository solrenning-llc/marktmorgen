import type { NextRequest } from "next/server";
import { setEnding } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/** The reminder a member gets the day before their access ends (361 [AP1] (e), lib/access-ending-rules.ts): `{ on, address }`. */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  try {
    const result = await setEnding(guarded.ref, { on: guarded.body.on, address: guarded.body.address });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    return Response.json({ ok: true, ending: result.store.ending });
  } catch (error) {
    console.error("saving the access reminder failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
