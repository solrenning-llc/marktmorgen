/**
 * A copy of everything one store keeps about one person (619 [SZ3]): the
 * mirror of the erasure (lib/person-erasure.ts). The right of access and of
 * portability (GDPR arts. 15 and 20, UK GDPR, CCPA's right to know) asks
 * for the data itself, in a form a person can read and take elsewhere.
 *
 * Every module the erasure reaches is named in COPY_PLAN, with what the copy
 * does with it:
 *
 *   copied    its records about the person are read and put in the copy;
 *   marks     it keeps only marks with nothing in them to read (that a
 *             reminder was sent, a link that still works, a ten-minute
 *             cache made from Stripe), so the copy says what is held;
 *   pending   it keeps something the copy cannot read yet. While any module
 *             is pending, COPY_COMPLETE is false and no door gives the copy
 *             to anybody: a copy that leaves things out is not the copy the
 *             law asks for (tests/person-copy.test.ts).
 *
 * Only reading: every reader here is one that changes nothing the person or
 * the store would see (no "read" mark, no token made, no cache written).
 * What other people wrote is left out where it is theirs and not about the
 * person: a teammate's address on a note or a deal, who a conversation is
 * given to. What the store wrote to or about the person (a note, a reply,
 * feedback on their work) is in, because it is data about them.
 */
