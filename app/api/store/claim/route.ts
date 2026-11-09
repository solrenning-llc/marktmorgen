import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import {
  MAX_BIO_LENGTH,
  MAX_NAME_LENGTH,
  claimHandle,
  createStore,
} from "@/lib/store";
import { storeCookie } from "@/lib/studio-route";
import { isRedisConfigured } from "@/lib/redis";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { isAutomated } from "@/lib/bot-check";
import { recordInvite } from "@/lib/creator-invites";
import { INVITE_COOKIE, INVITE_CODE_PATTERN } from "@/lib/creator-invite-rules";

const MAX_BODY_BYTES = 2_000;

/**
 * Takes a handle for the signed-in creator and creates a store under it: their
 * first, or — with `another: true` — one more of the five an account may run
 * (lib/store.ts). A store is always its owner's own: this makes a store for
 * the person signed in, whatever store their studio has open.
 *
 * The new store becomes the one the studio opens next.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "invalid" }, { status: 413 });
  }

  const email = await emailForSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!email) {
    return Response.json({ ok: false, error: "signed_out" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, MAX_BODY_BYTES)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  const handle = typeof body.handle === "string" ? body.handle : "";
  const name =
    typeof body.name === "string" ? body.name.slice(0, MAX_NAME_LENGTH) : "";
  const bio =
    typeof body.bio === "string" ? body.bio.slice(0, MAX_BIO_LENGTH) : "";

  if (!isRedisConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  // Made only for a request the host does not call a program's (TODOS-51 C, lib/bot-check.ts): before anything is
  // written. A host that is slow, down or unclear refuses nobody; the five stores an account may run still bound it.
  if (await isAutomated()) return Response.json({ ok: false, error: "unconfirmed" }, { status: 403 });

  try {
    const result =
      body.another === true ? await createStore(email, handle, name, bio) : await claimHandle(email, handle, name, bio);
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason, limit: "limit" in result ? result.limit : undefined },
        { status: result.reason === "already" || result.reason === "too_many" ? 409 : 400 },
      );
    }
    // An invite accepted before signing up (lib/creator-invites.ts) counts for
    // an account's first store only. Never in the way of the store itself:
    // whatever happens here, the store is made and the creator goes on.
    const invite = request.cookies.get(INVITE_COOKIE)?.value ?? "";
    let invited = false;
    if (body.another !== true && INVITE_CODE_PATTERN.test(invite)) {
      invited = await recordInvite(result.store, invite).then(
        (r) => r === "recorded",
        (error) => {
          console.error("writing down an invite failed", error);
          return false;
        },
      );
    }
    const response = Response.json({ ok: true, handle: result.store.handle, store: result.store.sid, invited });
    response.headers.append("Set-Cookie", storeCookie(result.store.sid, request));
    if (invite) response.headers.append("Set-Cookie", `${INVITE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
    return response;
  } catch (error) {
    console.error("claiming a handle failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
