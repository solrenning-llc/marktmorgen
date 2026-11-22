import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { MANAGE_TOKEN_PATTERN, grantOf } from "@/lib/membership-manage";
import { offers } from "@/lib/leave-rules";
import { countLeave, saidField } from "@/lib/leave-flow";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;

/**
 * The reason a member gives on the page before cancelling (lib/leave-rules.ts):
 * counted once, then back to the same page, which answers it. Guarded as the
 * page's other buttons are, and only a live link of this store is counted.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

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
    why = read("why").slice(0, 40);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  if (!MANAGE_TOKEN_PATTERN.test(token) || !SUB_PATTERN.test(subscription)) {
    return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/manage?status=expired`, "Cache-Control": "no-store" } });
  }

  const page = new URLSearchParams({ token, sub: subscription });
  if (offers(store.leaving, why)) {
    page.set("why", why);
    // A count that could not be read (unknown, rule 24) counts nothing, as past the limit does; the page is the same.
    if ((await withinStore("manage-leave", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer").catch(unknownLimit)) === true && (await grantOf(store, token))) {
      await countLeave(store.statsId, saidField(why));
    }
  }
  return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/manage/leave?${page}`, "Cache-Control": "no-store" } });
}
