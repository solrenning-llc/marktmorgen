import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { type Charge, StudioNotPaidError, affiliateCookieName, affiliateForSession, answerShareChange, partnerShareProblem } from "@/lib/affiliates";
import { forcePublicRequests, givePublicRequests, holdPublicRequests } from "@/lib/traffic";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { LockBusyError } from "@/lib/redis-lock";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * A signed-in partner answering a change to their share that the store asked
 * for (630 [HN6](39); lib/affiliates.ts answerShareChange): yes applies it
 * after the cap is checked again, under the program's partner lock, with what
 * the products promise today; no keeps the share in force. Nothing already
 * earned moves either way.
 *
 * "partner-busy": the store was changing this partner, or held the partner
 * lock past our wait: nothing was written. "partner-unsure": a reply could
 * not be read, so the answer may or may not have been saved; the page shows
 * what stands, never "nothing changed" (review of #1924).
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
  // A yes reads the program's people for the 90% cap: paid from the store's public requests first, at the read's
  // worst, as an opened invitation's is (app/api/store/affiliates/open), and given back down to what was read
  // (lib/affiliates.ts paidPeople). Not taken: "resting", nothing read or written.
  const charge: Charge = async (units) => {
    const at = Date.now();
    if (!(await holdPublicRequests(store, units, at))) return null;
    return {
      give: async (n) => {
        if (Number.isSafeInteger(n) && n > 0 && n <= units) await givePublicRequests(store, n, at);
      },
      force: (n) => forcePublicRequests(store, n, at),
    };
  };
  try {
    const result = await answerShareChange(store, affiliate.id, answer === "yes", seen, now, async (share) => (await partnerShareProblem(store, share, affiliate.id, charge, now)) === null);
    return back(result.ok ? `partner-${result.state === "changed" ? "yes" : "no"}` : `partner-${result.reason}`);
  } catch (error) {
    // Nothing was written: the store changed this partner meanwhile, or held the partner lock past our wait.
    if (error instanceof LockBusyError) return back("partner-busy");
    // The public requests the cap read needs were not taken: nothing read or written.
    if (error instanceof StudioNotPaidError) return back("resting");
    // A reply that could not be read: the answer may have landed. Said as such, never "nothing changed".
    if (error instanceof UnknownReplyError) {
      console.error("a partner's answer stopped on an unknown reply", error);
      return back("partner-unsure");
    }
    throw error;
  }
}
