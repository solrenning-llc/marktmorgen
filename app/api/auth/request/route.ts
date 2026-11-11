import type { NextRequest } from "next/server";
import { linkOrigin } from "@/lib/request-origin";
import { prefillHandle } from "@/lib/handle-prefill";
import {
  EMAIL_PATTERN,
  MAX_EMAIL_LENGTH,
  isAuthConfigured,
  addressLimitAnswer,
  rateLimitAnswer,
  sendSignInLink,
  unusedSignInRequest,
} from "@/lib/auth";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { isAutomated } from "@/lib/bot-check";
import { serviceMailKnownUnavailable } from "@/lib/email";
import { isHouseAddress } from "@/lib/house-store";

const MAX_BODY_BYTES = 2_000;

/**
 * Asks for a sign-in link.
 *
 * The answer never says whether that address has an account, because that
 * would turn this form into a way of finding out who is a Marktmorgen creator.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "invalid" }, { status: 413 });
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

  // Honeypot: a real creator never sees this field.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    // The same answer as a real request's, with an id that opens nothing (652 [WG12]): a program cannot tell them apart.
    return Response.json({ ok: true, request: unusedSignInRequest() }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  if (!isAuthConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  try {
    // Past the limit is "too many tries"; a count that could not be read is our side's trouble, said as such
    // (CX-123 rules 24 and 27): nothing is sent either way.
    const machine = await rateLimitAnswer(ip);
    if (machine === "unknown") return Response.json({ ok: false, error: "server_error" }, { status: 503 });
    if (machine === "over") {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    // A program typing other people's addresses into this form would send
    // each of them an email nobody asked for (lib/bot-check.ts). It is told
    // so plainly, whatever the address: the answer depends on the browser
    // alone, so it says nothing about who has an account.
    if (await isAutomated()) {
      console.warn("sign-in refused: the browser could not be confirmed");
      return Response.json({ ok: false, error: "unconfirmed" }, { status: 403 });
    }
    // The counter above bounds one machine. This one bounds one inbox, so a
    // flood sent from many machines cannot bury a creator in sign-in emails.
    const inbox = await addressLimitAnswer(email);
    if (inbox === "unknown") return Response.json({ ok: false, error: "server_error" }, { status: 503 });
    if (inbox === "over") {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    // The link always points at this site, whatever host the request named.
    // A store address typed on the home page goes into the link only when it
    // is a valid one (lib/handle-prefill.ts); it is checked again there.
    // This global fact says nothing about whether an address has an account,
    // and refuses before minting a token. It performs no provider/Redis IO.
    if (serviceMailKnownUnavailable()) {
      return Response.json({ ok: false, error: "server_error" }, { status: 503 });
    }
    const asked = await sendSignInLink(email, linkOrigin(request), prefillHandle(body.handle));
    // Sign-in mail is attempted equally for existing and unknown addresses.
    // The public demo owner is deliberately ignored by sendSignInLink and
    // retains its neutral response; no creator lookup is introduced here.
    if (!asked.sent && !isHouseAddress(email)) {
      return Response.json({ ok: false, error: "server_error" }, { status: 503 });
    }
    // The request's id, for the code in the email (652 [WG12]): given to this browser for every address alike.
    return Response.json({ ok: true, request: asked.request }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Provider and storage errors can include the address or sign-in material; keep logs data-free.
    console.error("sign-in request failed");
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
