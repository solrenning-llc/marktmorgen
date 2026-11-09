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
 *   elsewhere it is not kept by Marktmorgen at all but on the creator's own
 *             account elsewhere (Stripe), and the copy says where to ask;
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
import { readDeals, readFields, readPersonTasks, readStages, readValues } from "@/lib/crm";
import { readPersonNotes } from "@/lib/buyer-profile";
import { readForms, readResponses } from "@/lib/form-store";
import { listRequests } from "@/lib/payment-request-store";
import { listAgreements, readVersionExact } from "@/lib/agreement-store";
import { doneLessons, studentDates } from "@/lib/learn";
import { attemptOf, passedQuizzes } from "@/lib/quiz";
import { isUnreadSubmission, submissionsOf } from "@/lib/assignment";
import { certificatesOf } from "@/lib/certificate";
import { lessonComments } from "@/lib/lesson-comments";
import { bondRecordOf } from "@/lib/affiliate-bond";
import { leadOf } from "@/lib/affiliate-leads";
import { importedFrom, importedKey } from "@/lib/imported-purchases";
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
import { memberTraces, readMember as readCommunityMember } from "@/lib/community";
import { pointsRecordOf } from "@/lib/community-points";
import { allNoticesOf } from "@/lib/community-notify";
import { benefitMarksOf } from "@/lib/tier-benefits";
import { deviceCount } from "@/lib/community-push";
import { conversationsOf } from "@/lib/community-dm";
import { chatMessagesOf } from "@/lib/community-chat";
import { rsvpsOf } from "@/lib/community-events";
import { votesOf } from "@/lib/community-polls";
import { keysOf } from "@/lib/licence-keys";
import { paypalOrdersOf } from "@/lib/paypal-sales";
import { preordersOf } from "@/lib/preorders";
import { toldOf } from "@/lib/closing-buyers";
import { paidCheckoutsOf } from "@/lib/person-copy-stripe";
import { readGift } from "@/lib/gifts";
import { isGroupJob, readGroup } from "@/lib/group-buy";
import { packagesKey, readBought } from "@/lib/call-packages";
import { readShipped } from "@/lib/shipments";
import { callScope, readRecords } from "@/lib/meet-records";
import { heldPaymentsOf } from "@/lib/closing-holds";
import { shipmentMailOf } from "@/lib/shipment-mail-outbox";
import { orderConfirmationMailOf } from "@/lib/order-confirmation-outbox";
import type { PaidCheckout } from "@/lib/person-copy-stripe";

export type CopyHow = "copied" | "marks" | "elsewhere" | "pending";

