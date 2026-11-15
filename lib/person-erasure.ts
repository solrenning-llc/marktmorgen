/**
 * Deleting one person from one store, everywhere the store keeps them
 * (added 17 October 2026; ClickFunnels audit F64 and F28).
 *
 * Two doors lead here, and both do the same thing: a creator, or a teammate
 * whose role may delete people (lib/team-roles.ts, "erase"), presses
 * "Delete this person" on the buyer's page in the studio; or the person
 * proves their address by an emailed link and asks for it themselves
 * (lib/erasure-request.ts). Nobody is asked to do anything by hand.
 *
 * In order:
 *
 *   1. A one-way fingerprint of the address goes on the store's list of the
 *      deleted (lib/suppression.ts) before anything is taken away, so even
 *      an erasure cut short half-way never lets them be emailed again.
 *   2. Every module that keeps something about a person of a store forgets
 *      it, through the function it exports for that (lib/person-data.ts
 *      names each one, and tests/person-data-registry.test.ts fails when a
 *      module keeps something per person and is not there).
 *   3. The files they handed in and the photos on their reviews are deleted
 *      from the file store, or, when it does not answer, by the daily job
 *      that deletes uploads nobody kept, within a day.
 *   4. From the studio, the store's activity log notes that a person was
 *      deleted, by whom and how many records went, never the address; a
 *      person's own deletion is told to the store's owner by email instead.
 *
 * What is kept, and why, is the registry's "kept" entries: the payments on
 * the creator's own Stripe account, which are the creator's sales and tax
 * records and never stored here, and the few order records of ours a sale
 * or a refund still needs (lib/person-data.ts says which, field by field).
 *
 * Each step can be run again: an erasure that stopped half-way (a database
 * that did not answer) is finished by pressing again, and an erasure of
 * somebody already gone deletes nothing more.
 *
 * What it costs is counted before it is incurred, from the store's studio
 * figure (lib/store-allowance-rules.ts), whichever door it came through: the
 * part its record says (products, courses) before anything is read, the rest
 * once the courses are read and a few counts taken (lib/erasure-rules.ts,
 * erasureUnits), sized in tests/person-erasure.test.ts to cover what it sends.
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Store, ensureListId, ensureStatsId, storeRef } from "@/lib/store";
import { readKindExact } from "@/lib/catalog";
import { readCoursesExact } from "@/lib/course";
import { emailKey, forgetLearnerPerson, storeKey } from "@/lib/learn";
import { personKey } from "@/lib/person-key";
import { suppressCommand } from "@/lib/suppression";
import { takeAllowance } from "@/lib/store-allowance";
import { logTeam } from "@/lib/team";
import type { Role } from "@/lib/team-roles";
import { deleteFile } from "@/lib/file-store";
import { noteTaskUpload } from "@/lib/assignment";
import { type ErasedPart, type ErasureBy, type ErasureScope, type ErasureSize, erasureUnits } from "@/lib/erasure-rules";
import { idsOfKind } from "@/lib/catalog";
import { dealCount } from "@/lib/crm";
import { conversationCount } from "@/lib/inbox";
import { dmCount } from "@/lib/community-dm";
import { roomSize } from "@/lib/community-chat";
import { eventCount } from "@/lib/community-events";
import { certificateCount } from "@/lib/certificate";
import { forgetContactPerson } from "@/lib/contacts";
import { forgetClicksPerson } from "@/lib/mail-clicks";
import { forgetHealthPerson } from "@/lib/mail-health";
import { forgetWorkflowPerson } from "@/lib/flows";
import { forgetCrmPerson } from "@/lib/crm";
import { forgetCompanyPerson } from "@/lib/crm-companies";
import { forgetNotesPerson } from "@/lib/buyer-profile";
import { forgetFormsPerson } from "@/lib/form-store";
import { forgetFinishPerson } from "@/lib/course-finish";
import { forgetQuizPerson } from "@/lib/quiz";
import { forgetTasksPerson } from "@/lib/assignment";
import { forgetCertificatesPerson } from "@/lib/certificate";
import { forgetLessonCommentsPerson } from "@/lib/lesson-comments";
import { forgetLessonNotesPerson } from "@/lib/lesson-notes";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { forgetWaitlistPerson } from "@/lib/waitlist";
import { forgetBondPerson } from "@/lib/affiliate-bond";
import { forgetLeadPerson } from "@/lib/affiliate-leads";
import { forgetImportedPerson } from "@/lib/imported-purchases";
import { forgetPodcastPerson } from "@/lib/podcast-access";
import { forgetWelcomePerson } from "@/lib/welcome-offer-send";
import { forgetWinbackPerson } from "@/lib/winback-send";
import { forgetRecoveryPerson } from "@/lib/checkout-recovery";
import { forgetAssistReminderPerson } from "@/lib/assistant-reminder";
import { forgetInvitesPerson } from "@/lib/move-members";
import { forgetInboxPerson } from "@/lib/inbox";
import { forgetDiscordPerson } from "@/lib/discord-access";
import { forgetSyncPerson } from "@/lib/email-sync";
import { forgetLedgerCopy } from "@/lib/segments";
import { forgetReadingsPerson } from "@/lib/store-readings";
import { forgetFeedCopyPerson } from "@/lib/calendar-sync";
import { forgetHealthCopy } from "@/lib/member-health";
import { forgetReviewsPerson } from "@/lib/reviews";
import { dropReviewQuotes, keepStoreQuotes } from "@/lib/store-quotes";
import { forgetVoicePerson } from "@/lib/customer-voice";
import { forgetLibraryPerson } from "@/lib/buyer-library";
import { forgetNoted } from "@/lib/erasure-index";
import { forgetRequestsPerson } from "@/lib/payment-request-store";
import { forgetAgreementsPerson } from "@/lib/agreement-store";
import { forgetShipmentMail } from "@/lib/shipment-mail-outbox";
import { forgetOrderConfirmationMail } from "@/lib/order-confirmation-outbox";


/**
 * One module's part of an erasure: its name, as lib/person-data.ts gives it,
 * and what it forgets. `only` is the one door it runs for, when it is not
 * both: a store's team cannot delete a buyer's review by deleting the buyer
 * (the FTC's rule on consumer reviews forbids suppressing them, lib/reviews.ts),
 * nor take away what an import gave a buyer for a purchase made elsewhere.
 */
