/**
 * 125 [F2-EMAIL-POLLS], unit 1: a poll in a one-off email, end to end
 * against the in-memory Redis double and a stand-in sender, synthetic stores
 * and addresses only.
 *
 *   - The block: a question and 2 to 5 different answers, bounded; anything
 *     written like a poll and not one stops the email, saying why; one poll
 *     an email; a sequence refuses one.
 *   - Sent: each reader's copy has its own signed answer links, real links
 *     with the answer's own words (buttons at least 44 px tall), the text
 *     version lists each answer with its link, and no pixel; sending records
 *     nothing.
 *   - The page records nothing when opened (a scanner answers nothing); the
 *     button does, once a reader; a second press is "already"; a changed
 *     link records nothing; a taken-back answer is gone and can be given
 *     again; a closed poll takes nothing; a write that cannot be confirmed
 *     never says "recorded".
 *   - The studio shows totals only; the person's answers go with them, are in
 *     their copy, and the store's keys are named by its list.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast } from "@/lib/broadcasts";
import { MAX_POLL_ANSWER, MAX_POLL_ANSWERS, MAX_POLL_QUESTION, POLL_STARTER, hasPoll, pollOnWeb, pollPreviewBody, pollProblem, readPoll } from "@/lib/mail-poll";
import { forgetPollPerson, pollAnswersOf, pollResults, voterOf } from "@/lib/mail-poll-votes";
import { flowConfigurationIssues } from "@/lib/flow-review";
import { hasPlaceholder } from "@/lib/mail-body";
import { PERSON_DATA } from "@/lib/person-data";
import { ERASERS } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { CLOSING } from "@/lib/data-families";
import { MailPollResults } from "@/components/mail-poll-results";
import PollPage from "@/app/poll/page";
import { POST as pollPost } from "@/app/api/mail/poll/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "poll-owner@example.com";
const delivery = installSesMailFixture();
const POLL = "@poll What should I make next?\n- A video course\n- A printable guide\n- A template pack";
const BODY = `Hello, readers.\n\n${POLL}\n\nThank you for reading.`;

async function page(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await PollPage({ searchParams: Promise.resolve(query) }));
}
async function press(link: string, action: "vote" | "withdraw" = "vote"): Promise<{ status: number; done: string }> {
  const url = new URL(link);
  const form = new URLSearchParams({ do: action });
  const response = await pollPost(new NextRequest(`https://marktmorgen.com/api/mail/poll${url.search}`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.7" } }));
  const location = response.headers.get("location") ?? "";
  return { status: response.status, done: location ? new URL(location).searchParams.get("done") ?? "" : "" };
}
const queryOf = (link: string, extra: Record<string, string> = {}) => ({ ...Object.fromEntries(new URL(link).searchParams), ...extra });
const linksIn = (html: string) => [...html.matchAll(/href="([^"]*\/poll\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function main(): Promise<void> {
  redis.clear();
  delivery.configure();
  delivery.reset();
  process.env.RESEND_API_KEY = "re_test_mail_polls_only_a_stand_in";

  part("The block: bounded, whole, one an email");
  is("a poll is read", readPoll(BODY), { question: "What should I make next?", answers: ["A video course", "A printable guide", "A template pack"] });
  is("a whole poll has no problem", pollProblem(BODY), null);
  is("one answer is refused", pollProblem("@poll Which?\n- Only one") !== null, true);
  is(`more than ${MAX_POLL_ANSWERS} answers are refused`, pollProblem(`@poll Which?\n${Array.from({ length: MAX_POLL_ANSWERS + 1 }, (_, i) => `- Answer ${i}`).join("\n")}`) !== null, true);
  is("a question too long is refused", pollProblem(`@poll ${"q".repeat(MAX_POLL_QUESTION + 1)}\n- Yes\n- No`) !== null, true);
  is("an answer too long is refused", pollProblem(`@poll Which?\n- ${"a".repeat(MAX_POLL_ANSWER + 1)}\n- No`) !== null, true);
  is("the same answer twice is refused", pollProblem("@poll Which?\n- Yes\n- yes") !== null, true);
  is("square brackets in an answer are refused", pollProblem("@poll Which?\n- [Yes]\n- No") !== null, true);
  is("two polls are refused", pollProblem(`${POLL}\n\n@poll Another?\n- Yes\n- No`) !== null, true);
  is("a poll line inside a paragraph is refused", pollProblem("Some words\n@poll Which?\n- Yes\n- No") !== null, true);
  is("a line that only looks like one is refused", pollProblem("@polls are fun") !== null, true);
  is("an email with no poll has no problem", [pollProblem("Hello.\n\n- a point\n- another"), hasPoll("Hello.")], [null, false]);
  is("the designer's new poll cannot go until written", [hasPlaceholder(POLL_STARTER), hasPoll(POLL_STARTER)], [true, true]);
  is("on the web, the poll is its question and answers, no link", [pollOnWeb(BODY).includes("@poll"), pollOnWeb(BODY).includes("/poll?"), pollOnWeb(BODY).includes("- A printable guide")], [false, false, true]);
  is("a preview's buttons lead to the preview page only", [...pollPreviewBody(BODY).matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]), Array(3).fill("https://marktmorgen.com/poll?preview=1"));
  is("a sequence's email with a poll is refused before it is saved", flowConfigurationIssues({ id: "f", name: "Seq", trigger: "joined", active: false, steps: [{ id: "s1", delayHours: 0, subject: "Hi", body: POLL }] } as never, { flows: [], products: [], courses: [], forms: [], stages: [], fields: [] } as never).some((issue) => issue.includes("poll")), true);

  part("Sent: each reader's own links, real links, no pixel");
  const made = await claimHandle(OWNER, "poll-harbor", "Harbor Polls", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PollOwner01", subscriptionId: "sub_PollOwner01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Polls", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  for (const name of ["ana", "ben"]) await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const broken = await createBroadcast(store, { subject: "Poll", body: "@poll Which?\n- Only one", productId: "", notProductId: "", sendAt: undefined });
  is("a broken poll is refused when the email is made", broken.ok ? "made" : broken.reason, "poll");
  const created = await createBroadcast(store, { subject: "Help me choose", body: BODY, productId: "", notProductId: "", sendAt: undefined });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  delivery.clearCaptured();
  const sent = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  is("it went to both", [sent.status, delivery.sent.flatMap((m) => m.to).sort()], ["sent", ["ana@example.com", "ben@example.com"]]);
  const anaMail = delivery.sent.find((m) => m.to.includes("ana@example.com"))!;
  const benMail = delivery.sent.find((m) => m.to.includes("ben@example.com"))!;
  const anaLinks = linksIn(anaMail.html);
  const benLinks = linksIn(benMail.html);
  is("three answer links each", [anaLinks.length, benLinks.length], [3, 3]);
  is("each reader's links are their own", anaLinks.some((link) => benLinks.includes(link)), false);
  is("each link is signed for its reader", [new URL(anaLinks[0]).searchParams.get("v"), new URL(benLinks[0]).searchParams.get("v")], [voterOf(listId, "ana@example.com"), voterOf(listId, "ben@example.com")]);
  is("no address in a link", anaLinks.some((link) => link.includes("ana") || link.includes("%40")), false);
  is("the answers are links with their own words", ["A video course", "A printable guide", "A template pack"].every((answer) => new RegExp(`<a href="[^"]*/poll\\?[^"]*"[^>]*>${answer}</a>`).test(anaMail.html)), true);
  is("as buttons at least 44 px tall (12 px padding around a 25.6 px line)", /<a href="[^"]*\/poll\?[^"]*" style="display:inline-block;padding:12px 22px/.test(anaMail.html), true);
  is("the question is a heading", anaMail.html.includes(">What should I make next?</h2>"), true);
  is("the email says who sees what", anaMail.html.includes("never who picked what"), true);
  is("no pixel and no raw poll line", [/<img/i.test(anaMail.html), anaMail.html.includes("@poll"), anaMail.text.includes("@poll")], [false, false, false]);
  is("the text version lists each answer with its link", anaLinks.every((link, i) => anaMail.text.includes(`${["A video course", "A printable guide", "A template pack"][i]}: ${link}`)), true);
  is("sending recorded no answer", (await pollResults(listId))?.[0]?.total, 0);

  part("Opening the page records nothing; the button does, once");
  const opened = await page(queryOf(anaLinks[1]));
  is("the page shows the answer and a button that posts", [opened.includes("Your answer: A printable guide"), /<form action="\/api\/mail\/poll\?[^"]*" method="post"/.test(opened), opened.includes("Send my answer")], [true, true, true]);
  is("the page offers the other answers as links", ["A video course", "A template pack"].every((answer) => opened.includes(`>${answer}</a>`)), true);
  is("opening it recorded nothing", (await pollResults(listId))?.[0]?.total, 0);
  const tampered = anaLinks[1].replace(/s=([0-9a-f])/, (_, c) => `s=${c === "0" ? "1" : "0"}`);
  is("a changed signature is not a link", [(await press(tampered)).status, (await pollResults(listId))?.[0]?.total], [404, 0]);
  const swapped = anaLinks[1].replace(/v=[0-9a-f]{32}/, `v=${new URL(benLinks[1]).searchParams.get("v")}`);
  is("another reader's key with this signature is not a link", (await press(swapped)).status, 404);
  is("an unknown link records nothing and says so", (await page(queryOf(tampered))).includes("This link does not work"), true);
  const first = await press(anaLinks[1]);
  is("the button records it", [first.status, first.done], [303, "recorded"]);
  is("the page then thanks, read back", (await page(queryOf(anaLinks[1], { done: "recorded" }))).includes("Thank you. Your answer is recorded."), true);
  const second = await press(anaLinks[2]);
  is("a second answer is not kept", second.done, "already");
  is("and the page says the first one", (await page(queryOf(anaLinks[2], { done: "recorded" }))).includes("You already answered this poll"), true);
  is("the totals count one answer", (await pollResults(listId))?.[0]?.answers.map((a) => a.count), [0, 1, 0]);
  is("an address saying recorded for an answer not kept does not thank", (await page(queryOf(anaLinks[0], { done: "recorded" }))).includes("Thank you"), false);

  part("Taken back, and given again");
  is("taking it back", (await press(anaLinks[1], "withdraw")).done, "withdrawn");
  is("it is gone", (await pollResults(listId))?.[0]?.total, 0);
  is("the page says so", (await page(queryOf(anaLinks[1], { done: "withdrawn" }))).includes("Your answer was taken back"), true);
  is("given again", (await press(anaLinks[0])).done, "recorded");
  is("ben answers too", (await press(benLinks[0])).done, "recorded");

  part("A write that cannot be confirmed never says recorded");
  const pipe = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HSETNX")) throw new Error("synthetic write failure");
    return pipe.call(redis, commands);
  }) as typeof redis.pipeline;
  const lost = await press(benLinks[2].replace(/v=[0-9a-f]{32}&s=[0-9a-f]{32}/, new URL(anaLinks[0]).search.match(/v=[0-9a-f]{32}&s=[0-9a-f]{32}/)![0]));
  redis.pipeline = pipe;
  is("failed, not recorded", lost.done, "failed");
  is("its page says it could not be recorded", (await page(queryOf(anaLinks[0], { done: "failed" }))).includes("could not be recorded"), true);

  part("Closed: nothing more is taken");
  const key = `nl:mpoll:${listId}:${created.broadcast.id}`;
  const [raw] = (await redis.pipeline([["GET", key]])) as [string];
  const record = JSON.parse(raw) as Record<string, number>;
  await redis.pipeline([["SET", key, JSON.stringify({ ...record, closes: Math.floor(Date.now() / 1000) - 1 }), "KEEPTTL"]]);
  is("a press after it closed", (await press(benLinks[1], "withdraw")).done, "closed");
  is("the page says closed", (await page(queryOf(benLinks[1]))).includes("This poll is closed"), true);

  part("The studio shows totals only");
  const html = renderToStaticMarkup(await MailPollResults({ listId, subjects: new Map([[created.broadcast.id, "Help me choose"]]) }));
  is("the question, the subject and each total", [html.includes("What should I make next?"), html.includes("Help me choose"), html.includes("A video course: 2 (100%)"), html.includes("2 answers")], [true, true, true, true]);
  is("never who answered", [html.includes("ana"), html.includes("ben@"), html.includes(voterOf(listId, "ana@example.com") as string)], [false, false, false]);

  part("Privacy: copied, erased with the person and with the store");
  is("registered", [PERSON_DATA.some((d) => d.file === "lib/mail-poll-votes.ts" && d.how === "erased"), ERASERS.some((e) => e.module === "lib/mail-poll-votes.ts"), COPY_PLAN["lib/mail-poll-votes.ts"]?.how, typeof COPIERS["lib/mail-poll-votes.ts"]], [true, true, "copied", "function"]);
  is("in the person's copy", await pollAnswersOf(listId, "ana@example.com"), [{ question: "What should I make next?", answer: "A video course" }]);
  is("erased with the person", await forgetPollPerson(listId, "ana@example.com"), 1);
  is("gone from the totals and the copy", [(await pollResults(listId))?.[0]?.total, (await pollAnswersOf(listId, "ana@example.com")).length], [1, 0]);
  is("every key is erased when the store closes", ["nl:mpoll:", "nl:mpoll:ix:", "nl:mpoll:v:"].map((family) => CLOSING[family]?.how), ["erase", "erase", "erase"]);

  delivery.restore();
  done();
}

void main();
