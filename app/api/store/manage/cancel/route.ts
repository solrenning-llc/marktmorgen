import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { MANAGE_TOKEN_PATTERN, admitManage, openCancel } from "@/lib/membership-manage";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * The Cancel button beside one membership, on the page the emailed link
 * opens. It opens Stripe's own cancellation page for that membership, with the
 * creator's offer the first time it can be made (lib/membership-manage.ts).
 *
 * Guarded exactly as the button beside it is (./../open/route.ts): refused from
 * another site, read with a size limit, and counted per connection. Only a
 * press does anything; the page it sits on never does.
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
  let why = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    token = read("token").slice(0, 80);
    subscription = read("subscription").slice(0, 80);
    // The reason given on the page before, if any (lib/leave-rules.ts).
    why = read("why").slice(0, 40);
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
        // Back to the list the member came from while the link still works,
        // so a failure is one press from trying again rather than a new email.
        Location: `${origin}/@${store.handle}/manage?status=${status}${MANAGE_TOKEN_PATTERN.test(token) ? `&token=${token}` : ""}`,
        "Cache-Control": "no-store",
      },
    });

  if (!MANAGE_TOKEN_PATTERN.test(token)) return back("expired");
  // The way out is essential: the link is read before anything of the store's is spent, and the store's month
  // counts it but never refuses it (lib/membership-manage.ts admitManage, lib/essential-exit.ts).
  const admitted = await admitManage(store, token, clientAddress(request));
  if (!admitted.ok) return back(admitted.reason);

  const result = await openCancel(store, token, subscription, linkOrigin(request, store), why);
  if (!result.ok) return back(result.reason);
  return new Response(null, {
    status: 303,
    headers: { Location: result.url, "Cache-Control": "no-store" },
  });
}