type Eraser = { module: string; only?: ErasureBy; after?: string[]; run: (scope: ErasureScope, files: string[], notes: Set<ErasureNote>) => Promise<number> };

/** Something the creator should know, said with the result. */
export type ErasureNote = "discord-roles" | "email-platform";

/**
 * Every eraser, in the order they run. The list's own row goes last, after
 * the modules that read it to find what they keep (the key of a person's
 * links, their place in a sequence).
 */
export const ERASERS: Eraser[] = [
  { module: "lib/order-confirmation-outbox.ts", run: (s) => forgetOrderConfirmationMail(s.statsId, s.email) },
  { module: "lib/shipment-mail-outbox.ts", run: (s) => forgetShipmentMail(s.statsId, s.email) },
  { module: "lib/flows.ts", run: async (s) => (await forgetWorkflowPerson(s.store, s.email)).flows },
  { module: "lib/mail-clicks.ts", run: (s) => forgetClicksPerson(s.listId, s.email) },
  { module: "lib/mail-health.ts", run: (s) => forgetHealthPerson(s.store, s.email) },
  { module: "lib/crm.ts", run: (s) => forgetCrmPerson(s.statsId, s.person, s.email, s.store) },
  // Taken off any company they were linked to, the room it took given back (639 [GL7](4)).
  { module: "lib/crm-companies.ts", run: (s) => forgetCompanyPerson(s.statsId, s.person, undefined, s.store) },
  { module: "lib/payment-request-store.ts", run: (s) => forgetRequestsPerson(s.sid, s.email) },
  { module: "lib/agreement-store.ts", run: (s) => forgetAgreementsPerson(s.sid, s.email) },
  { module: "lib/buyer-profile.ts", run: (s) => forgetNotesPerson(s.statsId, s.person) },
  { module: "lib/form-store.ts", run: (s) => forgetFormsPerson(s.statsId, s.email, s.store) },
  {
    module: "lib/learn.ts",
    run: (s) => forgetLearnerPerson(s.store, s.email, s.courses.map((c) => ({ courseId: c.courseId, moduleIds: c.moduleIds }))),
  },
  { module: "lib/course-finish.ts", run: (s) => forgetFinishPerson(s.courses.map((c) => c.courseId), s.email) },
  { module: "lib/quiz.ts", run: (s) => forgetQuizPerson(s.courses.map((c) => ({ courseId: c.courseId, lessonIds: c.lessonIds })), s.learner) },
  {
    module: "lib/assignment.ts",
    run: async (s, files) => {
      let records = 0;
      for (const c of s.courses) {
        const done = await forgetTasksPerson(c.courseId, c.lessonIds, s.learner, storeKey(s.store));
        records += done.records;
        files.push(...done.files);
      }
      return records;
    },
  },
  { module: "lib/certificate.ts", run: (s) => forgetCertificatesPerson(s.courses.map((c) => c.courseId), s.email, s.store) },
  {
    module: "lib/lesson-comments.ts",
    run: async (s) => {
      let records = 0;
      for (const c of s.courses) records += await forgetLessonCommentsPerson(c.courseId, c.lessonIds, s.learner, s.store);
      return records;
    },
  },
  { module: "lib/lesson-notes.ts", run: (s) => forgetLessonNotesPerson(s.statsId, s.learner, s.store) },
  { module: "lib/community-erasure.ts", run: (s) => (s.communityId ? forgetCommunityPerson(s.communityId, s.learner, s.email, s.productIds) : Promise.resolve(0)) },
  { module: "lib/waitlist.ts", run: (s) => forgetWaitlistPerson(s.statsId, s.productIds, s.email) },
  { module: "lib/affiliate-bond.ts", run: (s) => forgetBondPerson(s.statsId, s.email) },
  { module: "lib/affiliate-leads.ts", run: (s) => forgetLeadPerson(s.store, s.email) },
  { module: "lib/imported-purchases.ts", only: "person", run: (s) => forgetImportedPerson(s.statsId, s.email) },
  { module: "lib/podcast-access.ts", run: (s) => forgetPodcastPerson(s.store, s.productIds, s.email) },
  { module: "lib/welcome-offer-send.ts", run: (s) => forgetWelcomePerson(s.statsId, s.email) },
  { module: "lib/winback-send.ts", run: (s) => forgetWinbackPerson(s.statsId, s.productIds, s.email) },
  { module: "lib/checkout-recovery.ts", run: (s) => forgetRecoveryPerson(s.statsId, s.productIds, s.email) },
  { module: "lib/assistant-reminder.ts", run: (s) => forgetAssistReminderPerson(s.statsId, s.email) },
  { module: "lib/move-members.ts", run: (s) => forgetInvitesPerson(s.store, s.productIds, s.email) },
  { module: "lib/inbox.ts", run: (s) => forgetInboxPerson(s.statsId, s.email) },
  {
    module: "lib/discord-access.ts",
    run: async (s, _files, notes) => {
      const done = await forgetDiscordPerson(s.store, s.email, s.productIds);
      if (done.rolesLeft) notes.add("discord-roles");
      return done.records;
    },
  },
  {
    module: "lib/email-sync.ts",
    run: async (s, _files, notes) => {
      if (s.store.emailSync) notes.add("email-platform");
      return forgetSyncPerson(s.statsId, s.email);
    },
  },
  { module: "lib/segments.ts", run: (s) => forgetLedgerCopy(s.statsId) },
  // The studio's kept reading of the sales names the biggest buyers by address (inbox C4-48): it goes, and is read again.
  { module: "lib/store-readings.ts", run: (s) => forgetReadingsPerson(s.statsId) },
  // The private calendar feed's kept file names who booked (review of #2111): it goes, and is made again.
  { module: "lib/calendar-sync.ts", run: (s) => forgetFeedCopyPerson(s.statsId) },
  { module: "lib/member-health.ts", run: (s) => forgetHealthCopy(s.store) },
  {
    module: "lib/reviews.ts",
    only: "person",
    run: async (s, files) => {
      // Each photo goes into `files` before its review's delete is tried, so a run that throws still deletes it. Their
      // name and words leave the store page's quotes before the reviews go (lib/store-quotes.ts); when that fails, this
      // part fails and the reviews are kept for the retry.
      const done = await forgetReviewsPerson(s.statsId, s.productIds, s.email, s.store, files, (reviews) => dropReviewQuotes(s.store, reviews));
      // Then the quotes are kept again from the reviews as they now stand, under the store's lock, even when this run
      // found none: a review an earlier run deleted is not found again, a refresh that read one before its delete has
      // written by now, and other buyers' quotes taken off above come back. When they cannot be kept, they are all
      // taken off; this part fails only when that is not confirmed either.
      await keepStoreQuotes(s.store);
      return done.records;
    },
  },
  // The month's summary of what customers say quotes their reviews (rule 28): it goes after them, and a reading under way is not kept.
  { module: "lib/customer-voice.ts", run: (s) => forgetVoicePerson(s.statsId) },
  { module: "lib/buyer-library.ts", run: (s) => forgetLibraryPerson(s.sid, s.email) },
  { module: "lib/erasure-index.ts", run: (s) => forgetNoted(s.statsId, s.email) },
  { module: "lib/contacts.ts", after: ["lib/mail-clicks.ts"], run: (s) => forgetContactPerson(s.listId, s.email) },
];

