import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { after } from "next/server";
import { storeForEmail, storeForHandle } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";
import { CREATOR, createPost, readConfig } from "@/lib/community";
import { ITEM_ID } from "@/lib/community-text";
import {
  announcementText,
  cancelEvent,
  createEvent,
  deleteEvent,
  editEvent,
  readEvent,
  readEventInput,
  readReplay,
  setEventPost,
  setReplay,
  withinEventWrites,
} from "@/lib/community-events";
import { type EventMailJob, advanceEventJob, cancelNoticeSending, queueEventNotice } from "@/lib/community-event-mail";
import { eventMeeting, eventMeetingAfterEdit, eventMeetingCancelled } from "@/lib/event-meetings";
import { usableProviders } from "@/lib/meet-connect";
import type { EventInput } from "@/lib/community-events";
import type { MeetProvider } from "@/lib/call-setup";

const ACTIONS = new Set(["create", "edit", "cancel", "delete", "replay"]);

/**
 * Everything the studio changes about the community's live events
 * (lib/community-events.ts). Scheduling, moving, cancelling and posting a
 * replay need "events" (lib/team-roles.ts): the owner, Admins and Editors.
 * Support reads who is coming in the studio, and changes nothing here.
 *
 * `{ action: "create", title, about, date, time, tz, minutes, cap, where,
 * link, meet, only, announce, space }` puts one on the calendar, and with
 * `announce` posts it in the feed. `where: "meet"` with `meet: "google" |
 * "zoom"` makes a Google Meet or Zoom meeting for it on the store's
 * connected account (lib/event-meetings.ts): chosen only while that account
 * is connected and works, and falling back to the event's private room when
 * the meeting cannot be made; `{ action: "edit", event, …the same }`
 * changes it — a new time emails everyone coming, once; `{ action:
 * "cancel", event }` calls it off and emails them, once; `{ action:
 * "delete", event }` takes a cancelled or finished one away; `{ action:
 * "replay", event, url }` sets or clears its recording.
 *
 * Once a move or a cancellation is written, the answer says it was made,
 * never 500: with `notice: "waiting"` when who is coming could not be read
 * just now (the email is written down and goes out once it can, rule 30), or
 * `notice: "failed"` when the email could not even be written down.
 *
 * The events are always found through the creator's own store, so nothing
 * here can reach anyone else's.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "events", 12_000);
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
    if (!(await withinEventWrites(id))) return fail("slow", 429);
    const eventId = text(body.event, 12);
    if (action !== "create" && !ITEM_ID.test(eventId)) return fail("unknown", 404);

    // Google Meet or Zoom is chosen only while that account is connected and
    // works (lib/meet-connect.ts), as for a call. An event that already uses
    // it keeps saving while a connection is broken: its meeting, or its
    // fallback room, is already there.
    const meetRefused = async (input: EventInput, current: { where: string; meet: string | null } | null) => {
      if (input.where !== "meet" || !input.meet) return null;
      if (current && current.where === "meet" && current.meet === input.meet) return null;
      const usable = await usableProviders(store.statsId).catch((): MeetProvider[] => []);
      return usable.includes(input.meet) ? null : fail(`meet_${input.meet}`);
    };
    // What happens with the meeting never holds the event up: a failure is
    // written down for the studio, and the event uses its room meanwhile.
    const meeting = <T,>(work: Promise<T>) =>
      work.catch((error) => {
        console.error("keeping a live event's meeting in step failed", error);
        return null;
      });

    // Sends a move's or a cancellation's email now, after the answer; the
    // five-minute job finishes whatever this one does not, a notice still
    // waiting for who is coming included, which the answer then tells of.
    let notice = null as "waiting" | "failed" | null;
    const notify = (job: EventMailJob | null) => {
      if (!job) return;
      if (job.waiting) notice = "waiting";
      const jobId = job.id;
      try {
        after(() => advanceEventJob(jobId, storeForHandle, Date.now() + 25_000).then(() => undefined, (error) => console.error("sending an event notice failed", error)));
      } catch (error) {
        // The send is written down: the five-minute job sends it.
        console.error("handing an event notice to after failed", error);
      }
    };
    // The change is written by then: its notice failing to start is told, never a 500.
    const unsent = (error: unknown) => {
      console.error("starting an event notice failed", action, error);
      notice = "failed";
    };

    if (action === "create") {
      const input = readEventInput(body, config);
      if (typeof input === "string") return fail(input);
      const refused = await meetRefused(input, null);
      if (refused) return refused;
      const made = await createEvent(store, input);
      if (!made.ok) return fail("too_many", 409);
      let event = made.event;
      const record = await meeting(eventMeeting(store, event));
      if (body.announce === true) {
        const space = config.spaces.find((s) => s.id === text(body.space, 12)) ?? config.spaces[0];
        if (space) {
          const words = announcementText(store, event);
          // An announcement that does not fit in the store's data room is left out; the event stands.
          const posted = await createPost(id, { space: space.id, author: CREATOR, title: words.title, text: words.text, img: null, kind: "announcement", poll: null }, store).catch((error) => {
            if (error instanceof DataRoomError) return { ok: false as const, reason: "full" as const };
            throw error;
          });
          if (posted.ok) {
            await setEventPost(store, event.id, posted.post.id);
            event = { ...event, post: posted.post.id };
          }
        }
      }
      return Response.json({ ok: true, event: { id: event.id, post: event.post }, meeting: record ? { made: record.made, error: record.error } : null });
    }

    if (action === "edit") {
      const current = await readEvent(id, eventId);
      if (!current) return fail("unknown", 404);
      const input = readEventInput(body, config, Date.now(), current);
      if (typeof input === "string") return fail(input);
      // A new time is emailed to everyone coming: not from a session let in without its second step (lib/two-step.ts).
      if ((input.start !== current.start || input.minutes !== current.minutes) && (await lockedFor(request, "events", "move"))) return refusedJson("locked");
      const refused = await meetRefused(input, current);
      if (refused) return refused;
      const changed = await editEvent(store, eventId, input);
      if (!changed.ok) return fail(changed.reason, changed.reason === "gone" ? 404 : 409);
      // The meeting follows: moved with the event, made when newly chosen,
      // removed when another place is chosen — before anybody is told.
      const record = await meeting(eventMeetingAfterEdit(store, changed.before, changed.event));
      if (changed.moved) {
        try {
          notify(await queueEventNotice(store, changed.event, "moved", { start: changed.before.start, minutes: changed.before.minutes }));
        } catch (error) {
          unsent(error);
        }
      }
      return Response.json({ ok: true, moved: changed.moved, ...(notice ? { notice } : {}), meeting: record ? { made: record.made, error: record.error } : null });
    }

    if (action === "cancel") {
      const changed = await cancelEvent(store, eventId);
      if (!changed.ok) return fail(changed.reason, changed.reason === "gone" ? 404 : 409);
      await meeting(eventMeetingCancelled(store, changed.event));
      try {
        notify(await queueEventNotice(store, changed.event, "cancelled", null));
      } catch (error) {
        unsent(error);
      }
      if (notice) return Response.json({ ok: true, notice });
      return Response.json({ ok: true });
    }

    if (action === "delete") {
      // Everyone coming is told it was called off before the event itself goes.
      if (await cancelNoticeSending(id, eventId)) return fail("telling", 409);
      const gone = await deleteEvent(store, eventId);
      if (gone === "gone") return fail("unknown", 404);
      if (gone === "upcoming") return fail("upcoming", 409);
      return Response.json({ ok: true });
    }

    // replay
    const raw = text(body.url, 500).trim();
    const replay = raw ? readReplay(raw) : null;
    if (raw && !replay) return fail("replay");
    const changed = await setReplay(store, eventId, replay);
    if (!changed.ok) return fail(changed.reason, changed.reason === "gone" ? 404 : 409);
    return Response.json({ ok: true });
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof DataRoomError) return fail("store_full", 409);
    console.error("changing a live event failed", action, error);
    return fail("server_error", 500);
  }
}