import { type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { type ErasureScope } from "@/lib/erasure-rules";
import { leadsKey, parseContact } from "@/lib/contacts";
import { readDeals, readFields, readStages, readValues } from "@/lib/crm";
import { readPersonNotes } from "@/lib/buyer-profile";
import { readForms, readResponses } from "@/lib/form-store";
import { listRequests } from "@/lib/payment-request-store";
import { listAgreements, readVersion } from "@/lib/agreement-store";
import { doneLessons, studentDates } from "@/lib/learn";
import { passedQuizzes } from "@/lib/quiz";
import { submissionsOf } from "@/lib/assignment";
import { certificateOf } from "@/lib/certificate";
import { lessonComments } from "@/lib/lesson-comments";
import { bondFor } from "@/lib/affiliate-bond";
import { readLeads } from "@/lib/affiliate-leads";
import { importedFor } from "@/lib/imported-purchases";
import { inviteField, readInvite } from "@/lib/move-members";
import { openConversation, readInbox } from "@/lib/inbox";
import { accountOf, readMember as readDiscordMember } from "@/lib/discord-store";
import { readReview, reviewId } from "@/lib/reviews";
import { storesKnownFor } from "@/lib/buyer-library";
import { readFlows, flowsStartedFor } from "@/lib/flows";
import { personOf, readRun } from "@/lib/flow-runs";
import { storeKey } from "@/lib/learn";
import { clicksOf } from "@/lib/mail-clicks";
import { waitlistPlacesOf } from "@/lib/waitlist";
import { feedsOf } from "@/lib/podcast-access";
import { remindersOf } from "@/lib/assistant-reminder";
import { syncJobsOf } from "@/lib/email-sync";

export type CopyHow = "copied" | "marks" | "pending";

/** What the copy does with each module the erasure reaches, said in a few words to the person. */
export const COPY_PLAN: Readonly<Record<string, { how: CopyHow; what: string }>> = {
  "lib/flows.ts": { how: "copied", what: "Which of the store's sequences and workflows you are in, and each step taken" },
  "lib/mail-clicks.ts": { how: "copied", what: "Which of the store's sequence emails you used a link in" },
  "lib/mail-health.ts": { how: "marks", what: "A mark that your address was counted in this week's delivery checks, with nothing else in it" },
  "lib/crm.ts": { how: "copied", what: "The store's fields about you, and its deals with you" },
  "lib/payment-request-store.ts": { how: "copied", what: "Payment requests the store sent you" },
  "lib/agreement-store.ts": { how: "copied", what: "Proposals and agreements the store sent you, each version's text, and your signature" },
  "lib/buyer-profile.ts": { how: "copied", what: "Notes the store's team wrote about you" },
  "lib/form-store.ts": { how: "copied", what: "Your answers to the store's forms" },
  "lib/learn.ts": { how: "copied", what: "Your progress in the store's courses" },
  "lib/course-finish.ts": { how: "marks", what: "Marks that you opened and finished a course; the lessons you finished are in your course progress" },
  "lib/quiz.ts": { how: "copied", what: "The quizzes you passed" },
  "lib/assignment.ts": { how: "copied", what: "Work you handed in, and the store's feedback on it" },
  "lib/certificate.ts": { how: "copied", what: "Your certificates" },
  "lib/lesson-comments.ts": { how: "copied", what: "Your comments under lessons" },
  "lib/community-erasure.ts": { how: "pending", what: "Your community profile, points, notifications, private messages, what you said in its room and your answers to its events" },
  "lib/waitlist.ts": { how: "copied", what: "Your places on the store's waitlists" },
  "lib/affiliate-bond.ts": { how: "copied", what: "Which affiliate brought you to the store" },
  "lib/affiliate-leads.ts": { how: "copied", what: "Sign-ups, free products and calls an affiliate was credited for" },
  "lib/imported-purchases.ts": { how: "copied", what: "What an import from another platform, a gift or a PayPal order gave you" },
  "lib/podcast-access.ts": { how: "copied", what: "Which products' private podcast feeds you have (the feed's secret address is in the email that sent it)" },
  "lib/welcome-offer-send.ts": { how: "marks", what: "When your welcome offer began, and that its reminder was set" },
  "lib/winback-send.ts": { how: "marks", what: "Marks that you heard a come-back offer about a product" },
  "lib/checkout-recovery.ts": { how: "marks", what: "Marks that you heard a checkout reminder about a product this week" },
  "lib/assistant-reminder.ts": { how: "copied", what: "A checkout reminder you asked for with the store's assistant box" },
  "lib/move-members.ts": { how: "copied", what: "Invitations to keep a membership you had elsewhere" },
  "lib/inbox.ts": { how: "copied", what: "Your conversations with the store's inbox" },
  "lib/discord-access.ts": { how: "copied", what: "Your Discord account's link to the store, and its roles" },
  "lib/email-sync.ts": { how: "copied", what: "The record of sending you to the store's connected email platform" },
  "lib/segments.ts": { how: "marks", what: "A ten-minute copy of the store's buyers, made from its Stripe account" },
  "lib/member-health.ts": { how: "marks", what: "A ten-minute copy of the store's members' scores, made from its Stripe account" },
  "lib/reviews.ts": { how: "copied", what: "Your reviews, and the store's replies to them" },
  "lib/buyer-library.ts": { how: "copied", what: "The note that you bought from or joined the store, for your library" },
  "lib/erasure-index.ts": { how: "marks", what: "Links the store emailed you that still work (stop, waitlist, review, free-product and sign-up links)" },
  "lib/contacts.ts": { how: "copied", what: "Your place on the store's list: your address, name, labels, what you asked for or bought, and whether you agreed to hear from it" },
};

/** True only when every module is copied or holds only marks: the condition for giving the copy to anybody. */
export const COPY_COMPLETE = Object.values(COPY_PLAN).every((p) => p.how !== "pending");

export type CopySection = { module: string; what: string; records: unknown[] };
export type PersonCopy = {
  store: { name: string; handle: string };
  email: string;
  /** When the copy was made (ISO 8601). */
  made: string;
  sections: CopySection[];
  /** What is held only as marks, said in words. */
  marks: string[];
};

const iso = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000).toISOString() : "");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Copier = (scope: ErasureScope) => Promise<unknown[]>;