/** What the copy does with each module the erasure reaches, said in a few words to the person. */
export const COPY_PLAN: Readonly<Record<string, { how: CopyHow; what: string }>> = {
  "lib/shipment-mail-outbox.ts": { how: "copied", what: "Your saved shipping-update messages and their pending state, if the queue has been activated; deletion fences are kept as one-way marks" },
  "lib/order-confirmation-outbox.ts": { how: "copied", what: "Your linked purchase confirmations, original payment reference, amount and pending state, if the queue has been activated; erasure and duplicate-prevention fences are kept as one-way marks" },
  "lib/resend-fallback-budget.ts": { how: "marks", what: "Linked financial send-intent and message fingerprints, quota holds and outcome marks, without a plain address or message; no account-wide ledger of other people's sends is included" },
  "lib/orders.ts": { how: "marks", what: "Order-reference and accounting fingerprints that prevent counting a payment twice; they contain no plain email message and do not prove delivery" },
  "lib/flows.ts": { how: "copied", what: "Which of the store's sequences and workflows you are in, and each step taken" },
  "lib/mail-clicks.ts": { how: "copied", what: "Which of the store's sequence emails you used a link in" },
  "lib/mail-health.ts": { how: "marks", what: "A mark that your address was counted in this week's delivery checks, with nothing else in it" },
  "lib/crm.ts": { how: "copied", what: "The store's fields about you, its deals with you, and the tasks its team wrote about you" },
  "lib/payment-request-store.ts": { how: "copied", what: "Payment requests the store sent you" },
  "lib/agreement-store.ts": { how: "copied", what: "Proposals and agreements the store sent you, each version's text, and your signature" },
  "lib/buyer-profile.ts": { how: "copied", what: "Notes the store's team wrote about you" },
  "lib/form-store.ts": { how: "copied", what: "Your answers to the store's forms" },
  "lib/learn.ts": { how: "copied", what: "Your progress in the store's courses: when you began and came back, and the lessons you finished. The browsers let in with your address and the drip emails already sent are kept as marks" },
  "lib/course-finish.ts": { how: "marks", what: "Marks that you opened and finished a course; the lessons you finished are in your course progress" },
  "lib/quiz.ts": { how: "copied", what: "Your quiz tries, answers, results and passes" },
  "lib/assignment.ts": { how: "copied", what: "Work you handed in, and the store's feedback on it" },
  "lib/certificate.ts": { how: "copied", what: "Your certificates" },
  "lib/lesson-comments.ts": { how: "copied", what: "Your comments under lessons" },
  "lib/community-erasure.ts": { how: "copied", what: "Your community profile, points, notifications, private messages, what you said in its room, the events you said you are coming to, and your posts, comments, likes, votes and reports" },
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
  "lib/store-readings.ts": { how: "marks", what: "A day's copy of the store's sales numbers, which may name its biggest buyers, made from its Stripe account" },
  "lib/calendar-sync.ts": { how: "marks", what: "A copy of the store's private booking calendar, which may name you if you booked, made from its bookings" },
  "lib/member-health.ts": { how: "marks", what: "A ten-minute copy of the store's members' scores, made from its Stripe account" },
  "lib/reviews.ts": { how: "copied", what: "Your reviews, and the store's replies to them" },
  "lib/customer-voice.ts": { how: "marks", what: "The store's monthly summary of what its customers said, which may quote your review words without your name; your reviews themselves are in this copy" },
  "lib/buyer-library.ts": { how: "copied", what: "The note that you bought from or joined the store, for your library" },
  "lib/erasure-index.ts": { how: "marks", what: "Links the store emailed you that still work (stop, waitlist, review, free-product and sign-up links)" },
  // What the erasure keeps on purpose (lib/person-data.ts, "kept"): still theirs to see.
  "lib/affiliates.ts": { how: "marks", what: "Commissions an affiliate earned on your purchases, which name the sale and not you" },
  "lib/community-dm.ts": { how: "marks", what: "Another member's choice not to get your messages, which is theirs and names nobody's address" },
  "lib/paypal-sales.ts": { how: "copied", what: "Your PayPal orders: the product, the amount, the date and the box you checked before paying" },
  "lib/licence-keys.ts": { how: "copied", what: "License keys you bought, and the sale each came from" },
  "lib/gifts.ts": { how: "copied", what: "Gifts you bought or were given" },
  "lib/group-buy.ts": { how: "copied", what: "Places bought for a group that you bought or were given" },
  "lib/preorders.ts": { how: "copied", what: "Your pre-orders and what became of them" },
  "lib/call-packages.ts": { how: "copied", what: "Packages of calls you bought, and the sessions left" },
  "lib/meet-records.ts": { how: "copied", what: "Your place on a booked group call's guest list" },
  "lib/shipments.ts": { how: "copied", what: "When your physical orders were shipped, and their tracking links" },
  "lib/closing-buyers.ts": { how: "copied", what: "While the store is closing: that you were emailed it closes" },
  "lib/closing-holds.ts": { how: "copied", what: "While the store is closing: your membership's last payment, kept to give back the time you paid for" },
  "lib/closing-plan-guard.ts": { how: "marks", what: "Nothing about buyers: only the creator's own plan, if one was paid while the store was closing" },
  "lib/stripe-account.ts": { how: "elsewhere", what: "Your payments are on the creator's own Stripe account, not kept by Marktmorgen: your receipts and the store can give you them" },
  "lib/tier-benefits.ts": { how: "copied", what: "Which membership benefits the store marked as handed to you, and for which month or year" },
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
  /** What is held elsewhere, not by Marktmorgen, and where. */
  elsewhere: string[];
};

const iso = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000).toISOString() : "");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Copier = (scope: ErasureScope) => Promise<unknown[]>;

