import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { takeAllowance } from "@/lib/store-allowance";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { readConfig } from "@/lib/community";
import { ITEM_ID, MAX_POST_TEXT } from "@/lib/community-text";
import { SCHEDULE_PROBLEMS, SCHEDULE_UNITS, readScheduleInput } from "@/lib/community-schedule-rules";
import { cancelScheduled, editScheduled, schedulePost } from "@/lib/community-schedule";
import { DataRoomError } from "@/lib/store-data";

const ACTIONS = new Set(["add", "edit", "cancel"]);

/**
 * 293 [SQ4]: the creator's posts and announcements written ahead.
 *
 * `{ action: "add", space, title, text, kind, email, date, time, tz }`
 * schedules one; `{ action: "edit", id, ... }` changes one still waiting;
 * `{ action: "cancel", id }` takes one off, or clears one already done.
 *
 * Only the store's owner: in the community, the creator's posts are the
 * owner's (lib/learn.ts learnerFrom), not the team's. An announcement emailed
 * to the members asks for the sending permission, which a session let in
 * without its second step does not have (lib/two-step.ts), nor may it take
 * one off, which deletes the creator's words for good. The studio
 * requests are taken before the community is read: the act and every try the
 * job may make when scheduling (SCHEDULE_UNITS), one for an edit; taking one
 * off is not counted, as deleting a post is not.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(
    request,
    (body) => (body.email === true && text(body.action, 20) !== "cancel" ? "send" : "community"),
    MAX_POST_TEXT * 4 + 4_000,
    // Taking one off deletes the creator's words for good: named "delete" to the guard, which a session let in
    // without its second step may not do (lib/two-step.ts LOCKED_ACTIONS), as deleting a post.
    (body) => (text(body.action, 20) === "cancel" ? "delete" : text(body.action, 20)),
  );
  if (!guarded.ok) return guarded.response;
  const { store, role, body } = guarded;
  const fail = (error: string, status = 400, message?: string) => Response.json({ ok: false, error, ...(message ? { message } : {}) }, { status });
  const action = text(body.action, 20);
  if (!ACTIONS.has(action)) return fail("invalid");
  if (role !== "owner") return fail("owner_only", 403);
  if (!store.community?.id) return fail("not_set_up");
  const id = text(body.id, 12);
  if (action !== "add" && !ITEM_ID.test(id)) return fail("unknown", 404);

  try {
    if (action === "cancel") {
      const done = await cancelScheduled(store, id);
      return done.ok ? Response.json({ ok: true }) : fail(done.reason, done.reason === "busy" ? 409 : 404);
    }

    // Paid for before anything of the community is read.
    if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return fail("resting", 503);
    const taken = action === "add" ? await takeAllowance(store, "studio", SCHEDULE_UNITS) : await takeAllowance(store, "studio", 1);
    if (!taken.ok) return fail(taken.reason === "unknown" ? "unknown_count" : "used", taken.reason === "unknown" ? 503 : 429, taken.message);

    const config = await readConfig(store.community.id);
    if (!config) return fail("not_set_up");
    const read = readScheduleInput(body, config.spaces, Date.now());
    if (!read.ok) return fail(read.problem, 400, SCHEDULE_PROBLEMS[read.problem]);

    if (action === "add") {
      const made = await schedulePost(store, read.input);
      if (!made.ok) return fail(made.reason === "full" ? "too_many" : "not_set_up", 409);
      return Response.json({ ok: true, id: made.post.id });
    }
    const changed = await editScheduled(store, id, read.input);
    return changed.ok ? Response.json({ ok: true }) : fail(changed.reason, changed.reason === "busy" ? 409 : 404);
  } catch (error) {
    if (error instanceof DataRoomError) return fail("store_full", 409, error.message);
    console.error("scheduling a community post failed", error);
    return fail("server_error", 500);
  }
}
