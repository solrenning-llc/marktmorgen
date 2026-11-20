import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import { isBillingConfigured } from "@/lib/billing";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { assistantRefusal, readAssistantReturn, setAssistantStop, startAssistant, syncAssistant } from "@/lib/assistant-billing";
import { setAssistantPlan } from "@/lib/store";
import { limited } from "@/lib/request-guard";

/**
 * The Store assistant add-on's billing (lib/assistant-billing.ts), from the
 * studio. POST `action=start` sends the owner to Stripe to start it, only
 * while it is on sale (lib/opening.ts, ASSISTANT_ON_SALE: closed with the
 * plans until the margin review, the tax gate and the deemed-supplier records
 * exist, lib/opening.ts), and
 * only for a store whose plan is paid; `action=stop` sets it to stop at the
 * end of the month paid, `action=resume` takes that back. GET is where
 * Stripe sends the owner back: nothing is believed until Stripe says what
 * the session made and that it is this store's.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "billing");
  if (creator instanceof Response) return creator;
  const { store, origin, studio } = creator;
  const back = (word: string) => away(origin, studio(`assistant=${word}`));

  let action = "";
  try {
    action = String((await (await limited(request, 2_000)).formData()).get("action") ?? "");
  } catch {
    action = "";
  }
  if (!isBillingConfigured()) return back("unavailable");
  try {
    if (action === "start") {
      // Not on sale (lib/opening.ts): no card is taken, and Stripe is not asked.
      if (!ASSISTANT_ON_SALE) return back("not-open");
      const refused = assistantRefusal(store);
      if (refused) return back(refused);
      // A live add-on at Stripe is adopted and one still charged opens nothing (lib/assistant-billing.ts): never a
      // second subscription beside it. A list not known throws, and the creator is told something went wrong.
      const started = await startAssistant(store, origin);
      if ("checkout" in started) return new Response(null, { status: 303, headers: { Location: started.checkout } });
      if ("waiting" in started) return back(started.waiting);
      const plan = started.already.assistantPlan;
      return back(plan?.disputedAt ? "disputed" : plan?.active ? "already" : "pending");
    }
    if (action === "stop" || action === "resume") {
      const saved = await setAssistantStop(store, action === "stop");
      return back(saved ? (action === "stop" ? "stopping" : "resumed") : "error");
    }
    return back("error");
  } catch (error) {
    console.error("the assistant's billing failed", error);
    return back("error");
  }
}

export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "billing", { checkOrigin: false });
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;
  if (!isBillingConfigured()) return away(origin, studio("assistant=unavailable"));
  try {
    const plan = await readAssistantReturn(store, request.nextUrl.searchParams.get("session_id") ?? undefined);
    if (!plan) return away(origin, studio("assistant=unfinished"));
    const saved = await setAssistantPlan(ref, plan);
    if (!saved) return away(origin, studio("assistant=error"));
    const synced = await syncAssistant(saved);
    return away(origin, studio(`assistant=${synced.assistantPlan?.active ? "on" : "pending"}`));
  } catch (error) {
    console.error("the assistant's billing return failed", error);
    return away(origin, studio("assistant=unconfirmed"));
  }
}