export type ErasureResult =
  | { ok: true; parts: ErasedPart[]; records: number; notes: ErasureNote[] }
  | { ok: false; reason: "email" | "unavailable" | "limit"; message?: string }
  | { ok: false; reason: "incomplete"; parts: ErasedPart[]; failed: string[] };

/** Works out where one person may be found in one store. */
export async function erasureScope(store: Store, email: string): Promise<ErasureScope | null> {
  const ref = storeRef(store);
  let current: Store | null = store;
  if (!current.statsId) current = await ensureStatsId(ref);
  if (current && !current.listId) current = await ensureListId(ref);
  if (!current?.statsId || !current.listId) return null;
  const listings = await readKindExact(current, "course");
  const courseOf = new Map(listings.flatMap((l) => (l.course?.id ? [[l.course.id, l.id] as const] : [])));
  // Read exactly (rule 24): an outline kept but unreadable throws, so the deletion answers "unavailable" and is
  // pressed again, never done with the person's records in that course still kept; only a confirmed absent one is left out.
  const courses = await readCoursesExact([...courseOf.keys()]);
  return {
    store: current,
    sid: current.sid,
    statsId: current.statsId,
    listId: current.listId,
    email,
    person: personKey(current.statsId, email),
    learner: emailKey(email),
    courses: [...courses.values()].map((course) => ({
      productId: courseOf.get(course.id) ?? "",
      courseId: course.id,
      lessonIds: course.modules.flatMap((m) => m.lessons.map((l) => l.id)),
      moduleIds: course.modules.map((m) => m.id),
    })),
    productIds: current.catalog.items.map((item) => item.id),
    communityId: current.community?.id ?? null,
  };
}

