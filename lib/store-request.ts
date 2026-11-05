import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import type { Store } from "@/lib/store";
import { type Role, isPermission } from "@/lib/team-roles";
import { type Need, refusedJson, studioAccess } from "@/lib/studio-route";

/**
 * The checks every write to a store has to pass, in one place.
 *
 * They run in this order on purpose. The origin check comes first because it
 * costs nothing and stops another site from spending a signed-in creator's
 * session. The size cap comes before the body is read, so a large payload is
 * refused rather than parsed. The session comes before the body is trusted.
 * Redis is checked last among the four, because a store that cannot be
 * written is a fact about us and should not be reported as a fault in what
 * was sent.
 *
 * Then the store and the role (lib/studio-route.ts): which store the studio
 * page that sent this was drawn for, and whether the person's role there has
 * `need`. A route with several actions that need different things passes a
 * function of the body, and its answer is what is checked.
 *
 * The action checked against what a session let in without its second step
 * may not do (lib/two-step.ts LOCKED_ACTIONS) is the body's `action`, or what
 * `act` answers for a route whose deleting write is named another way (an
 * `op`, a `detach: true`).
 *
 * `units` is how many of the studio's requests this one is counted as, by
 * its body (one when not given): taken in the same step as the first, before
 * anything else is read (app/api/store/crm/route.ts, a field saved).
 *
 * Returns a Response to send back, or who is asking, the store, the key it is
 * kept under, their role and the parsed body.
 */
export async function guardStoreWrite(
  request: NextRequest,
  need: Need | ((body: Record<string, unknown>) => Need | null),
  maxBodyBytes = 4_000,
  act?: (body: Record<string, unknown>) => string,
  units?: (body: Record<string, unknown>) => number,
): Promise<
  | { ok: true; email: string; ref: string; store: Store; role: Role; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const refuse = (error: string, status: number) => ({
    ok: false as const,
    response: Response.json({ ok: false, error }, { status }),
  });

  if (fromAnotherSite(request)) return refuse("forbidden", 403);

  if (Number(request.headers.get("content-length") ?? "0") > maxBodyBytes) {
    return refuse("invalid", 413);
  }

  const email = await emailForSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!email) return refuse("signed_out", 401);

  let body: Record<string, unknown>;
  try {
    // Counted as it arrives: a body sent without a length stops at the cap.
    const parsed: unknown = await (await limited(request, maxBodyBytes)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return refuse("invalid", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse("invalid", 400);
  }

  if (!isRedisConfigured()) return refuse("unavailable", 503);

  const permission = typeof need === "function" ? need(body) : need;
  // Only a permission the table knows, or "member": an action name that found
  // something on an object's prototype ("constructor") is not one.
  if (!permission || (permission !== "member" && !isPermission(permission))) return refuse("invalid", 400);
  const action = act ? act(body).slice(0, 40) : typeof body.action === "string" ? body.action.slice(0, 20) : "";
  const result = await studioAccess(request, permission, action, units ? units(body) : 1);
  if (!result.ok) return { ok: false, response: refusedJson(result.reason, result.message) };
  const { access } = result;

  return { ok: true, email: access.email, ref: access.ref, store: access.store, role: access.role, body };
}

/** A field read as text, or an empty string when it is anything else. */
export function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
