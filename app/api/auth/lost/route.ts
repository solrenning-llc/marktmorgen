import { type NextRequest, after } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { clientIp } from "@/lib/visit";
import { sendLostEmailLink } from "@/lib/recovery-address";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH } from "@/lib/auth";
import { serviceMailKnownUnavailable } from "@/lib/email";

/**
 * /signin/lost's form (lib/recovery-address.ts): a link to the recovery
 * address of the account that logs in with the address typed. The answer is
 * the same whether or not there is one, so it says nothing about who has an account.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let email = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    const value = form.get("email");
    email = typeof value === "string" ? value.slice(0, 300) : "";
  } catch {
    email = "";
  }
  // Check only a global, synchronous lack of a sending route before any
  // recipient-dependent recovery lookup. Both known and unknown addresses
  // receive the same answer; no quota or readiness is inferred otherwise.
  const address = email.trim();
  if (address && address.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(address) && serviceMailKnownUnavailable()) {
    return new Response(null, { status: 303, headers: { Location: `${origin}/signin/lost?status=unavailable`, "Cache-Control": "no-store" } });
  }
  // The link and the notice go after the answer (security audit 506 [SG1], MM-SA-21): awaited here, an address with a
  // recovery address (a link written, two emails) answered later than one without (a few reads), and the time told
  // which sign-in addresses have an account with one. The answer is now the same, at the same moment, for both.
  const ip = clientIp(request);
  const linkFrom = linkOrigin(request);
  after(async () => {
    try {
      await sendLostEmailLink(email, ip, linkFrom);
    } catch {
      console.error("sending a recovery-address link failed");
    }
  });
  return new Response(null, { status: 303, headers: { Location: `${origin}/signin/lost?status=sent`, "Cache-Control": "no-store" } });
}