/** How big this erasure is: the store's catalogue and courses, and the few things counted to know it. */
export async function erasureSize(scope: ErasureScope): Promise<ErasureSize> {
  const id = scope.communityId;
  const [deals, conversations, dmConversations, roomMessages, events, certificates] = await Promise.all([
    dealCount(scope.statsId),
    conversationCount(scope.statsId),
    id ? dmCount(id, scope.learner) : 0,
    id ? roomSize(id) : 0,
    id ? eventCount(id) : 0,
    certificateCount(scope.courses.map((c) => c.courseId)),
  ]);
  return {
    products: scope.productIds.length,
    courses: scope.courses.length,
    lessons: scope.courses.reduce((sum, c) => sum + c.lessonIds.length, 0),
    deals,
    conversations,
    dmConversations,
    roomMessages,
    events,
    certificates,
  };
}

/**
 * Deletes one person from one store. `by` says which door: the team, with
 * who pressed it and their role for the activity log, or the person.
 */
export async function erasePerson(
  store: Store,
  rawEmail: string,
  by: { kind: Extract<ErasureBy, "team">; who: string; role: Role } | { kind: Extract<ErasureBy, "person"> },
): Promise<ErasureResult> {
  const email = normaliseEmail(typeof rawEmail === "string" ? rawEmail : "");
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return { ok: false, reason: "email" };
  if (!isRedisConfigured()) return { ok: false, reason: "unavailable" };
  // What the store's record says, before anything is read.
  const first = erasureUnits({ products: store.catalog.items.length, courses: idsOfKind(store, "course").length });
  const taken = await takeAllowance(store, "studio", first);
  if (!taken.ok) return { ok: false, reason: taken.reason === "used" ? "limit" : "unavailable", message: taken.message };
  const scope = await erasureScope(store, email).catch(() => null);
  if (!scope) return { ok: false, reason: "unavailable" };
  // Then the rest, once the courses are read and the counts taken.
  const size = await erasureSize(scope).catch(() => null);
  if (!size) return { ok: false, reason: "unavailable" };
  const rest = erasureUnits(size) - first;
  if (rest > 0) {
    const more = await takeAllowance(store, "studio", rest);
    if (!more.ok) return { ok: false, reason: more.reason === "used" ? "limit" : "unavailable", message: more.message };
  }

  // First, and on its own: whatever happens next, they are never written to again. Its second is Redis's (ERASED_PRINT).
  await redisPipeline([suppressCommand(scope.listId as string, email)]);

  const parts: ErasedPart[] = [];
  const failed: string[] = [];
  const files: string[] = [];
  const notes = new Set<ErasureNote>();
  for (const eraser of ERASERS) {
    if (eraser.only && eraser.only !== by.kind) continue;
    if (eraser.after?.some((module) => failed.includes(module))) {
      failed.push(eraser.module);
      continue;
    }
    try {
      parts.push({ module: eraser.module, records: await eraser.run(scope, files, notes) });
    } catch (error) {
      console.error(`deleting a person: ${eraser.module} could not finish`, error);
      failed.push(eraser.module);
    }
  }
  if (files.length) {
    const unique = [...new Set(files)];
    // Deleted now; if the file store does not answer, handed to the daily job
    // that deletes uploads nobody kept (app/api/cron/courses), so they go
    // within a day by themselves.
    await deleteFile(unique).catch(async (error: unknown) => {
      console.error("deleting a person: their files go with the daily job instead", error);
      for (const path of unique) await noteTaskUpload(path, 0);
    });
  }
  const records = parts.reduce((sum, p) => sum + p.records, 0);
  // The team's own deletions go in its activity log; a person's own is told to the owner by email (lib/erasure-request.ts).
  if (scope.sid && by.kind === "team") {
    await logTeam(scope.sid, { who: by.who, role: by.role, what: `People: deleted a person and everything kept about them (${records} ${records === 1 ? "record" : "records"})` });
  }
  if (failed.length) return { ok: false, reason: "incomplete", parts, failed };
  return { ok: true, parts, records, notes: [...notes] };
}
