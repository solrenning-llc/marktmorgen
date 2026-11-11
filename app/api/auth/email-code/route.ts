import type { NextRequest } from "next/server";
import { codeRateAnswer, takeSignInCode } from "@/lib/auth";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";

/**
 * The six-digit code from the login email (652 [WG12]), typed on the page
 * that asked for it: for when the email was opened on another device.
 *
 * It opens exactly what the link opens, through the same finish (two-step
 * login included, lib/signin-finish.ts), and spends the link with it. The
 * answer is JSON so the page keeps what was typed when a code is wrong
 * (AX274 2.2.5); a right code answers where to go, with the cookies the
 * finish set.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, 2_000)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  const ip = clientAddress(request);
  let answer: Awaited<ReturnType<typeof takeSignInCode>>;
  try {
    // The machine's tries, counted before any record is read (Claude 3 on #2736): past them, nothing is read.
    const machine = await codeRateAnswer(ip);
    if (machine === "unknown") return Response.json({ ok: false, error: "server_error" }, { status: 503 });
    if (machine === "over") return Response.json({ ok: false, error: "code_rate_limited" }, { status: 429 });
    answer = await takeSignInCode(body.request, body.code);
  } catch (error) {
    console.error("a login code could not be checked");
    answer = "unknown";
  }
  if (answer === "unknown") return Response.json({ ok: false, error: "server_error" }, { status: 503 });
  if (answer === "invalid") return Response.json({ ok: false, error: "code_shape" }, { status: 400 });
  if (answer === "expired") return Response.json({ ok: false, error: "code_expired" }, { status: 410 });
  if (answer === "blocked") return Response.json({ ok: false, error: "code_blocked" }, { status: 429 });
  if (answer === "address-blocked") return Response.json({ ok: false, error: "code_address_blocked" }, { status: 429 });
  if ("wrong" in answer) return Response.json({ ok: false, error: "code_wrong", left: answer.wrong }, { status: 400 });

  // The same finish as the link's, then its answer said in JSON: where to go, with its cookies.
  const finished = await finishProvenSignIn(request, answer.owner, "code", "/studio");
  const location = finished.headers.get("location") ?? "";
  const next = location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location;
  const response = Response.json({ ok: true, next: next || "/studio" }, { status: 200, headers: { "Cache-Control": "no-store" } });
  for (const cookie of finished.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
  return response;
}
