import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { ACCOUNT_NAMES, IncompleteForget, forgetUser } from "@/lib/meet-connect";
import { isConfigured, zoomClientId, zoomSigned, zoomValidation } from "@/lib/meet-providers";
import { clientAddress, limited, withinLimit, unknownLimit } from "@/lib/request-guard";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";

/** Zoom's notices are small; anything bigger is not one. */
const MAX_BODY_BYTES = 64_000;
/** Notices one address may send in a minute. */
const PER_MINUTE = 120;

/**
 * Zoom's notices to the app, at the address set on it as its
 * deauthorization and event notification endpoint.
 *
 * Every notice must carry Zoom's signature (x-zm-signature: HMAC-SHA256 of
 * "v0:<x-zm-request-timestamp>:<body>" under ZOOM_WEBHOOK_SECRET_TOKEN)
 * from the last five minutes, or it is refused, the address check included,
 * so this address never signs anything for anybody else. Each signed notice
 * is acted on once: its signature is kept for ten minutes, longer than the
 * five it is accepted for, and the same one again is acknowledged and
 * ignored — so a notice captured and sent again cannot, say, disconnect an
 * account the creator connected again a minute after removing the app.
 *
 *   endpoint.url_validation   Zoom checking the address: answered with the
 *                             plain token and its HMAC, as Zoom asks.
 *   app_deauthorized          a Zoom user removed the app: every store that
 *                             user connected forgets the connection and its
 *                             tokens at once, and its owner is told.
 *
 * Anything else is acknowledged and ignored.
 */
export async function POST(request: NextRequest) {
  if (!isConfigured("zoom")) return new Response("Not found.", { status: 404 });
  const room = await withinLimit("zoom-notice", clientAddress(request), PER_MINUTE, 60).catch(unknownLimit);
  // A count that could not be read is unknown (rule 24): 503, so the notice is sent again, never "too many".
  if (room === "unknown") return Response.json({ ok: false }, { status: 503 });
  if (!room) {
    return Response.json({ ok: false }, { status: 429 });
  }
  let body: string;
  try {
    body = await (await limited(request, MAX_BODY_BYTES)).text();
  } catch {
    return Response.json({ ok: false }, { status: 413 });
  }
  if (!zoomSigned(body, request.headers.get("x-zm-request-timestamp"), request.headers.get("x-zm-signature"))) {
    return Response.json({ ok: false }, { status: 401 });
  }
  // Once only (see above). A notice we failed to act on is let go of again,
  // so Zoom's retry of it is heard. Read exactly (CX-123 rule 24): a mark
  // that cannot be read, the database not answering included, acts on
  // nothing and is not answered with a success, so Zoom tries again; a mark
  // this request may have written is let go first, only while it is ours.
  const seenKey = `nl:meet:zoomseen:${(request.headers.get("x-zm-signature") ?? "").slice(3, 67)}`;
  const mine = claimValue();
  const fresh = await claimMark(seenKey, 600, mine);
  if (fresh === "taken") return Response.json({ ok: true });
  if (fresh === "unknown") {
    await releaseMark(seenKey, mine);
    return Response.json({ ok: false }, { status: 503 });
  }
  let notice: { event?: unknown; payload?: Record<string, unknown> };
  try {
    notice = JSON.parse(body) as typeof notice;
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const payload = notice.payload ?? {};

  if (notice.event === "endpoint.url_validation") {
    const plain = typeof payload.plainToken === "string" ? payload.plainToken : "";
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(plain)) return Response.json({ ok: false }, { status: 400 });
    return Response.json(zoomValidation(plain));
  }

  if (notice.event === "app_deauthorized") {
    const user = typeof payload.user_id === "string" ? payload.user_id : "";
    const client = typeof payload.client_id === "string" ? payload.client_id : "";
    if (!user || (client && client !== zoomClientId())) return Response.json({ ok: true });
    const tell = (forgot: Awaited<ReturnType<typeof forgetUser>>) => {
      for (const one of forgot) {
        if (!one.owner.email) continue;
        after(() =>
          noticeCreator(
            { email: one.owner.email, handle: one.owner.handle },
            { kind: "meeting-disconnected", name: ACCOUNT_NAMES.zoom, account: one.account, byProvider: true },
          ),
        );
      }
    };
    try {
      tell(await forgetUser("zoom", user));
      return Response.json({ ok: true });
    } catch (error) {
      console.error("forgetting a Zoom user failed", error);
      // The stores this pass did forget are told now: the next pass reads them as gone (Claude 5 on #2869).
      if (error instanceof IncompleteForget) tell(error.forgot);
      // Zoom tries again when it is not answered with a success.
      // Only while it is still ours: a mark that ran out and was taken by another request is that one's.
      await releaseMark(seenKey, mine);
      return Response.json({ ok: false }, { status: 500 });
    }
  }
  return Response.json({ ok: true });
}
