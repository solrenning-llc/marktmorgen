import { readSequenceCsv } from "@/lib/sequence-import";
import { type NextRequest, after } from "next/server";
import { rfmSummary } from "@/lib/rfm-rules";
import { StoreFullError } from "@/lib/store-full";
import {
  MAX_MAIL_ADDRESS,
  MAX_MAIL_NAME,
  ensureListId,
  setMailSettings,
  storeForEmail,
  storeForHandle,
} from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_IMPORT, WHO, type Who, audience, importContacts, isBuyer, leadsKey, listCounts, parseContact, readAddresses, readTags } from "@/lib/contacts";
import { MAX_MAIL_BODY, MAX_SUBJECT, fromLine, monthlyAllowance, render, reserve, release } from "@/lib/mail";
import { sendBatch } from "@/lib/email";
import { healthId, startRamp } from "@/lib/mail-health";
import { BroadcastCancellationUnconfirmed, BroadcastWriteUnconfirmed, BroadcastsUnreadable, advanceBroadcast, cancelBroadcast, createBroadcast, whoOf } from "@/lib/broadcasts";
import { LedgerNotCounted, buyerLedger, isNarrowed, keeps, ledgerChannels, readNarrow, removeSegment, saveSegment } from "@/lib/segments";
import { NOT_COUNTED, countLedger } from "@/lib/person-agenda-read";
import { FLOW_ID, FlowWriteUnconfirmed, RESOLVE_CHOICES, type ResolveChoice, forgetWorkflowPerson, removeFlow, resolveHeldRun, saveFlow, setFlowActive } from "@/lib/flows";
import { readFlowListStrict } from "@/lib/flow-list";
import { FlowRunUnavailable, PERSON_KEY, listRuns, readRun } from "@/lib/flow-runs";
import { RUNS_LISTED } from "@/lib/flow-limits";
import { normaliseEmail } from "@/lib/auth";
import { courseProgress } from "@/lib/learn";
import { idsOfKind } from "@/lib/catalog";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError } from "@/lib/redis-reply";
import { DraftRemovalConflict, DraftRemovalUnconfirmed, DraftReadUnavailable, DraftWriteUnconfirmed, finishBroadcastDraft, removeDraft, saveDraft } from "@/lib/mail-drafts";
import { copyOf, keepSending } from "@/lib/mail-reuse";
import { setUpStarters } from "@/lib/mail-starters";
import { readListings } from "@/lib/catalog";
import { CrmSchemaReadUnavailable } from "@/lib/crm";
import type { Permission } from "@/lib/team-roles";

export const maxDuration = 60;

/** Refusals of "keep sending" that have words of their own in the studio. */
const KEEP_REFUSALS = new Set(["unsent", "excludes", "money", "already", "full"]);

/**
 * Which part of a role each action needs (lib/team-roles.ts): writing and
 * trying out an email is drafting; anything that reaches the list is sending.
 */
const MAIL_PERMISSIONS: Record<string, Permission> = {
  settings: "settings",
  import: "send",
  count: "draft",
  // A saved group is a name over the choices the composer has (lib/segments.ts).
  "segment-save": "draft",
  "segment-remove": "draft",
  test: "draft",
  "draft-save": "draft",
  "draft-remove": "draft",
  broadcast: "send",
  cancel: "send",
  flow: "send",
  // Reading a file of emails into a sequence's steps (lib/sequence-import.ts): nothing is saved, so it needs what saving one needs.
  "flow-import": "send",
  "flow-remove": "send",
  // Switching a workflow on is its own, explicit step (lib/flows.ts, setFlowActive).
  "flow-activate": "send",
  // A workflow's runs name the people in them, so they are for those who send.
  "flow-runs": "send",
  "flow-run": "send",
  "flow-resolve": "send",
  // One person of the list, read to preview their path: as private as the runs.
  "flow-sample": "send",
  // Erasing one person from every workflow, for a deletion request.
  "flow-forget": "send",
  // A sent email written again is a new draft; kept sending, it reaches the list.
  copy: "draft",
  keep: "send",
  // The two sequences written for the creator. Made switched off, but a
  // sequence all the same, so it is for whoever may reach the list.
  starters: "send",
};

