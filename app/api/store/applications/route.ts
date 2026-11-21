import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { countStudio } from "@/lib/studio-route";
import { APPLICATION_ID, APPLY_LINK_DAYS_DEFAULT, APPLY_LINK_DAYS_MAX, APPLY_LINK_DAYS_MIN } from "@/lib/apply-first-rules";
import { APPLY_DECIDE_STUDIO_UNITS, decideApplication } from "@/lib/apply-first-store";
import { DECIDE_WORDS } from "@/lib/apply-first-words";

/**
 * The studio's answer to an application to buy (604 [WP3], lib/apply-first-store.ts), for a role
 * that may email people for the store ("send": the owner and admins), since an approval is what
 * a buy link will be sent on:
 *
 *   { action: "approve", id, days }   days from APPLY_LINK_DAYS_MIN to APPLY_LINK_DAYS_MAX
 *   { action: "decline", id }
 *
 * The decision takes APPLY_DECIDE_STUDIO_UNITS studio requests more than the door's own, before it
 * reads the application. Answers `{ ok: true, application }`, or `{ ok: false, error, message }`
 * with a sentence to show: "changed" when the application changed while it was decided (nothing
 * saved), "unknown" when whether it was saved could not be confirmed. The link's token is not sent
 * back to the page and no email goes yet: sending the link comes in a later unit.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const refuse = (error: keyof typeof DECIDE_WORDS, status: number) => Response.json({ ok: false, error, message: DECIDE_WORDS[error] }, { status });
  const action = text(body.action, 20);
  const id = text(body.id, 40);
  if (action !== "approve" && action !== "decline") return refuse("invalid", 400);
  if (!APPLICATION_ID.test(id)) return refuse("gone", 404);
  const days = action === "approve" ? (body.days === undefined ? APPLY_LINK_DAYS_DEFAULT : body.days) : 0;
  if (action === "approve" && (typeof days !== "number" || !Number.isSafeInteger(days) || days < APPLY_LINK_DAYS_MIN || days > APPLY_LINK_DAYS_MAX)) return refuse("days", 400);
  try {
    const counted = await countStudio(store, null, APPLY_DECIDE_STUDIO_UNITS);
    if (!counted.ok) return Response.json({ ok: false, error: "allowance", message: counted.message }, { status: 429 });
    const done = await decideApplication(store, id, action === "approve" ? { kind: "approve", days: days as number } : { kind: "decline" });
    if (done.ok) return Response.json({ ok: true, application: done.application });
    switch (done.reason) {
      case "gone":
        return refuse("gone", 404);
      case "final":
        return refuse("final", 409);
      case "still-open":
        return refuse("still_open", 409);
      case "bad-input":
        return refuse("days", 400);
      case "changed":
        return refuse("changed", 409);
      default:
        return refuse("unknown", 503);
    }
  } catch (error) {
    console.error("deciding an application failed", error);
    return refuse("unknown", 503);
  }
}
