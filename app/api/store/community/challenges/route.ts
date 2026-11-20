import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { LockBusyError } from "@/lib/redis-lock";
import { storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readConfig } from "@/lib/community";
import { ITEM_ID } from "@/lib/community-text";
import { createChallenge, deleteChallenge, readChallengeInput, withinChallengeWrites } from "@/lib/community-challenges";

const ACTIONS = new Set(["create", "delete"]);

/**
 * What the studio changes about the community's challenges
 * (lib/community-challenges.ts). Both need "events" (lib/team-roles.ts):
 * the owner, Admins and Editors, as for live events.
 *
 * `{ action: "create", title, about, task, from, to }` puts one on, its days
 * from `from` to `to` (YYYY-MM-DD, midnight to midnight UTC); `{ action:
 * "delete", challenge }` takes one away with its members' places and
 * check-ins, and is refused to a session let in without its second step
 * (lib/two-step.ts, "events" "delete").
 *
 * The challenges are always found through the creator's own store, so
 * nothing here can reach anyone else's.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "events", 4_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 20);
  if (!ACTIONS.has(action)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    const store = await storeForEmail(ref);
    const id = store?.community?.id;
    const config = id ? await readConfig(id) : null;
    if (!store || !id || !config) return fail("not_set_up");
    if (!(await withinChallengeWrites(id))) return fail("slow", 429);

    if (action === "create") {
      const input = readChallengeInput(body);
      if (typeof input === "string") return fail(input);
      const made = await createChallenge(store, input);
      if (!made.ok) return fail(made.reason, 409);
      return Response.json({ ok: true, challenge: made.challenge });
    }
    if (action === "delete") {
      const challengeId = text(body.challenge, 12);
      if (!ITEM_ID.test(challengeId)) return fail("unknown", 404);
      const gone = await deleteChallenge(store, challengeId);
      return gone === "deleted" ? Response.json({ ok: true }) : fail("unknown", 404);
    }
    return fail("invalid");
  } catch (error) {
    // No room in the store's data room: nothing was written (lib/store-data.ts).
    if (error instanceof DataRoomError) return fail("store_full", 409);
    if (error instanceof LockBusyError) return fail("busy", 409);
    console.error("a challenge change failed", error);
    return fail("server_error", 500);
  }
}
