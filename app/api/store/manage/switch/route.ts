import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { countLeave } from "@/lib/leave-flow";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { MANAGE_TOKEN_PATTERN, linkIsLive } from "@/lib/membership-manage";
import { switchTier } from "@/lib/tier-switch";
import { YEARLY_TARGET, switchYearly } from "@/lib/yearly-switch";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { type DigitalConsent, consentFromForm } from "@/lib/digital-consent";

const MAX_BODY_BYTES = 1_000;

/**
 * The "Switch now" button on the page that showed what a switch costs
 * (app/[handle]/manage/switch). Only this changes anything, at the second
 * that page's figure was worked out for (lib/tier-switch.ts). Guarded as the
 * other buttons on the member's page are.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response("Too large", { status: 413 });
  }

  let handle = "";
  let token = "";
  let subscription = "";
  let target = "";
  let at = NaN;
  let fromLeave = false;
  let fromOffer = false;
  // The EU box asked again before a switch charges (91 [D2-EU-WITHDRAWAL]): only the checked box with today's words.
  let consent: DigitalConsent | null = null;
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    token = read("token").slice(0, 80);
    subscription = read("sub").slice(0, 80);
    target = read("to").slice(0, 40);
    fromLeave = read("from") === "leave";
    fromOffer = read("from") === "offer";
    consent = consentFromForm(form);
    at = /^\d{9,11}$/.test(read("at")) ? Number(read("at")) : NaN;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });

  const back = (status: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${origin}/@${store.handle}/manage?status=${status}${MANAGE_TOKEN_PATTERN.test(token) ? `&token=${token}` : ""}`,
        "Cache-Control": "no-store",
      },
    });

  // The box was not checked: back to the same switch, whose box then says what is missing. Nothing was charged.
  const askAgain = () => {
    const query = new URLSearchParams({ token, sub: subscription, to: target, consent: "needed" });
    if (fromLeave) query.set("from", "leave");
    if (fromOffer) query.set("from", "offer");
    return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/manage/switch?${query}`, "Cache-Control": "no-store" } });
  };

  if (!MANAGE_TOKEN_PATTERN.test(token)) return back("expired");
  if (!(await withinStore("tier-switch", `${clientAddress(request)}|${store.handle}`, 10, 600, store, "buyer"))) return back("limited");

  // The same membership, paid yearly (lib/yearly-switch.ts). From the emailed
  // link, which opens nothing else, the member comes back to the page that
  // asks for their address, with the result said there.
  if (target === YEARLY_TARGET) {
    const yearly = await switchYearly(store, token, subscription, at, consent);
    if (!yearly.ok && yearly.reason === "consent") return askAgain();
    const status = yearly.ok ? "yearly" : yearly.reason === "gone" || yearly.reason === "yearly" ? "cannot-switch" : yearly.reason === "freeDays" ? "free-days" : yearly.reason;
    if (await linkIsLive(token)) return back(status);
    return new Response(null, {
      status: 303,
      headers: { Location: `${origin}/@${store.handle}/manage?status=${status === "expired" ? "offer-expired" : status}`, "Cache-Control": "no-store" },
    });
  }

  const result = await switchTier(store, token, subscription, target, at, consent);
  if (!result.ok && result.reason === "consent") return askAgain();
  // Switched instead of leaving, from the page that asked why (lib/leave-flow.ts).
  if (result.ok && fromLeave && store.leaving.on) await countLeave(store.statsId, "switched");
  // Paid free days running: said as such on the membership page (lib/tier-switch.ts).
  return back(result.ok ? "switched" : result.reason === "gone" || result.reason === "tier" ? "cannot-switch" : result.reason === "freeDays" ? "free-days" : result.reason);
}
