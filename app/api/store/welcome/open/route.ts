import { withinStore } from "@/lib/metered-limits";
import { type DigitalConsent, consentFromForm } from "@/lib/digital-consent";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { openWelcome } from "@/lib/welcome-offer-send";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * The welcome offer's button on the page a free copy is picked up from
 * (lib/welcome-offer-send.ts). A button, never the link itself, so a mail
 * scanner opening the email starts no checkout.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let handle = "";
  let token = "";
  // The box to start access at once (lib/digital-consent.ts), checked again where the charge is built.
  let consent: DigitalConsent | null = null;
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    consent = consentFromForm(form);
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    token = String(form.get("token") ?? "").slice(0, 80);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("Not found.", { status: 404 });

  const back = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/free?token=${encodeURIComponent(token)}&welcome=${status}`, "Cache-Control": "no-store" } });
  const room = await withinStore("welcome-open", `${clientAddress(request)}|${store.handle}`, 20, 600, store).catch(unknownLimit);
  if (room === "unknown") return back("refused");
  if (!room) return back("limited");
  const opened = await openWelcome(store, token, linkOrigin(request, store), Math.floor(Date.now() / 1000), consent);
  if (!opened.ok) return back(opened.reason);
  return new Response(null, { status: 303, headers: { Location: opened.url, "Cache-Control": "no-store" } });
}