/**
 * Everything the studio does with email:
 *
 *   { action: "settings", fromName, address }
 *   { action: "import", text, confirm: true }
 *   { action: "count", productId, notProductId, who, narrow? }   who: "all" | "buyers" | "leads";
 *                            narrow: { minSpent, channel, quietDays, group?, activeDays? } (lib/segments.ts); answers the
 *                            channels the store's buyers first came from too, when it reads them
 *   { action: "segment-save", name, who, productId, notProductId, narrow }  /  { action: "segment-remove", id }
 *   { action: "test", subject, body }
 *   { action: "draft-save", id?, subject, body, productId }  /  { action: "draft-remove", id }
 *   { action: "broadcast", subject, body, productId, notProductId, who, sendAt, draftId? }
 *   { action: "cancel", id }
 *   { action: "flow", flow: {...} }  /  { action: "flow-remove", id }
 *   { action: "flow-activate", id, active }   switch a saved workflow on or off
 *   { action: "flow-runs", id }               its most recent runs
 *   { action: "flow-run", id, run }           one run's history, step by step
 *   { action: "flow-resolve", id, run, choice }   a held run: "continue" | "retry" | "end"
 *   { action: "flow-sample", email, courses }  one person of the list, for the preview
 *   { action: "flow-forget", email }          erases that person from every workflow's runs
 *   { action: "copy", id }   a sent email's subject and text, to write again
 *   { action: "starters" }   the welcome and the after-a-first-purchase sequences, written
 *                            and left switched off, where the store has none (lib/mail-starters.ts)
 *   { action: "keep", id }   a sent email becomes one more email of a sequence,
 *                            for everybody who joins from now on (lib/mail-reuse.ts)
 *
 * Only the store settled by lib/studio-route.ts is ever touched: nothing in
 * the body names a list or a store. What each action needs of a role is in
 * MAIL_PERMISSIONS above.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(
    request,
    (body) => {
      const action = text(body.action, 20);
      return Object.hasOwn(MAIL_PERMISSIONS, action) ? MAIL_PERMISSIONS[action] : null;
    },
    400_000,
  );
  if (!guarded.ok) return guarded.response;
  const { email, ref, body } = guarded;
  const action = text(body.action, 20);
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  // The store's buyers not read because what reading them costs could not be counted (lib/segments.ts, buyerLedger).
  const notCounted = (message: string) => Response.json({ ok: false, error: "studio_used", message: message || NOT_COUNTED }, { status: 429 });

  try {
    let store = await storeForEmail(ref);
    if (!store) return fail("none");

    if (action === "settings") {
      const fromName = text(body.fromName, 200).replace(/\s+/g, " ").trim().slice(0, MAX_MAIL_NAME);
      const address = text(body.address, 1000).replace(/\s+/g, " ").trim().slice(0, MAX_MAIL_ADDRESS);
      if (!fromName) return fail("from_name");
      if (address.length < 10) return fail("address");
      await setMailSettings(ref, { fromName, address });
      return Response.json({ ok: true });
    }

    // Everything below writes to people, so it is Pro only.
    if (monthlyAllowance(store) === 0) return fail("plan", 403);

    if (action === "import") {
      if (body.confirm !== true) return fail("confirm");
      const { emails, skipped } = readAddresses(text(body.text, 390_000));
      if (emails.length === 0) return fail("no_addresses");
      if (emails.length > MAX_IMPORT) return fail("too_many");
      store = (await ensureListId(ref)) ?? store;
      const { added, already, full, roomFull } = await importContacts(store.listId as string, emails, store);
      // A hundred addresses or more, pasted in: of unknown age, so the next
      // emails go out in portions that double (lib/mail-health.ts), also
      // when the store's data room filled up partway and only some went in.
      await startRamp(healthId(store), added);
      return Response.json({ ok: true, added, already, skipped, full, roomFull: roomFull ?? null, counts: await listCounts(store.listId) });
    }

    if (action === "count") {
      if (!store.listId) return Response.json({ ok: true, count: 0 });
      const productId = text(body.productId, 40) || undefined;
      const notProductId = text(body.notProductId, 40) || undefined;
      const who = WHO.includes(body.who as Who) ? (body.who as Who) : "all";
      const narrow = readNarrow(body.narrow);
      // Only people with this label (99 [E2-TAG-BROADCAST]), cleaned as an email keeps it; empty is none.
      const label = readTags([text(body.label, 80)])[0] || undefined;
      // The store's sales are read only when an email narrows by them, or
      // when the composer opens the choices that do (lib/segments.ts).
      if (!isNarrowed(narrow) && body.channels !== true) {
        return Response.json({ ok: true, count: (await audience(store.listId, productId, notProductId, whoOf(store, who), undefined, label)).length });
      }
      // Counted before it is read: the ten-minute copy by its size, or Stripe, PayPal and the imported buyers again.
      const counting = countLedger(store);
      const ledger = await buyerLedger(store, counting.count).catch((error) => {
        if (error instanceof LedgerNotCounted) return error;
        console.error("reading a store's buyers for an email failed", error);
        return null;
      });
      if (ledger instanceof LedgerNotCounted) return notCounted(counting.said.message);
      if (!ledger) return Response.json({ ok: false, error: "stripe" }, { status: 502 });
      // One moment for the kinds counted and the kind kept, so a buyer at a boundary is the same kind in both.
      const now = Date.now();
      const keep = isNarrowed(narrow) ? keeps(narrow, ledger, now) : undefined;
      return Response.json({
        ok: true,
        count: (await audience(store.listId, productId, notProductId, whoOf(store, who), keep, label)).length,
        channels: ledgerChannels(ledger),
        // How many of the store's buyers are of each kind (270 [GR1], unit 3c), from the same ledger: no extra read.
        kinds: Object.fromEntries(rfmSummary(ledger.buyers.values(), now).map((k) => [k.id, k.buyers])),
        partial: ledger.partial,
      });
    }

    if (action === "segment-save") {
      const saved = await saveSegment(store, body);
      // Groups that could not be read are a moment's trouble, not the creator's: 503, and nothing was saved.
      if (!saved.ok) return Response.json({ ok: false, error: `segment_${saved.reason}` }, { status: saved.reason === "unavailable" ? 503 : 400 });
      return Response.json({ ok: true, segments: saved.segments });
    }

    if (action === "segment-remove") {
      // Removed, but the groups left could not be read: never shown as none (CX-123 rule 24).
      const segments = await removeSegment(store, body.id).catch((error: unknown) => {
        if (error instanceof UnknownReplyError) return null;
        throw error;
      });
      if (!segments) return fail("segment_unread", 503);
      return Response.json({ ok: true, segments });
    }

    if (action === "test") {
      if (!store.mail) return fail("setup");
      const subject = text(body.subject, 400).replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT);
      const content = text(body.body, MAX_MAIL_BODY * 2).trim().slice(0, MAX_MAIL_BODY);
      if (!subject) return fail("subject");
      if (!content) return fail("body");
      const reserved = await reserve(store, 1);
      if (reserved !== "ok") return fail(reserved === "month" ? "allowance" : reserved === "sender" ? "sender" : "day");
      const r = render(store, `[Test] ${subject}`, content, null);
      const outcome = await sendBatch(
        // To whoever pressed it: the owner, or the person on their team who is
        // writing the draft.
        [{ from: fromLine(store), to: email, subject: r.subject, text: r.text, html: r.html, replyTo: store.email }],
        `test:${store.handle}:${Date.now()}`,
        { by: "monthly" },
      );
      if (outcome !== "sent") {
        await release(store, 1);
        return fail("send", 502);
      }
      return Response.json({ ok: true, to: email });
    }

    if (action === "draft-save") {
      store = (await ensureListId(ref)) ?? store;
      const result = await saveDraft(store, email, {
        id: text(body.id, 40) || undefined,
        subject: text(body.subject, 400),
        body: text(body.body, MAX_MAIL_BODY * 2),
        productId: text(body.productId, 40),
        audience: body.audience,
        subjectTest: body.subjectTest,
        expectedSavedAt: body.expectedSavedAt,
      });
      return result.ok ? Response.json({ ok: true, draft: result.draft }) : fail(result.reason, result.reason === "draft_conflict" || result.reason === "draft_busy" ? 409 : 400);
    }

    if (action === "draft-remove") {
      const id = text(body.id, 40);
      const done = await removeDraft(store, id, body.expectedSavedAt);
      return done ? Response.json({ ok: true, removed: { id, savedAt: typeof body.expectedSavedAt === "string" ? body.expectedSavedAt : null } }) : fail("unknown", 404);
    }

    if (action === "broadcast") {
      // A narrowed email reads the store's buyers again when their copy ran out: counted first, nothing written when not.
      // It also holds, in the month it goes out, what the scheduled job's readings then cost at the most: without
      // room for them in that month it is refused now, with the sentence saying why, and nothing is written.
      const counting = countLedger(store);
      const created = await createBroadcast(store, {
        subject: text(body.subject, 400),
        body: text(body.body, MAX_MAIL_BODY * 2),
        productId: text(body.productId, 40),
        notProductId: text(body.notProductId, 40),
        who: text(body.who, 10),
        narrow: body.narrow,
        label: text(body.label, 80),
        sendAt: typeof body.sendAt === "number" ? body.sendAt : undefined,
        // A second subject line to try against the first; what it may be is
        // decided where the email is written down (lib/mail-test.ts).
        test: body.test && typeof body.test === "object" ? body.test : undefined,
      }, counting.count).catch((error) => {
        if (error instanceof LedgerNotCounted) return error;
        throw error;
      });
      if (created instanceof LedgerNotCounted) return notCounted(counting.said.message);
      if (!created.ok) return created.reason === "studio_used" ? notCounted(created.message) : fail(created.reason);
      const id = created.broadcast.id;
      // A draft that has now been sent or scheduled is done with.
      const fromDraft = text(body.draftId, 40);
      const draftCleanupConfirmed = await finishBroadcastDraft(store, fromDraft, body.draftSavedAt);
      if (!draftCleanupConfirmed) console.error("A confirmed campaign draft cleanup could not be confirmed");
      if (created.startsNow) {
        // Due now (exactly as advanceBroadcast takes it): starts as soon as the studio has its answer; the scheduled
        // job finishes anything this run does not. One set for later, even a minute, is the scheduled job's.
        // With the narrowing read and counted just now: not read or counted again. When the scheduled job takes the
        // lock first, its reading draws from what the email held for it (lib/broadcasts.ts, advanceBroadcast).
        const keep = created.keep;
        after(() => advanceBroadcast(id, storeForHandle, Date.now() + 50_000, { keep }).then(() => undefined));
      }
      return Response.json({ ok: true, broadcast: created.broadcast, draftCleanupConfirmed });
    }

    if (action === "cancel") {
      const id = text(body.id, 40);
      const done = await cancelBroadcast(store, id);
      return done ? Response.json({ ok: true, cancelled: { id, status: "cancelled" } }) : fail("unknown", 404);
    }

    if (action === "flow") {
      const raw = body.flow && typeof body.flow === "object" ? (body.flow as Record<string, unknown>) : {};
      const result = await saveFlow(store, raw);
      return result.ok ? Response.json({ ok: true, flows: result.flows }) : fail(result.reason);
    }

    if (action === "flow-import") {
      // Only read: the steps come back to the studio's editor, where the creator picks what starts it,
      // reviews every email and saves it, paused (544 [SQ9]). Nothing is saved or sent here.
      const csv = typeof body.csv === "string" ? body.csv : "";
      const read = readSequenceCsv(csv);
      return Response.json(read.ok ? { ok: true, steps: read.steps, report: read.report } : { ok: false, error: `import_${read.why}`, report: read.report }, { status: read.ok ? 200 : 400 });
    }

    if (action === "flow-activate") {
      const result = await setFlowActive(store, text(body.id, 40), body.active === true);
      return result.ok ? Response.json({ ok: true, flows: result.flows }) : fail(result.reason, result.reason === "unknown" ? 404 : 400);
    }

    if (action === "flow-runs" || action === "flow-run" || action === "flow-resolve") {
      const id = text(body.id, 40);
      // Only a workflow of this store: its runs are found under its own id.
      const flows = FLOW_ID.test(id) ? await readFlowListStrict(store.listId) : [];
      if (!flows.some((f) => f.id === id)) return fail("unknown", 404);
      if (action === "flow-runs") return Response.json({ ok: true, runs: await listRuns(id, RUNS_LISTED) });
      const run = text(body.run, 40);
      if (!PERSON_KEY.test(run)) return fail("unknown", 404);
      if (action === "flow-run") {
        const found = await readRun(id, run);
        return found ? Response.json({ ok: true, ...found }) : fail("unknown", 404);
      }
      const choice = RESOLVE_CHOICES.find((c) => c === body.choice) as ResolveChoice | undefined;
      if (!choice) return fail("invalid");
      const resolved = await resolveHeldRun(store, id, run, choice);
      if (resolved !== "ok") return fail(resolved === "unknown" ? "unknown" : resolved === "paused" ? "run_paused" : resolved === "retry_limit" ? "run_retry_limit" : "run_not_held", resolved === "unknown" ? 404 : 409);
      const found = await readRun(id, run);
      return Response.json({ ok: true, ...(found ?? {}) });
    }

    if (action === "flow-forget") {
      const address = normaliseEmail(text(body.email, 320));
      if (!address) return fail("email");
      const erased = await forgetWorkflowPerson(store, address);
      return Response.json({ ok: true, erased: erased.flows });
    }

    if (action === "flow-sample") {
      if (!store.listId) return Response.json({ ok: true, found: false });
      const address = normaliseEmail(text(body.email, 320));
      if (!address) return fail("email");
      const [raw] = await redisPipeline([["HGET", leadsKey(store.listId), address]]);
      const contact = parseContact(raw);
      if (!contact) return Response.json({ ok: true, found: false });
      const courses = new Set(idsOfKind(store, "course"));
      const asked = (Array.isArray(body.courses) ? body.courses : []).filter((c): c is string => typeof c === "string" && courses.has(c)).slice(0, 20);
      const progress: Record<string, { started: boolean; finished: boolean }> = {};
      for (const productId of asked) progress[productId] = (await courseProgress(store, productId, [address])).get(address) ?? { started: false, finished: false };
      return Response.json({
        ok: true,
        found: true,
        sample: { email: address, ids: contact.ids, buyer: isBuyer(contact, new Set(idsOfKind(store, "paid"))), tags: contact.tags, courses: progress },
      });
    }

    if (action === "copy") {
      const copy = await copyOf(store, text(body.id, 40));
      return copy ? Response.json({ ok: true, copy }) : fail("unknown", 404);
    }

    if (action === "keep") {
      // One product's name, when the email was written to the people who got
      // it: one record read, never the catalogue.
      const current = store;
      const kept = await keepSending(current, text(body.id, 40), async (id) => (await readListings(current, [id]))[0]?.title ?? null);
      if (!kept.ok) return fail(KEEP_REFUSALS.has(kept.reason) ? `keep_${kept.reason}` : kept.reason);
      return Response.json({ ok: true, flows: kept.flows, name: kept.name, waitHours: kept.waitHours, position: kept.position });
    }

    if (action === "starters") {
      const made = await setUpStarters(store);
      if (!made.ok) return fail(made.reason === "nothing" ? "starters_nothing" : made.reason);
      return Response.json({ ok: true, flows: made.flows, made: made.made });
    }

    if (action === "flow-remove") {
      const result = await removeFlow(store, text(body.id, 40));
      return result.ok ? Response.json({ ok: true, flows: result.flows }) : fail(result.reason, 404);
    }

    return fail("invalid");
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return fail("store_full", 409);
    console.error("an email action failed", error);
    if (error instanceof BroadcastCancellationUnconfirmed) return fail("broadcast_cancel_unconfirmed", 502);
    if (error instanceof BroadcastWriteUnconfirmed) return fail("broadcast_write_unconfirmed", 502);
    // An email's record that could not be read (rule 24): nothing was changed, never "not there".
    if (error instanceof BroadcastsUnreadable) return fail("broadcast_read_unavailable", 503);
    if (error instanceof FlowWriteUnconfirmed) return fail("flow_write_unconfirmed", 502);
    if (error instanceof FlowRunUnavailable) return fail("flow_runs_unavailable", 503);
    // A sequence's stages and fields are checked against the store's own; unknown ones save nothing (lib/crm.ts).
    if (error instanceof CrmSchemaReadUnavailable) return fail("crm_schema_read_unavailable", 503);
    if (error instanceof DraftWriteUnconfirmed) return fail("draft_write_unconfirmed", 502);
    if (error instanceof DraftReadUnavailable) return fail("draft_read_unavailable", 503);
    if (error instanceof DraftRemovalConflict) return fail("draft_remove_conflict", 409);
    if (error instanceof DraftRemovalUnconfirmed) return fail("draft_remove_unconfirmed", 502);
    return fail("server_error", 500);
  }
}
