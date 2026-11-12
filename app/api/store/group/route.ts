import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, essentialLimitState, fromAnotherSite, limited } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";
import { askPlace, readGroup } from "@/lib/group-buy";
import { GROUP_ID } from "@/lib/group-rules";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { canConfirm, fromStore, storeBase } from "@/lib/purchase-email";

const MAX_BODY_BYTES = 2_000;

/**
 * Somebody asks for a place in a purchase made for several people
 * (lib/group-buy.ts): a plain form on the page its link opens. The address
 * typed is sent one email with the link that takes the place; nothing is
 * taken here. The answer is always that page, and the address never goes in
 * its URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let id = "";
  let email = "";
  let honeypot = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    id = read("group").slice(0, 40);
    email = read("email").slice(0, 300);
    honeypot = read("website");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || !GROUP_ID.test(id)) return new Response("No such page.", { status: 404 });
  const away = (status: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}/@${store.handle}/group/${id}?status=${status}`, "Cache-Control": "no-store" },
    });
  // A form filled in by something that fills in every field is told it worked.
  if (honeypot.trim()) return away("sent");
  // Each press may send an email, so it is counted like the other forms that
  // send one: per connection and purchase here, per purchase in askPlace.
  // Past it, "slow"; a count that cannot be read is "unavailable", never "slow down" (rule 24).
  const tries = await essentialLimitState("group-place", `${clientAddress(request)}|${id}`, 10, 600);
  if (tries !== "within") return away(tries === "exceeded" ? "slow" : "unavailable");
  if (!canConfirm(store)) return away("unavailable");
  try {
    const group = await readGroup(id);
    const product = group ? await readListing(store, group.p) : null;
    if (!product) return away("gone");
    const base = storeBase(store);
    return away(
      await askPlace({ store, id, email, product, base, from: fromStore(store), ordersLink: (address) => ordersLinkFor(store, address, base) }),
    );
  } catch (error) {
    console.error("asking for a place failed", error);
    return away("unavailable");
  }
}
