import { withinStore } from "@/lib/metered-limits";
import { type DigitalConsent, consentFromForm } from "@/lib/digital-consent";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { openMove } from "@/lib/move-members";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * "Keep my membership": the button on the page a moved member's link opens
 * (lib/move-members.ts). A button, never the link itself, so a mail scanner
 * opening the email starts no checkout.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let handle = "";
  let product = "";
  let token = "";
  // The box to start access at once (lib/digital-consent.ts), checked again where the charge is built.
  let consent: DigitalConsent | null = null;
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    consent = consentFromForm(form);
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    product = String(form.get("product") ?? "").slice(0, 64);
    token = String(form.get("k") ?? "").slice(0, 80);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || !/^[A-Za-z0-9_-]{1,64}$/.test(product)) return new Response("Not found.", { status: 404 });

  const page = `${origin}/@${store.handle}/move/${product}`;
  const back = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${page}?k=${encodeURIComponent(token)}&status=${status}`, "Cache-Control": "no-store" } });
  const room = await withinStore("move-open", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer").catch(unknownLimit);
  if (room === "unknown") return back("refused");
  if (!room) return back("limited");
  const opened = await openMove(store, product, token, linkOrigin(request, store), Date.now(), consent);
  if (!opened.ok) return back(opened.reason);
  return new Response(null, { status: 303, headers: { Location: opened.url, "Cache-Control": "no-store" } });
}