/** The person's paid checkouts in this store, read once per copy from the creator's Stripe account; a copy that cannot read them whole fails. */
const checkoutsRead = new WeakMap<ErasureScope, Promise<PaidCheckout[]>>();
function checkoutsOf(s: ErasureScope): Promise<PaidCheckout[]> {
  let read = checkoutsRead.get(s);
  if (!read) {
    read = paidCheckoutsOf(s.store, s.email).then((list) => {
      if (list === null) throw new Error("the person's payments could not be read in full from the store's Stripe account");
      return list;
    });
    checkoutsRead.set(s, read);
  }
  return read;
}

/** What an import, a gift or a place gave them here, read as it is kept (lib/imported-purchases.ts). */
const grantsOf = async (s: ErasureScope) => importedFrom((await redisPipeline([["HGETALL", importedKey(s.statsId, s.email)]]))[0]);

/** One reader per copied module, each only reading. */
export const COPIERS: Readonly<Record<string, Copier>> = {
  "lib/shipment-mail-outbox.ts": s => shipmentMailOf(s.statsId, s.email),
  "lib/order-confirmation-outbox.ts": s => orderConfirmationMailOf(s.statsId, s.email),
  "lib/contacts.ts": async (s) => {
    if (!s.listId) return [];
    const [raw] = await redisPipeline([["HGET", leadsKey(s.listId), s.email]]);
    const contact = parseContact(raw);
    return contact ? [{ email: s.email, ...contact }] : [];
  },
  "lib/crm.ts": async (s) => {
    const [fields, stages, tasks] = await Promise.all([readFields(s.statsId), readStages(s.statsId), readPersonTasks(s.statsId, s.person)]);
    const values = await readValues(s.statsId, s.person, fields);
    const deals = (await readDeals(s.statsId, stages)).filter((d) => d.email && same(d.email, s.email));
    const stageName = new Map(stages.map((st) => [st.id, st.name]));
    return [
      ...fields.filter((f) => values[f.id]).map((f) => ({ field: f.name, value: values[f.id] })),
      // Who of the team the deal is given to is that teammate's, not yours.
      ...deals.map((d) => ({ deal: d.title, stage: stageName.get(d.stage) ?? "", value: d.cents, note: d.note, nextAction: d.nextAction ?? "", dueDate: d.dueDate ?? "", created: iso(d.createdAt), updated: iso(d.updatedAt) })),
      // The team's tasks about you (639 [GL7](6)), at most MAX_PERSON_TASKS; the teammate responsible is theirs, left out.
      ...tasks.map((t) => ({ task: t.text, dueDate: t.due, done: t.done, created: iso(t.createdAt), doneAt: iso(t.doneAt) })),
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
      for (const mark of a.versions) versions.push({ ...mark, ...((await readVersionExact(a, mark.n)) ?? {}) });
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
      const attempts = await Promise.all(c.lessonIds.map((lessonId) => attemptOf(c.courseId, lessonId, s.learner)));
      const tried = c.lessonIds.flatMap((lessonId, i) => (attempts[i].used > 0 || attempts[i].last ? [{ lesson: lessonId, tries: attempts[i].used, best: attempts[i].best, passed: attempts[i].passed, last: attempts[i].last }] : []));
      if (passed.size || tried.length) out.push({ course: c.productId, quizzesPassed: [...passed], attempts: tried });
    }
    return out;
  },
  "lib/assignment.ts": async (s) => {
    const out: unknown[] = [];
    for (const c of s.courses) {
      const subs = await submissionsOf(c.courseId, c.lessonIds.map((lessonId) => ({ lessonId, who: s.learner })));
      subs.forEach((sub, i) => {
        if (!sub) return;
        // A record that is there but does not read is said, never left out of the copy (CX-123 rule 24).
        if (isUnreadSubmission(sub)) {
          out.push({ course: c.productId, lesson: c.lessonIds[i], unread: "Work you handed in is kept for this lesson, but its record could not be read for this copy." });
          return;
        }
        out.push({ course: c.productId, lesson: c.lessonIds[i], text: sub.text, file: sub.file?.name ?? "", handedIn: iso(sub.at), state: sub.state, tries: sub.tries, feedback: sub.feedback, reviewed: iso(sub.reviewedAt) });
      });
    }
    return out;
  },
  // Withdrawn ones too: the erasure deletes them, so they are kept about the person.
  "lib/certificate.ts": async (s) => certificatesOf(s.courses.map((c) => c.courseId), s.email),
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
    const affiliate = await bondRecordOf(s.statsId, s.email);
    return affiliate ? [{ affiliate }] : [];
  },
  // Only their own field (leadOf): another person's lead that does not read never blocks this copy; theirs throws.
  "lib/affiliate-leads.ts": async (s) => {
    const lead = await leadOf(s.store, s.email);
    return lead && lead.email && same(lead.email, s.email) ? [lead] : [];
  },
  // Read whether or not the store still lets imported buyers in (importedFor asks that, and notes them as it reads).
  "lib/imported-purchases.ts": async (s) => importedFrom((await redisPipeline([["HGETALL", importedKey(s.statsId, s.email)]]))[0]),
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
  "lib/tier-benefits.ts": async (s) => (await benefitMarksOf(s.store, s.person)).map((m) => ({ benefit: m.benefit, period: m.period, markedGiven: iso(m.at) })),
  "lib/podcast-access.ts": async (s) => (await feedsOf(s.store, s.productIds, s.email)).map((product) => ({ product, privateFeed: true })),
  "lib/assistant-reminder.ts": async (s) => (await remindersOf(s.statsId, s.email)).map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
  "lib/email-sync.ts": async (s) => syncJobsOf(s.statsId, s.email),
  "lib/community-erasure.ts": async (s) => {
    const id = s.communityId;
    if (!id) return [];
    const who = s.learner;
    const member = await readCommunityMember(id, who);
    const [points, notices, devices, conversations, room, events, traces] = await Promise.all([
      pointsRecordOf(id, who),
      allNoticesOf(id, who),
      deviceCount(id, who),
      conversationsOf(id, who),
      chatMessagesOf(id, who),
      rsvpsOf(id, who),
      memberTraces(id, who),
    ]);
    const votes = await votesOf(id, who, traces.pollPosts);
    const { pollPosts: _polls, ...wrote } = traces;
    void _polls;
    const record = {
      // The link in their announcement emails is a key, left out: they have it in those emails.
      profile: member ? { email: member.e, name: member.n, handle: member.h, inDirectory: member.dir, announcementEmails: member.mail, joined: iso(member.at), lastSeen: iso(member.seen), muted: member.muted } : null,
      points,
      // What happened, on which post, and when; not who did it, which is theirs.
      notifications: notices.map((n) => ({ kind: n.kind, post: n.post, ...(n.comment ? { comment: n.comment } : {}), at: iso(n.at) })),
      devicesNotified: devices,
      privateMessages: conversations.map((c) => ({ request: c.request, messages: c.messages.map((m) => ({ from: m.mine ? "you" : m.fromCreator ? "the creator" : "the other member", text: m.text, at: iso(m.at) })) })),
      room: room.map((m) => ({ text: m.text, at: iso(m.at) })),
      events: events.map((e) => ({ event: e.event, at: iso(e.at) })),
      posts: wrote.posts.map((p) => ({ ...p, at: iso(p.at), edited: iso(p.edited) })),
      comments: wrote.comments.map((c) => ({ ...c, at: iso(c.at), edited: iso(c.edited) })),
      likedPosts: wrote.likedPosts,
      likedComments: wrote.likedComments,
      reported: wrote.reported,
      votes,
    };
    const empty = !member && points.total === 0 && !notices.length && !devices && !conversations.length && !room.length && !events.length && !votes.length && Object.values(wrote).every((list) => !list.length);
    return empty ? [] : [record];
  },
  "lib/licence-keys.ts": async (s) => (await keysOf(s.store, s.productIds, s.email)).map((k) => ({ product: k.product, key: k.key, sale: k.reference, given: iso(k.at), revoked: iso(k.revokedAt), revokedBy: k.revokedBy })),
  "lib/paypal-sales.ts": async (s) => paypalOrdersOf(s.statsId, s.productIds, s.email),
  "lib/preorders.ts": async (s) => (await preordersOf(s.store, s.productIds, s.email)).map((p) => ({ ...p, at: iso(p.at), ...(p.given ? { given: iso(p.given) } : {}), ...(p.revoked ? { revoked: iso(p.revoked) } : {}) })),
  "lib/closing-buyers.ts": async (s) => {
    const told = await toldOf(s.store, s.email);
    return told ? [{ toldTheStoreCloses: told.toldAt ? iso(told.toldAt) : "not yet" }] : [];
  },
  "lib/gifts.ts": async (s) => {
    const bought = (await checkoutsOf(s)).map((c) => c.meta.gift).filter((id): id is string => Boolean(id));
    const received = (await grantsOf(s)).map((g) => g.job).filter((job) => job.startsWith("gift:")).map((job) => job.slice(5));
    const out: unknown[] = [];
    for (const id of [...new Set(bought)]) {
      const gift = await readGift(id);
      // A gift they bought: they typed who it was for.
      if (gift) out.push({ youBought: true, product: gift.p, to: gift.to, from: gift.from, message: gift.message, at: iso(gift.at), ...(gift.given ? { given: iso(gift.given) } : {}), ...(gift.revoked ? { refunded: iso(gift.revoked) } : {}) });
    }
    for (const id of [...new Set(received)]) {
      const gift = await readGift(id);
      // A gift to them: the name and words the giver chose to send, not the giver's payment.
      if (gift) out.push({ youReceived: true, product: gift.p, from: gift.from, message: gift.message, at: iso(gift.at), ...(gift.given ? { given: iso(gift.given) } : {}), ...(gift.revoked ? { refunded: iso(gift.revoked) } : {}) });
    }
    return out;
  },
  "lib/group-buy.ts": async (s) => {
    const bought = (await checkoutsOf(s)).map((c) => c.meta.group).filter((id): id is string => Boolean(id));
    const taken = (await grantsOf(s)).map((g) => g.job).filter(isGroupJob).map((job) => job.slice(6));
    const out: unknown[] = [];
    // Who took the places they bought are those people's addresses, not theirs: the number is given.
    for (const id of [...new Set(bought)]) {
      const group = await readGroup(id);
      if (group) out.push({ youBought: true, product: group.p, places: group.people, at: iso(group.at), ...(group.paid ? { paid: iso(group.paid) } : {}) });
    }
    for (const id of [...new Set(taken)]) {
      const group = await readGroup(id);
      if (group) out.push({ youTookAPlace: true, product: group.p, at: iso(group.at) });
    }
    return out;
  },
  "lib/call-packages.ts": async (s) => {
    const [raw] = await redisPipeline([["SMEMBERS", packagesKey(s.statsId)]]);
    const out: unknown[] = [];
    for (const checkout of (Array.isArray(raw) ? raw : []).map(String)) {
      const bought = await readBought(checkout);
      // The booking link's token is a key, left out: they have it in the email that sent it.
      if (bought && same(bought.e, s.email)) out.push({ product: bought.p, sessions: bought.total, bought: iso(bought.at), bookBy: iso(bought.until), booked: bought.holds });
    }
    return out;
  },
  "lib/shipments.ts": async (s) => {
    const sessions = (await checkoutsOf(s)).map((c) => c.id);
    const shipped = sessions.length ? await readShipped(sessions) : new Map();
    return [...shipped.entries()].map(([checkout, record]) => ({ checkout, ...record }));
  },
  "lib/meet-records.ts": async (s) => {
    const callsId = s.store.callsId;
    if (!callsId) return [];
    const scopes = (await checkoutsOf(s)).flatMap((c) => {
      const start = Number(c.meta.start);
      if (!c.meta.product || !Number.isFinite(start) || start <= 0) return [];
      return [callScope(callsId, { group: false, session: c.id, product: c.meta.product, start }), callScope(callsId, { group: true, session: c.id, product: c.meta.product, start })];
    });
    if (!scopes.length) return [];
    // Only that they are on the guest list, never the other guests.
    return (await readRecords(scopes)).flatMap((record) => (record && record.guests.some((g) => same(g, s.email)) ? [{ product: record.product, group: record.group, link: record.link }] : []));
  },
  "lib/closing-holds.ts": async (s) => heldPaymentsOf(s.store, s.email),
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
  const elsewhere = Object.values(COPY_PLAN).filter((p) => p.how === "elsewhere").map((p) => p.what);
  return { store: { name: scope.store.name, handle: scope.store.handle }, email: scope.email, made: new Date(now).toISOString(), sections, marks, elsewhere };
}

export type { Store };
