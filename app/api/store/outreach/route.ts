import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinEssentialLimit } from "@/lib/request-guard";
import { ensureStatsId, storeRef } from "@/lib/store";
import { AI_PER_MINUTE, MAX_AI_NOTES } from "@/lib/ai-rules";
import { dropPitch, editPitch, readStoreSite, saveSender, setPitchStatus, startPitch } from "@/lib/outreach";
import { MAX_PITCH_BODY, MAX_PITCH_SUBJECT, PITCH_STATUSES, type PitchStatus, isGoal } from "@/lib/outreach-rules";
import { UnknownReplyError } from "@/lib/redis-reply";

/** Reading somebody else's website and asking the model can each take seconds. */
export const maxDuration = 60;

/** Sites one store has read for a contact in a minute, and in a day. */
const FINDS_PER_MINUTE = 6;
const FINDS_PER_DAY = 60;

/**
 * Outreach (lib/outreach.ts): `{ action, … }`.
 *
 *   find    { site }                               what a business says of itself and where it asks to be written
 *   draft   { goal, country, isCompany, page, email, company, about, notes }   writes one pitch, held to every rule
 *   edit    { id, subject, body }                  the creator's own changes to a draft
 *   status  { id, status }                         sent, replied, deal, or "they asked me to stop"
 *   drop    { id }                                 takes a draft away
 *   sender  { name, address }                      who is writing: on every pitch
 *
 * Nothing here sends an email. A pitch is opened as a draft in the creator's
 * own mailbox, by a link the studio builds (lib/outreach-rules.ts, draftLinks).
 *
 * For whoever may write the store's emails (lib/team-roles.ts, "draft").
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "draft", 12_000);
  if (!guarded.ok) return guarded.response;
  const { body, ref } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  // Pitches are kept under the store's own id, made here for a store from before it had one.
  const store = guarded.store.statsId ? guarded.store : ((await ensureStatsId(ref ?? storeRef(guarded.store))) ?? guarded.store);
  const who = store.sid || store.handle;
  const action = text(body.action, 10);

  try {
    if (action === "find") {
      // The day's limit first, so a read refused for the day takes nothing from the store's month.
      if (!(await withinEssentialLimit("outreach-find-day", who, FINDS_PER_DAY, 86_400))) return fail("day", 429);
      const refused = await withinServiceWhy("outreach-find", who, FINDS_PER_MINUTE, 60, store);
      if (refused) return serviceRefusedJson(refused, "slow");
      const read = await readStoreSite(store, text(body.site, 300));
      if (!read.ok) return fail(read.reason, read.reason === "unavailable" ? 503 : 400);
      return Response.json({ ok: true, site: read.site });
    }
    if (action === "draft") {
      if (!isGoal(body.goal)) return fail("invalid");
      if (!(await withinEssentialLimit("ai", who, AI_PER_MINUTE, 60))) return fail("slow", 429);
      const done = await startPitch(store, {
        goal: body.goal,
        country: text(body.country, 2).toUpperCase(),
        isCompany: body.isCompany === true,
        page: text(body.page, 600),
        email: text(body.email, 200),
        company: text(body.company, 160),
        about: text(body.about, 500),
        notes: text(body.notes, MAX_AI_NOTES + 100),
      });
      if (!done.ok) return fail(done.reason, done.reason === "unavailable" ? 503 : done.reason === "failed" ? 502 : 400);
      return Response.json({ ok: true, pitch: done.pitch, left: done.left, replaced: done.replaced });
    }
    if (action === "edit") {
      const pitch = await editPitch(store, text(body.id, 40), text(body.subject, MAX_PITCH_SUBJECT + 20), text(body.body, MAX_PITCH_BODY + 200));
      return pitch ? Response.json({ ok: true, pitch }) : fail("unknown", 404);
    }
    if (action === "status") {
      const status = PITCH_STATUSES.includes(body.status as PitchStatus) ? (body.status as PitchStatus) : null;
      if (!status) return fail("invalid");
      const pitch = await setPitchStatus(store, text(body.id, 40), status);
      return pitch ? Response.json({ ok: true, pitch }) : fail("unknown", 404);
    }
    if (action === "drop") {
      return (await dropPitch(store, text(body.id, 40))) ? Response.json({ ok: true }) : fail("unknown", 404);
    }
    if (action === "sender") {
      const sender = await saveSender(store, { name: body.name, address: body.address });
      return sender ? Response.json({ ok: true, sender }) : fail("sender");
    }
    return fail("invalid");
  } catch (error) {
    console.error("outreach failed", error);
    // A read or a receipt not known (rule 24): said as nothing known to have changed, never done.
    if (error instanceof UnknownReplyError) return fail("unavailable", 503);
    return fail("server_error", 500);
  }
}