/** One reader per copied module, each only reading. */
export const COPIERS: Readonly<Record<string, Copier>> = {
  "lib/contacts.ts": async (s) => {
    if (!s.listId) return [];
    const [raw] = await redisPipeline([["HGET", leadsKey(s.listId), s.email]]);
    const contact = parseContact(raw);
    return contact ? [{ email: s.email, ...contact }] : [];
  },
  "lib/crm.ts": async (s) => {
    const [fields, stages] = await Promise.all([readFields(s.statsId), readStages(s.statsId)]);
    const values = await readValues(s.statsId, s.person, fields);
    const deals = (await readDeals(s.statsId, stages)).filter((d) => d.email && same(d.email, s.email));
    const stageName = new Map(stages.map((st) => [st.id, st.name]));
    return [
      ...fields.filter((f) => values[f.id]).map((f) => ({ field: f.name, value: values[f.id] })),
      // Who of the team the deal is given to is that teammate's, not yours.
      ...deals.map((d) => ({ deal: d.title, stage: stageName.get(d.stage) ?? "", value: d.cents, note: d.note, nextAction: d.nextAction ?? "", dueDate: d.dueDate ?? "", created: iso(d.createdAt), updated: iso(d.updatedAt) })),
    ];
  },
  "lib/buyer-profile.ts": async (s) => (await readPersonNotes(s.statsId, s.person)).map((n) => ({ note: n.text, at: iso(n.at) })),
  "lib/form-store.ts": async (s) => {
    const out: unknown[] = [];
    for (const form of await readForms(s.statsId)) {
      const { responses } = await readResponses(s.statsId, form.id);
      for (const r of responses) {
        // The same rule the erasure deletes by: an answer that is the address (lib/form-store.ts, FORGET_FORM_PERSON).
        if (!Object.values(r.answers).some((a) => typeof a === "string" && same(a, s.email))) continue;
        const answers = Object.fromEntries(form.fields.map((f) => [f.label, r.answers[f.id] ?? ""]));
        out.push({ form: form.name, sent: iso(r.at), answers, ...(r.outcome ? { result: r.outcome } : {}), ...(typeof r.score === "number" ? { score: r.score } : {}) });
      }
    }
    return out;
  },
  "lib/payment-request-store.ts": async (s) => {
    const list = await listRequests(s.store);
    if (list === null) throw new Error("the payment requests could not be read");
    return list.filter((r) => same(r.email, s.email));
  },
  "lib/agreement-store.ts": async (s) => {
    const list = await listAgreements(s.store);
    if (list === null) throw new Error("the agreements could not be read");
    const out: unknown[] = [];
    for (const a of list.filter((a) => same(a.email, s.email))) {
      const versions = [];
      for (const mark of a.versions) versions.push({ ...mark, ...((await readVersion(a, mark.n)) ?? {}) });
      out.push({ ...a, versions });
    }
    return out;
  },
  "lib/learn.ts": async (s) => {
    const out: unknown[] = [];
    for (const c of s.courses) {
      const [dates, done] = await Promise.all([studentDates(c.courseId, s.email), doneLessons(c.courseId, s.email)]);
      if (!dates && done.size === 0) continue;
      out.push({ course: c.productId, since: iso(dates?.since ?? 0), lastSeen: iso(dates?.lastSeen ?? 0), lessonsDone: [...done] });
    }
    return out;
  },
  "lib/quiz.ts": async (s) => {
    const out: unknown[] = [];
    for (const c of s.courses) {
      const passed = await passedQuizzes(c.courseId, s.learner);
      if (passed.size) out.push({ course: c.productId, quizzesPassed: [...passed] });
    }
    return out;
  },
  "lib/assignment.ts": async (s) => {
    const out: unknown[] = [];
    for (const c of s.courses) {
      const subs = await submissionsOf(c.courseId, c.lessonIds.map((lessonId) => ({ lessonId, who: s.learner })));
      subs.forEach((sub, i) => {
        if (!sub) return;
        out.push({ course: c.productId, lesson: c.lessonIds[i], text: sub.text, file: sub.file?.name ?? "", handedIn: iso(sub.at), state: sub.state, tries: sub.tries, feedback: sub.feedback, reviewed: iso(sub.reviewedAt) });
      });
    }
    return out;
  },
  "lib/certificate.ts": async (s) => {
    const out: unknown[] = [];
    for (const c of s.courses) {
      const cert = await certificateOf(c.courseId, s.learner);
      if (cert) out.push(cert);
    }
    return out;
  },
  "lib/lesson-comments.ts": async (s) => {
    const out: unknown[] = [];
    for (const c of s.courses) {
      for (const lessonId of c.lessonIds) {
        // Only their own: the replies under them are other people's words.
        for (const comment of await lessonComments(c.courseId, lessonId)) if (comment.by === s.learner) out.push({ course: c.productId, lesson: lessonId, name: comment.name, text: comment.text, at: iso(comment.at) });
      }
    }
    return out;
  },
  "lib/affiliate-bond.ts": async (s) => {
    const affiliate = await bondFor(s.store, s.email);
    return affiliate ? [{ affiliate }] : [];
  },
  "lib/affiliate-leads.ts": async (s) => (await readLeads(s.store)).filter((l) => l.email && same(l.email, s.email)),
  "lib/imported-purchases.ts": async (s) => importedFor(s.store, s.email),
  "lib/move-members.ts": async (s) => {
    const out: unknown[] = [];
    for (const productId of s.productIds) {
      const invite = await readInvite(s.statsId, inviteField(s.email, productId));
      if (invite) out.push({ product: productId, ...invite });
    }
    return out;
  },
  "lib/inbox.ts": async (s) => {
    const out: unknown[] = [];
    for (const conversation of (await readInbox(s.statsId)).filter((c) => same(c.email, s.email))) {
      // Without the store: read, never marked as read.
      const thread = await openConversation(s.statsId, conversation.id);
      if (!thread) continue;
      out.push({
        name: conversation.name,
        started: iso(conversation.startedAt),
        // Which teammate wrote a reply is theirs; the reply is to you.
        messages: thread.messages.map((m) => ({ at: iso(m.at), from: m.from === "visitor" ? "you" : "the store", text: m.text })),
      });
    }
    return out;
  },
  "lib/discord-access.ts": async (s) => {
    const room = storeKey(s.store);
    const account = room ? await accountOf(room, s.email) : null;
    const member = room && account ? await readDiscordMember(room, account) : null;
    return member ? [member] : [];
  },
  "lib/reviews.ts": async (s) => {
    const out: unknown[] = [];
    for (const productId of s.productIds) {
      const review = await readReview(s.statsId, productId, reviewId(s.statsId, productId, s.email));
      if (review) out.push({ product: productId, ...review });
    }
    return out;
  },
  "lib/buyer-library.ts": async (s) => ((await storesKnownFor(s.email)).includes(s.sid) ? [{ inYourLibrary: true }] : []),
  "lib/mail-clicks.ts": async (s) => (await clicksOf(s.listId, s.email)).map((email) => ({ email })),
  "lib/waitlist.ts": async (s) => (await waitlistPlacesOf(s.statsId, s.productIds, s.email)).map((w) => ({ product: w.product, joined: iso(w.joined), confirmed: iso(w.confirmed), alsoAskedForNews: w.news })),
  "lib/podcast-access.ts": async (s) => (await feedsOf(s.store, s.productIds, s.email)).map((product) => ({ product, privateFeed: true })),
  "lib/assistant-reminder.ts": async (s) => (await remindersOf(s.statsId, s.email)).map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
  "lib/email-sync.ts": async (s) => syncJobsOf(s.statsId, s.email),
  "lib/flows.ts": async (s) => {
    const flows = await readFlows(s.listId);
    const started = new Set(await flowsStartedFor(flows, s.email));
    const out: unknown[] = [];
    for (const flow of flows) {
      const run = await readRun(flow.id, personOf(s.email));
      if (!run && !started.has(flow.id)) continue;
      out.push({ flow: flow.name, ...(run ? { run: run.run, steps: run.events } : {}) });
    }
    return out;
  },
};

/**
 * The copy for one person of one store, from its scope (lib/person-erasure.ts,
 * erasureScope). Each module's reader runs in turn; one that fails fails the
 * whole copy, so a copy is never handed over with a part silently missing.
 */
export async function copyPerson(scope: ErasureScope, now = Date.now()): Promise<PersonCopy> {
  const sections: CopySection[] = [];
  for (const [module, plan] of Object.entries(COPY_PLAN)) {
    if (plan.how !== "copied") continue;
    const copier = COPIERS[module];
    if (!copier) throw new Error(`no reader for ${module}`);
    const records = await copier(scope);
    if (records.length) sections.push({ module, what: plan.what, records });
  }
  const marks = Object.values(COPY_PLAN).filter((p) => p.how === "marks").map((p) => p.what);
  return { store: { name: scope.store.name, handle: scope.store.handle }, email: scope.email, made: new Date(now).toISOString(), sections, marks };
}

export type { Store };
