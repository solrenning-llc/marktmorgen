import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { affiliateCookieName, affiliateForSession, answerShareChange, sharePromiseProblem } from "@/lib/affiliates";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/**
 * A signed-in partner answering a change to their share that the store asked
 * for (630 [HN6](39); lib/affiliates.ts answerShareChange): yes applies it
 * after the cap is checked again with what the products promise today; no
 * keeps the share in force. Nothing already earned moves either way.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let answer = "";
  let seen = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    answer = read("answer");
    // Which change the partner read (lib/affiliates.ts changeIdentity): the answer applies to that one only.
    seen = read("change").slice(0, 64);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (answer !== "yes" && answer !== "no") return new Response("Bad request", { status: 400 });
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const back = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/affiliates?status=${status}#partner`, "Cache-Control": "no-store" } });
  const affiliate = await affiliateForSession(store, request.cookies.get(affiliateCookieName(store.handle))?.value);
  if (!affiliate) return back("signedout");
  if (!(await withinStore("aff-partner", `${store.handle}|${affiliate.id}`, 5, 3600, store))) return back("payto-slow");
  const now = Math.floor(Date.now() / 1000);
  const result = await answerShareChange(store, affiliate.id, answer === "yes", seen, now, async (share) => (await sharePromiseProblem(store, affiliate.id, share, now)) === null);
  return back(result.ok ? `partner-${result.state === "changed" ? "yes" : "no"}` : `partner-${result.reason}`);
}
