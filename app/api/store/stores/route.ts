import type { NextRequest } from "next/server";
import { forgetCrm } from "@/lib/crm";
import { forgetRecentSales } from "@/lib/recent-sales";
import { forgetStoreReadings } from "@/lib/store-readings";
import { away, creatorFrom, storeCookie } from "@/lib/studio-route";
import { limited } from "@/lib/request-guard";
import { forgetStoreWorkflows } from "@/lib/flows";
import { deleteStore } from "@/lib/store";
import { queueDeleted } from "@/lib/closed-store-data";
import { dropTeam } from "@/lib/team";
import { forgetStoreSync } from "@/lib/email-sync";
import { forgetStorePhones } from "@/lib/phone-alerts";
import { forgetPersonNotes } from "@/lib/buyer-profile";
import { forgetStoreWebhooks } from "@/lib/webhooks";
import { revokeAllKeys } from "@/lib/api-keys";
import { endLapsed, findStoreSubscriptions, isBillingConfigured } from "@/lib/billing";
import { forgetPath } from "@/lib/path";
import { queueStoreForget } from "@/lib/store-forget-retry";
import { forgetStoreCalendar } from "@/lib/calendar-sync";
import { forgetMemory } from "@/lib/assistant-memory-store";

/**
 * The studio's switcher, and the door out for a store.
 *
 *   action=select   opens the store named by `?store=` in the studio, and
 *                   remembers it as the one to open next time
 *   action=delete   deletes that store, when it is one of the owner's other
 *                   stores with nothing in it yet (lib/store.ts, deleteStore);
 *                   `confirm` must be its address, typed
 *
 * A plain form post either way, so the switcher works without JavaScript.
 * Which store is always the one the form names, checked against who is
 * signed in (lib/studio-route.ts): choosing needs any role on it, deleting
 * needs the owner.
 */
export async function POST(request: NextRequest) {
  let form: FormData | null = null;
  try {
    form = await (await limited(request, 2_000)).formData();
  } catch {
    form = null;
  }
  const action = String(form?.get("action") ?? "");

  if (action === "select") {
    const creator = await creatorFrom(request, "member");
    if (creator instanceof Response) return creator;
    const response = away(creator.origin, creator.studio());
    response.headers.append("Set-Cookie", storeCookie(creator.store.sid, request));
    return response;
  }

  if (action === "delete") {
    const creator = await creatorFrom(request, "delete");
    if (creator instanceof Response) return creator;
    const { store, ref, origin, studio } = creator;
    const typed = String(form?.get("confirm") ?? "").trim().replace(/^@+/, "").toLowerCase();
    if (typed !== store.handle) return away(origin, studio("stores=confirm"));
    try {
      // The snapshot can lag behind Stripe (a payment whose way back was lost):
      // a store with a plan in good standing there is not deleted either.
      const found = isBillingConfigured() ? await findStoreSubscriptions(store) : null;
      if (found?.live) return away(origin, studio("stores=paying"));
      // Its keys named by its ids (its page photo, its list, its data room...) are erased by the closing walk, as a
      // closed store's are: its entry is written before its record goes (lib/closed-store-data.ts, queueDeleted).
      const result = await deleteStore(ref, queueDeleted);
      if (!result.ok) return away(origin, studio(`stores=${result.reason}`));
      // One that is not paying but could still be charged ends with the store.
      if (found?.lapsed.length) {
        await endLapsed(found.lapsed).catch((error: unknown) => console.error("ending a deleted store's lapsed subscription failed", error));
      }
      await dropTeam(result.store);
      // Nothing of a deleted store is kept that could still reach anyone: the
      // sealed key to its email platform, its phones' push addresses, the
      // notes its team wrote about buyers (lib/buyer-profile.ts), its
      // workflows, its webhook endpoints with their secrets, its API keys, and its
      // calendar feeds with the last copy of its bookings file (lib/calendar-sync.ts).
      // Its webhooks (with the bodies sent, which can hold buyers' data) and its API keys: a failure is put in a
      // durable line that the daily closing job tries again, with a ceiling of tries, and counted for the owner's
      // report (lib/store-forget-retry.ts; review of #2556), never only a log line.
      // The store assistant's notes too: an unconfirmed forgetting goes in the same line, never counted as done.
      const forgetHooksAndKeys = async () => {
        await forgetStoreWebhooks(result.store.statsId);
        await revokeAllKeys(result.store.sid);
        await forgetMemory(result.store.statsId ?? null, result.store);
      };
      await Promise.all([
        Promise.all([forgetStoreSync(result.store.statsId), forgetStorePhones(result.store.statsId), forgetPersonNotes(result.store.statsId), forgetCrm(result.store.statsId), forgetRecentSales(result.store.statsId), forgetStoreWorkflows(result.store), forgetPath(result.store), forgetStoreCalendar(result.store.statsId), forgetStoreReadings(result.store.statsId)]).catch((error: unknown) =>
          console.error("forgetting a deleted store's integrations failed", error),
        ),
        forgetHooksAndKeys().catch(async (error: unknown) => {
          console.error("forgetting a deleted store's webhooks, keys and assistant notes failed; put in line to try again", error);
          await queueStoreForget(result.store.statsId ?? null, result.store.sid).catch((queued: unknown) =>
            console.error("putting a deleted store's webhooks, keys and assistant notes in line failed", queued),
          );
        }),
      ]);
      // Back to the owner's first store, and the switcher forgets this one.
      const response = away(origin, "/studio?stores=deleted");
      response.headers.append("Set-Cookie", storeCookie("", request).replace(/Max-Age=\d+/, "Max-Age=0"));
      return response;
    } catch (error) {
      console.error("deleting a store failed", error);
      return away(origin, studio("stores=error"));
    }
  }

  return new Response("Unknown action.", { status: 400 });
}
