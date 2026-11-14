import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { isOperator } from "@/lib/search-console";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { resetVisits } from "@/lib/traffic-reset";

/**
 * Lowers a store's visits in its current window (lib/traffic-reset.ts), for
 * the person who runs the site only: `{ "handle": "shop", "visits": 1200 }`.
 * Anybody else is answered as if this did not exist. It lowers visits only;
 * a store's requests are never given back here.
 */
export async function POST(request: NextRequest) {
  const notFound = new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (fromAnotherSite(request)) return notFound;
  const email = await emailForSession(request.cookies.get(SESSION_COOKIE)?.value ?? "").catch(() => null);
  if (!isOperator(email)) return notFound;
  const body = (await limited(request, 1_000)
    .then((r) => r.json())
    .catch(() => null)) as { handle?: unknown; visits?: unknown } | null;
  const handle = typeof body?.handle === "string" ? normaliseHandle(body.handle) : "";
  const visits = typeof body?.visits === "number" ? body.visits : Number.NaN;
  const answer = (status: number, value: unknown) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (!handle) return answer(400, { ok: false, reason: "invalid" });
  const store = await storeForHandle(handle).catch(() => null);
  if (!store) return answer(404, { ok: false, reason: "no-store" });
  const result = await resetVisits({ store, to: visits }).catch(() => ({ ok: false, reason: "unknown" }) as const);
  return answer(result.ok ? 200 : result.reason === "unknown" || result.reason === "busy" ? 503 : 409, result);
}
