import { withinStore } from "@/lib/metered-limits";
import { channelOfRequest } from "@/lib/visit-channel";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";
import { createTipCheckout, tipsOpen } from "@/lib/store-tip-checkout";
import { readTipAmount, tipAmounts } from "@/lib/store-tips";

/**
 * "Support my work" on a store page (lib/store-tips.ts): a plain form, so it
 * works without JavaScript. Each of the creator's amounts is a button of its
 * own (`amount`, in the currency's smallest unit, and only one the box
 * offers); the box beside them takes another (`other`, as typed). The answer
 * is Stripe's page, or the store page saying what was wrong.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let picked = "";
  let other = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    const read = (name: string, max: number) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, max) : "";
    };
    handle = normaliseHandle(read("handle", 100));
    picked = read("amount", 12);
    other = read("other", 20);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const away = (problem: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}?tip=${problem}#support`, "Cache-Control": "no-store" } });
  if (!tipsOpen(store)) return away("closed");

  // A button's amount is taken only when the box offers it; anything else typed is read and held to the range.
  const offered = tipAmounts(store.tips, store.currency);
  const amount = /^\d{1,9}$/.test(picked) && offered.includes(Number(picked)) ? Number(picked) : picked ? null : readTipAmount(other, store.currency);
  if (amount === null) return away("amount");

  // Twenty a connection in ten minutes per store: far past any fan, short of a script trying cards.
  const room = await withinStore("tip", `${clientAddress(request)}|${store.handle}`, 20, 600, store).catch(unknownLimit);
  if (room === "unknown") return away("error");
  if (!room) return away("limited");
  try {
    const opened = await createTipCheckout(
      store,
      linkOrigin(request, store),
      amount,
      channelOfRequest(request, store.handle, new URL(origin).hostname, Date.now() / 1000, store.attributionDays),
    );
    return new Response(null, { status: 303, headers: { Location: opened.url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("opening a support checkout failed", error);
    return away("error");
  }
}
