/**
 * 750 [CD1] unit 6: the buyer is told when the creator replies to a file
 * they sent for review. lib/submission-notice.ts is the real one, on the
 * in-memory Redis, with the one email it sends caught instead of sent. What
 * is checked:
 *
 *   - one email for a reply, to the buyer's own address, counted against the
 *     store's own emails (the meter lib/email.ts takes from before it sends),
 *     from the store's course sender, with an honest subject, the creator's
 *     reply, the way back to the lesson, why it came, and the creator's name
 *     and postal address when the store has one; a text and an HTML version,
 *     the HTML with the page's language, the reply escaped, and no image, so
 *     no tracking pixel; in the store's language;
 *   - a reply is emailed once: a second call sends nothing, also after a send
 *     that did not go (spent allowance), since a send that may have gone is
 *     never repeated; a mark that cannot be read sends nothing;
 *   - an address that bounced, complained, or was deleted from the store is
 *     skipped; one that only left the creator's list is still told, since
 *     this is about their own file; a check that cannot be read sends nothing;
 *   - nothing for a file that was not answered;
 *   - the studio's reply route tells the buyer and says whether the email
 *     went, inside the studio requests it already takes;
 *   - on the lesson page, a reply this device has not shown yet carries a
 *     "New reply" badge, in words, and the list says how many are new.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SUBMISSION_NOTICE_COMMANDS,
  SUBMISSION_TOLD_SECONDS,
  type NoticeMessage,
  noticeSender,
  replyNoticeMessage,
  tellBuyerOfReply,
} from "@/lib/submission-notice";
import * as notice from "@/lib/submission-notice";
import * as review from "@/components/submission-review";
import { courseSender } from "@/lib/learn";
import { freshReplyIds, readSeenReplies, seenRepliesKey, seenRepliesValue } from "@/lib/submission-upload";
import { SUBMISSIONS_WORDS } from "@/lib/buyer-words/submissions";
import type { KeptSubmission } from "@/lib/submission-store";
import { leadsKey } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const NOW = Math.floor(Date.now() / 1000);
const STORE = {
  handle: "anasgym",
  name: "Ana's Gym",
  sid: "notice-0",
  statsId: "c".repeat(32),
  email: "owner@example.test",
  listId: "list0001",
  language: "en",
  tier: "creator",
  subscriptionActive: true,
  mail: { fromName: "Ana Lima", address: "12 Main St, Austin, TX 78701, USA" },
} as unknown as Store;

let n = 0;
function kept(over: Partial<KeptSubmission> = {}): KeptSubmission {
  n += 1;
  const id = n.toString(16).padStart(32, "0");
  return {
    id,
    target: { kind: "lesson", courseId: "course0001ab", lessonId: "lesson0001ab" },
    buyer: `buyer${n}@example.com`,
    file: { name: "squat.mp4", bytes: 5_000_000, type: "video/mp4" },
    note: "My first try.",
    at: NOW - 3_600,
    keepUntil: NOW + 30 * 86_400,
    state: "reviewed",
    reply: { text: "Knees out a little more. <b>Good</b> depth & pace.", file: null, at: NOW },
    closedAt: NOW,
    path: `vault/${FOLDER}/sub_${id}/0000000000000001-squat.mp4`,
    who: "a".repeat(32),
    folder: FOLDER,
    ...over,
  };
}

const sent: NoticeMessage[] = [];
let answer = true;
const send = async (message: NoticeMessage) => {
  sent.push(message);
  return answer;
};
const where = { productId: "prod1", productTitle: "Strong in 30 Days", lessonTitle: "The squat" };

async function main(): Promise<void> {
  part("One email for a reply, from the store's own emails");
  const first = kept();
  is("it is sent", await tellBuyerOfReply({ store: STORE, ...where, submission: first }, send), "sent");
  is("exactly one", sent.length, 1);
  const mail = sent[0];
  is("to the buyer's own address", mail.to, first.buyer);
  is("counted against the store's own emails, taken before it is sent", mail.meter, { by: "store", store: STORE, kind: "email" });
  is("from the store's course sender", mail.from.startsWith('"Ana\'s Gym via Marktmorgen" <'), true);
  is("the same From line as every course email (lib/learn.ts)", [mail.from, noticeSender({ name: 'A "quoted" <name>\r\n' })], [courseSender(STORE), courseSender({ name: 'A "quoted" <name>\r\n' } as Store)]);
  is("an honest subject", mail.subject, "Ana's Gym replied to your work on “The squat”");
  is("the lead says which file and where", mail.text.startsWith("Ana's Gym reviewed squat.mp4, the file you sent for “The squat” in Strong in 30 Days."), true);
  is("the reply, whole", mail.text.includes("Knees out a little more. <b>Good</b> depth & pace."), true);
  is("the way back to the lesson", mail.text.includes("https://marktmorgen.com/@anasgym/course/prod1/lesson0001ab#submission"), true);
  is("why it came", mail.text.includes("You get this email because you sent this file for review."), true);
  is("the creator's name and postal address", mail.text.includes("Ana Lima · 12 Main St, Austin, TX 78701, USA"), true);
  is("who sent it", mail.text.trimEnd().endsWith("Sent by Marktmorgen on behalf of Ana's Gym."), true);
  is("a once-only key for the sender", mail.idempotencyKey, `submission-reply:${FOLDER}:${first.id}`);
  is("an HTML version too", typeof mail.html, "string");
  const html = mail.html ?? "";
  is("in the page's language", html.includes('<html lang="en-US">'), true);
  is("the reply escaped, never markup", html.includes("&lt;b&gt;Good&lt;/b&gt; depth &amp; pace.") && !html.includes("<b>Good</b>"), true);
  is("no image, so no tracking pixel", /<img|background-image|url\(/i.test(html), false);
  is("a link that says where it goes", html.includes(">Open “The squat”</a>"), true);
  is("the postal address in the HTML", html.includes("Ana Lima · 12 Main St, Austin, TX 78701, USA"), true);
  const plain = replyNoticeMessage({ store: { ...STORE, mail: undefined } as unknown as Store, ...where, submission: first });
  is("no postal address line when the store has none", plain.text.includes(" · "), false);

  part("Once, and never twice");
  is("a second call for the same reply sends nothing", await tellBuyerOfReply({ store: STORE, ...where, submission: first }, send), "already");
  is("still one email", sent.length, 1);
  const told = await redis.pipeline([["TTL", `nl:sub:told:${FOLDER}:${first.id}`]]);
  is("the mark is kept for its time", (told[0] as number) > 0 && (told[0] as number) <= SUBMISSION_TOLD_SECONDS, true);
  answer = false;
  const spent = kept();
  is("a send that did not go (allowance spent) says so", await tellBuyerOfReply({ store: STORE, ...where, submission: spent }, send), "unsent");
  answer = true;
  is("and is never tried again: it may have gone", await tellBuyerOfReply({ store: STORE, ...where, submission: spent }, send), "already");
  is("two tries, one a refusal", sent.length, 2);

  part("Addresses that cannot or may not be written to are skipped");
  const contact = (gone: string) => JSON.stringify({ agreed: true, unsub: true, unsubAt: "2026-11-01T00:00:00Z", gone });
  for (const gone of ["bounced", "complained"]) {
    const s = kept();
    await redis.pipeline([["HSET", leadsKey("list0001"), s.buyer, contact(gone)]]);
    is(`an address that ${gone} is skipped`, await tellBuyerOfReply({ store: STORE, ...where, submission: s }, send), "stopped");
  }
  const erased = kept();
  await redis.pipeline([suppressCommand("list0001", erased.buyer, NOW)]);
  is("an address deleted from the store is skipped", await tellBuyerOfReply({ store: STORE, ...where, submission: erased }, send), "stopped");
  is("none of them was sent", sent.length, 2);
  const left = kept();
  await redis.pipeline([["HSET", leadsKey("list0001"), left.buyer, JSON.stringify({ agreed: true, unsub: true, unsubAt: "2026-11-01T00:00:00Z" })]]);
  is("one who only left the creator's list is still told about their own file", await tellBuyerOfReply({ store: STORE, ...where, submission: left }, send), "sent");
  is("so three emails", sent.length, 3);
  const broken = kept();
  await redis.pipeline([["HSET", leadsKey("list0001"), broken.buyer, "{broken"]]);
  is("a contact that does not read is unknown: nothing sent", await tellBuyerOfReply({ store: STORE, ...where, submission: broken }, send), "unknown");
  const pipeline = redis.pipeline.bind(redis);
  const odd = kept();
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HEXISTS")) return [null, "1"];
    return pipeline(commands);
  }) as typeof redis.pipeline;
  is("a check answered in another shape is unknown: nothing sent", await tellBuyerOfReply({ store: STORE, ...where, submission: odd }, send), "unknown");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:sub:told:"))) return ["MAYBE"];
    if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:sub:told:"))) return [null];
    return pipeline(commands);
  }) as typeof redis.pipeline;
  is("a mark that cannot be read is unknown: nothing sent", await tellBuyerOfReply({ store: STORE, ...where, submission: kept() }, send), "unknown");
  redis.pipeline = pipeline;
  is("still three emails", sent.length, 3);

  part("Nothing for a file that was not answered");
  is("waiting", await tellBuyerOfReply({ store: STORE, ...where, submission: kept({ state: "submitted", reply: null, closedAt: 0 }) }, send), "none");
  is("withdrawn", await tellBuyerOfReply({ store: STORE, ...where, submission: kept({ state: "withdrawn", reply: null }) }, send), "none");
  is("no address", await tellBuyerOfReply({ store: STORE, ...where, submission: kept({ buyer: "not an address" }) }, send), "none");
  is("still three", sent.length, 3);

  part("Its Redis commands, at most");
  let commands = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands += batch.length;
    return pipeline(batch);
  }) as typeof redis.pipeline;
  await tellBuyerOfReply({ store: STORE, ...where, submission: kept() }, send);
  redis.pipeline = pipeline;
  is("inside SUBMISSION_NOTICE_COMMANDS (the email's own allowance take is lib/email.ts's)", commands <= SUBMISSION_NOTICE_COMMANDS, true);

  part("In the store's language");
  const pt = replyNoticeMessage({ store: { ...STORE, language: "pt" } as unknown as Store, ...where, submission: first });
  is("the subject", pt.subject, "Ana's Gym respondeu ao seu trabalho em «The squat»");
  is("the page's language", pt.html.includes('<html lang="pt-PT">'), true);
  for (const [code, words] of Object.entries(SUBMISSIONS_WORDS)) {
    const said = [words.mailSubject("S", "L"), words.mailLead("S", "f", "L", "C"), words.mailWrote("S"), words.mailOpen, words.mailOpenLink("L"), words.mailWhy, words.mailSentBy("S"), words.newReply, words.newReplies(2)];
    is(`${code}: every word of the email and the badge is there`, said.every((t) => typeof t === "string" && t.length > 0), true);
  }

  part("The studio's reply tells the buyer");
  const route = readFileSync(join(process.cwd(), "app/api/store/course/submissions/route.ts"), "utf8");
  is("after the reply is kept, the buyer is told", /replySubmission\([\s\S]*tellBuyerOfReply\(/.test(route), true);
  is("and the studio is told whether the email went", route.includes("emailed: emailedAnswer(told)"), true);
  const studio = readFileSync(join(process.cwd(), "components/submission-review.tsx"), "utf8");
  is("the studio says so in words", studio.includes("replySavedNotice(data.emailed)"), true);

  part("Whether the buyer was emailed is never guessed (review rule of #3571/#3574: unknown is never said as done)");
  // A sender that answered false may still have sent it (lib/email.ts: an Amazon answer that did not say), and
  // a mark already taken may stand for a send that went or did not: neither is "sent", neither is "none went".
  const answerOf = (notice as Record<string, unknown>).emailedAnswer as ((told: string) => unknown) | undefined;
  const answered = (told: string) => (typeof answerOf === "function" ? answerOf(told) : "missing");
  is("sent: the buyer was emailed", answered("sent"), true);
  is("a send the sender did not confirm: unknown, never 'no email went'", answered("unsent"), "unknown");
  is("a mark taken before: unknown", answered("already"), "unknown");
  is("nothing tried (skipped, nothing to tell, a check that did not read): no email went", ["stopped", "none", "unknown"].map(answered), [false, false, false]);
  const savedOf = (review as Record<string, unknown>).replySavedNotice as ((emailed: unknown) => string) | undefined;
  const saved = (emailed: unknown) => (typeof savedOf === "function" ? savedOf(emailed) : "missing");
  is("emailed: said so", saved(true), "Reply saved with the file. The buyer was emailed.");
  is("none went: said so, with where they will see it", saved(false), "Reply saved with the file. No email went to the buyer this time, so they will see it when they open the lesson.");
  for (const [label, emailed] of [["unknown", "unknown"], ["missing", undefined], ["another shape", "yes"]] as const) {
    const words = saved(emailed);
    is(`${label}: neither 'was emailed' nor 'no email went'`, /was emailed|No email went/.test(words), false);
    is(`${label}: says it could not be confirmed, and where they will see it`, words, "Reply saved with the file. We could not confirm whether the buyer was emailed, so they will see it when they open the lesson.");
  }
  is("the check before sending does not promise an email that may not go", studio.includes("and the buyer is emailed about it once."), false);
  is("it says when none goes", studio.includes("unless your store&rsquo;s emails for this month are used up or their address cannot get email"), true);

  part("On the lesson page, a reply not shown yet is marked");
  const rows = [
    { id: "1".repeat(32), state: "reviewed", reply: { text: "a", at: 1 } },
    { id: "2".repeat(32), state: "reviewed", reply: { text: "b", at: 2 } },
    { id: "3".repeat(32), state: "submitted", reply: null },
    { id: "4".repeat(32), state: "unread" },
  ];
  is("nothing seen on this device: every reply is new", [...freshReplyIds(rows, readSeenReplies(null))], ["1".repeat(32), "2".repeat(32)]);
  is("one seen: the other is new", [...freshReplyIds(rows, readSeenReplies(JSON.stringify(["1".repeat(32)])))], ["2".repeat(32)]);
  is("a remembered list that does not read: no badge, never a guess", readSeenReplies("{broken"), null);
  is("so nothing is marked new", freshReplyIds(rows, null).size, 0);
  is("only ids are kept, never another value", readSeenReplies(JSON.stringify(["x", 3])), null);
  is("what this device remembers: the replies it has shown", JSON.parse(seenRepliesValue(rows)), ["1".repeat(32), "2".repeat(32)]);
  is("one key per lesson", seenRepliesKey({ handle: "anasgym", product: "prod1", lesson: "lesson0001ab" }), "mm:submission-replies:anasgym:prod1:lesson0001ab");
  const box = readFileSync(join(process.cwd(), "components/lesson-submission.tsx"), "utf8");
  is("the badge is said in words, not color alone", box.includes("{w.newReply}"), true);
  is("the list says how many are new", box.includes("w.newReplies("), true);
  is("the browser's storage is read and written only inside try", /try \{[^}]*localStorage\.getItem/.test(box) && /try \{[^}]*localStorage\.setItem/.test(box), true);
  is("the email's link lands on the box", box.includes('id="submission"'), true);
  is("English", [SUBMISSIONS_WORDS.en.newReply, SUBMISSIONS_WORDS.en.newReplies(1), SUBMISSIONS_WORDS.en.newReplies(3)], ["New reply", "1 new reply since this device last showed this list.", "3 new replies since this device last showed this list."]);
  done();
}

main().then(
  () => undefined,
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
