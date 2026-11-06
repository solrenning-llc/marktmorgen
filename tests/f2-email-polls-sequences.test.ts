/**
 * 125 [F2-EMAIL-POLLS], unit 2: a poll in a sequence's email, end to end
 * against the in-memory Redis double and a stand-in sender, synthetic stores
 * and addresses only.
 *
 *   - A sequence's email may hold a whole poll; one written wrong is refused
 *     when the sequence is saved, with the designer's own words.
 *   - Sent: each reader gets their own signed links, as in a one-off email;
 *     the poll is the step's, one a 30-day round, and the id names the
 *     round and the words, so an edited poll is a new one and no answer is
 *     ever read against other words.
 *   - A round takes answers until 30 days after its last day, so every
 *     reader has at least 30 days; it is gone whole 30 days after it closes,
 *     never more than 90 days after its first email.
 *   - A later email of the same round adds one small read and nothing else;
 *     a read that cannot be confirmed sends nothing, and the step waits.
 *   - The studio shows the round's totals under the step's subject; the
 *     person's answers go with them.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { flowConfigurationIssues } from "@/lib/flow-review";
import { stepCampaign } from "@/lib/mail-links";
import { pollProblem, readPoll } from "@/lib/mail-poll";
import { POLL_OPEN_DAYS, POLL_RECORD_BYTES, SEQUENCE_POLL_KEEP_DAYS, SEQUENCE_POLL_ROUND_DAYS, forgetPollPerson, pollAnswersOf, pollResults, sequencePollId, voterOf } from "@/lib/mail-poll-votes";
import { MailPollResults } from "@/components/mail-poll-results";
import { POST as pollPost } from "@/app/api/mail/poll/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

const DAY = 86_400;
const POLL = "@poll Which lesson helped most?\n- The first one\n- The second one";
const STEP_BODY = `Thanks for joining.\n\n${POLL}\n\nSee you soon.`;
const STEP = "b000000000000001";

async function press(link: string, action: "vote" | "withdraw" = "vote"): Promise<string> {
  const url = new URL(link);
  const response = await pollPost(new NextRequest(`https://marktmorgen.com/api/mail/poll${url.search}`, { method: "POST", body: new URLSearchParams({ do: action }), headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.9" } }));
  const location = response.headers.get("location") ?? "";
  return location ? new URL(location).searchParams.get("done") ?? "" : "";
}
const linksIn = (html: string) => [...html.matchAll(/href="([^"]*\/poll\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_seq_polls_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_seq_polls_only_a_stand_in";

  const OWNER = "seq-poll-owner@example.com";
  await claimHandle(OWNER, "seq-poll-cove", "Cove Lessons", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSeqPoll0001", true);
  await setSubscription(OWNER, { customerId: "cus_SeqPoll0001", subscriptionId: "sub_SeqPoll0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Cove Lessons", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const context = { flows: [], products: [], courses: [], forms: [], stages: [], fields: [] } as never;

  part("Saved: a whole poll goes in a sequence; a broken one is refused, saying why");
  const seq = (body: string) => ({ id: "f", name: "Seq", trigger: "joined", active: false, steps: [{ id: STEP, delayHours: 0, subject: "Your first week", body }] }) as never;
  is("a whole poll raises no issue", flowConfigurationIssues(seq(STEP_BODY), context).some((issue) => issue.toLowerCase().includes("poll")), false);
  const broken = "@poll Which?\n- Only one";
  is("a broken one raises the designer's own words", flowConfigurationIssues(seq(broken), context).some((issue) => issue.includes(pollProblem(broken) as string)), true);
  is("a broken one is refused when saved", await saveFlow(store, { name: "Broken", trigger: "tagged", tag: "poll", steps: [{ id: STEP, delayHours: 0, subject: "Hi", body: broken }] }), { ok: false, reason: "step" });
  const saved = await saveFlow(store, { name: "Welcome", trigger: "tagged", tag: "poll", steps: [{ id: STEP, delayHours: 0, subject: "Your first week", body: STEP_BODY }] });
  is("a whole one is saved", saved.ok, true);
  const flowId = saved.ok ? saved.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  const campaign = stepCampaign(flowId, STEP);

  part("The round: the step's poll, one a round, named by its words");
  const poll = readPoll(STEP_BODY)!;
  const now = Math.floor(Date.now() / 1000);
  const roundStart = Math.floor(now / (SEQUENCE_POLL_ROUND_DAYS * DAY)) * SEQUENCE_POLL_ROUND_DAYS * DAY;
  const id = sequencePollId(list, campaign, poll, now);
  is("an id like a one-off email's", /^[0-9a-f]{24}$/.test(id ?? ""), true);
  is("the same all round", sequencePollId(list, campaign, poll, roundStart + SEQUENCE_POLL_ROUND_DAYS * DAY - 1), id);
  is("a new one the next round", sequencePollId(list, campaign, poll, roundStart + SEQUENCE_POLL_ROUND_DAYS * DAY) === id, false);
  is("a new one when the words change", sequencePollId(list, campaign, { ...poll, answers: [...poll.answers, "The third one"] }, now) === id, false);
  is("a new one in another step", sequencePollId(list, stepCampaign(flowId, "b000000000000002"), poll, now) === id, false);
  is("only a sequence's own email has one", sequencePollId(list, "b-0123456789abcdef01234567", poll, now), null);
  is("a round is bounded: open 30 days past its last day, gone 30 days after, 90 days in all at the most", [POLL_OPEN_DAYS, SEQUENCE_POLL_ROUND_DAYS + POLL_OPEN_DAYS + SEQUENCE_POLL_KEEP_DAYS <= 90], [30, true]);

  part("Sent: each reader's own links");
  for (const name of ["ana", "ben", "cy"]) await upsertContact(list, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  mail.clearCaptured();
  await enroll(store, "ana@example.com", { joined: false, tag: "poll" });
  await enroll(store, "ben@example.com", { joined: false, tag: "poll" });
  await run();
  const sentTo = (email: string) => mail.sent.find((m) => m.to.includes(email) && m.subject === "Your first week");
  const anaMail = sentTo("ana@example.com");
  const benMail = sentTo("ben@example.com");
  is("both got the step", [Boolean(anaMail), Boolean(benMail)], [true, true]);
  const anaLinks = linksIn(anaMail?.html ?? "");
  const benLinks = linksIn(benMail?.html ?? "");
  is("two answer links each, their own", [anaLinks.length, benLinks.length, anaLinks.some((link) => benLinks.includes(link))], [2, 2, false]);
  is("signed for the reader and the round's poll", [new URL(anaLinks[0] ?? "https://x/").searchParams.get("v"), new URL(anaLinks[0] ?? "https://x/").searchParams.get("p")], [voterOf(list, "ana@example.com"), id]);
  is("no raw poll line and no pixel", [anaMail?.html.includes("@poll"), anaMail?.text.includes("@poll"), /<img/i.test(anaMail?.html ?? "")], [false, false, false]);
  const key = `nl:mpoll:${list}:${id}`;
  const [raw, ttl] = (await redis.pipeline([["GET", key], ["TTL", key]])) as [string | null, number];
  const record = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const closes = roundStart + (SEQUENCE_POLL_ROUND_DAYS + POLL_OPEN_DAYS) * DAY;
  is("the round's poll is written down, the step named", [record.q, record.c, record.closes, record.u], [poll.question, campaign, closes, closes + SEQUENCE_POLL_KEEP_DAYS * DAY]);
  is("every reader has at least 30 days to answer", closes - now >= POLL_OPEN_DAYS * DAY, true);
  is("it is gone whole when the round's keeping ends, 90 days at the most", ttl > 0 && ttl <= closes + SEQUENCE_POLL_KEEP_DAYS * DAY - now + 1 && ttl <= 90 * DAY, true);
  is("its record fits the bytes counted for it", Buffer.byteLength(raw ?? "") <= POLL_RECORD_BYTES, true);

  part("A later email of the round: one small read, nothing more");
  const pipe = redis.pipeline;
  const touched: (string | number)[][] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    touched.push(...commands.filter((c) => String(c[1] ?? "").startsWith("nl:mpoll:")));
    return pipe.call(redis, commands);
  }) as typeof redis.pipeline;
  await enroll(store, "cy@example.com", { joined: false, tag: "poll" });
  await run();
  redis.pipeline = pipe;
  const cyLinks = linksIn(sentTo("cy@example.com")?.html ?? "");
  is("cy got the same round's poll", [cyLinks.length, new URL(cyLinks[0] ?? "https://x/").searchParams.get("p")], [2, id]);
  is("with one EXISTS and nothing else", touched.map((c) => c[0]), ["EXISTS"]);

  part("Answered from the email, once, as in a one-off email");
  is("ana answers", await press(anaLinks[1]), "recorded");
  is("a second press is not kept", await press(anaLinks[0]), "already");
  is("ben answers", await press(benLinks[0]), "recorded");
  const votes = `nl:mpoll:v:${list}:${id}`;
  const [votesTtl] = (await redis.pipeline([["TTL", votes]])) as [number];
  is("its answers go with the round", votesTtl > 0 && votesTtl <= closes + SEQUENCE_POLL_KEEP_DAYS * DAY - now + 1, true);
  const results = (await pollResults(list)) ?? [];
  is("the totals", results.map((r) => [r.id, r.total, r.answers.map((a) => a.count), r.campaign]), [[id, 2, [1, 1], campaign]]);

  part("A read that cannot be confirmed sends nothing");
  await upsertContact(list, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EXISTS" && String(c[1]).startsWith("nl:mpoll:"))) throw new Error("synthetic read failure");
    return pipe.call(redis, commands);
  }) as typeof redis.pipeline;
  await enroll(store, "dee@example.com", { joined: false, tag: "poll" });
  const counted = await run();
  redis.pipeline = pipe;
  is("dee got nothing, and the step waits to be tried again rather than ending", [Boolean(sentTo("dee@example.com")), counted.sent, counted.dropped], [false, 0, 0]);

  part("The studio: the round's totals under the step's subject");
  const html = renderToStaticMarkup(await MailPollResults({ listId: list, subjects: new Map([[campaign, "Your first week"]]) }));
  is("the question, the step and the totals", [html.includes("Which lesson helped most?"), html.includes("Your first week"), html.includes("The first one: 1 (50%)"), html.includes("sequence")], [true, true, true, true]);
  is("never who answered", [html.includes("ana"), html.includes("ben@")], [false, false]);

  part("Privacy: the person's answers go with them");
  is("in the copy", await pollAnswersOf(list, "ana@example.com"), [{ question: poll.question, answer: "The second one" }]);
  is("erased", await forgetPollPerson(list, "ana@example.com"), 1);
  is("gone from the totals", (await pollResults(list))?.[0]?.total, 1);

  mail.restore();
  done();
}

void main();
