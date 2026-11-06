import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId, setAdsServer } from "@/lib/store";
import { type ServerPlatform, SERVER_PLATFORMS, platformsOn, serverSetup, setServerToken, setTestCode } from "@/lib/ad-events";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * Sending conversions from the server (lib/ad-events.ts): `{ platform, token,
 * account? }` keeps a platform's access token, sealed, or forgets it when
 * `token` is empty (Pinterest's also needs its ad account); `{ testCode }`
 * sets or clears Meta's test event code. A setting. Answers which platforms
 * have a token, never a token, and writes the same on the store, so a
 * checkout knows whether to keep anything without asking. A setup that
 * cannot be read exactly answers 503 and writes nothing, neither the setup
 * nor the store's list.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 2_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.ref);
    if (!store?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    if (typeof body.platform === "string") {
      if (!SERVER_PLATFORMS.includes(body.platform as ServerPlatform)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      const result = await setServerToken(store.statsId, body.platform as ServerPlatform, body.token, { account: body.account });
      if (result === "invalid") return Response.json({ ok: false, error: "token" }, { status: 400 });
      if (result === "account") return Response.json({ ok: false, error: "account" }, { status: 400 });
    } else if ("testCode" in body) {
      if (!(await setTestCode(store.statsId, body.testCode))) return Response.json({ ok: false, error: "code" }, { status: 400 });
    } else {
      return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    const setup = await serverSetup(store.statsId);
    await setAdsServer(guarded.ref, platformsOn(setup));
    return Response.json({ ok: true, setup }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnknownReplyError) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    console.error("changing server-sent conversions failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
