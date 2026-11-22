import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { limited } from "@/lib/request-guard";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { within } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import { ITEM_ID } from "@/lib/community-text";
import { checkIn, joinChallenge, readChallenge } from "@/lib/community-challenges";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";

/** The most a form here may weigh: four short fields. */
const MAX_FORM_BYTES = 2_000;

/**
 * A member joins a community challenge, or checks in for today
 * (lib/community-challenges.ts): a plain form that works without a script,
 * answered with a move back to the challenges page, to the challenge itself,
 * with a word about what happened.
 *
 * Who is asking is worked out again here, whatever the page showed: let into
 * the community now (lib/community-access.ts). A muted member may still
 * check in: muting stops writing in the feed, not taking part. The creator
 * runs the challenge and does not check in. Each press is one of the store's
 * buyer actions (lib/buyer-actions.ts) and counts against the member's own
 * challenge limit (lib/community-text.ts), before anything is read.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_FORM_BYTES) {
    return new Response("Too large.", { status: 413 });
  }
  let form: FormData;
  try {
    form = await (await limited(request, MAX_FORM_BYTES)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const field = (name: string, max = 40) => String(form.get(name) ?? "").slice(0, max);
  const handle = normaliseHandle(field("handle"));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store?.community) return new Response("Not found.", { status: 404 });
  const home = `/@${store.handle}/community`;
  const challengeId = field("challenge", 12);
  const page = `${home}/challenges`;
  const at = ITEM_ID.test(challengeId) ? `#ch-${challengeId}` : "";
  const back = (word: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}${page}?n=${word}${at}`, "Cache-Control": "no-store" } });

  try {
    const viewer = await communityViewer(store, request.cookies);
    if (viewer.state !== "in") {
      return new Response(null, { status: 303, headers: { Location: `${origin}${home}?n=${viewer.state === "off" ? "off" : "out"}`, "Cache-Control": "no-store" } });
    }
    if (viewer.owner) return back("host");
    if (!viewer.member) return back("notmember");
    // One of the store's buyer actions, before the challenge is read (lib/buyer-actions.ts).
    if (!(await takeBuyerAction(store))) return restingAway(origin, store);
    const id = store.community.id;
    if (!(await within(id, viewer.key, "challenge"))) return back("slow");
    const challenge = await readChallenge(id, challengeId);
    if (!challenge) return back("gone");

    if (field("action", 12) === "join") {
      const joined = await joinChallenge(id, challenge, viewer.key, store);
      return back(joined);
    }
    const checked = await checkIn(id, challenge, viewer.key, store);
    return back(checked === "already" ? "checkedalready" : checked);
  } catch (error) {
    // No room in the store's data room: nothing was written (lib/store-data.ts).
    if (error instanceof DataRoomError) return back("noroom");
    console.error("a challenge check-in failed", error);
    return back("error");
  }
}
