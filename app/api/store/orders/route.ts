import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { requestOrdersLink } from "@/lib/buyer-orders";
import { fromAnotherSite, limited } from "@/lib/request-guard";

const MAX_BODY_BYTES = 2_000;

// The longest one request may run (lib/buyer-orders.ts, ORDERS_OPEN_SECONDS): what bounds every call to Stripe it waits on,
// as for an opening of the list, whose ORDERS_OPEN_UNITS it takes.
export const maxDuration = 30;

const tooMany = () => new Response("Please try again later.", { status: 429 });

/**
 * A buyer asks for what they bought from this store, sent to their inbox.
 *
 * A plain HTML form, so it works with JavaScript turned off. The answer is
 * always the same page, whether or not the address bought anything here,
 * and the address typed never appears in the URL it leads to.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);

  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response("Too large", { status: 413 });
  }

  const away = (path: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" },
    });

  let handle = "";
  let email = "";
  let honeypot = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    email = read("email").slice(0, 300);
    honeypot = read("website");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  // One of the store's public requests for its window (lib/traffic.ts).
  if (!(await takePublicRequest(store, "buyer"))) return tooMany();

  const page = `/@${store.handle}/orders`;
  // A field no person can see. Whatever filled it in is told it worked.
  if (honeypot.trim()) return away(`${page}?status=sent`);

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  try {
    const result = await requestOrdersLink({ store, email, ip, origin: linkOrigin(request, store) });
    // The store had no room for what the address's purchases take to read (lib/buyer-orders.ts): nothing was read.
    if (result === "busy") return tooMany();
    return away(`${page}?status=${result}`);
  } catch (error) {
    // Said only in the log: the answer must not differ between an address that bought and one that did not.
    console.error("sending a purchases link failed", error);
    return away(`${page}?status=sent`);
  }
}
