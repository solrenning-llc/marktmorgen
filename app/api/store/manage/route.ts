import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { requestManageLink } from "@/lib/membership-manage";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";

const MAX_BODY_BYTES = 2_000;

/**
 * A member asks for the way in to their membership.
 *
 * A plain HTML form, so it works with JavaScript turned off. The answer is
 * always the same page, whether or not the address has a membership here,
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

  const page = `/@${store.handle}/manage`;
  // A field no person can see. Whatever filled it in is told it worked.
  if (honeypot.trim()) return away(`${page}?status=sent`);

  const ip = clientAddress(request);

  try {
    const result = await requestManageLink({ store, email, ip, origin: linkOrigin(request, store) });
    return away(`${page}?status=${result}`);
  } catch (error) {
    console.error("sending a membership link failed", error);
    return away(`${page}?status=error`);
  }
}
