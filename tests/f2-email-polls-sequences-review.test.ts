/**
 * 125 [F2-EMAIL-POLLS], unit 2: the pre-review findings on sequence rounds
 * (6 November 2026). Synthetic stores and addresses, the in-memory Redis
 * double and a stand-in sender only.
 *
 *   - No cascade: a list that keeps the most polls at once never has one
 *     deleted to make room for a round. A new round waits (the step is tried
 *     again later, never ended); a round already written down still goes.
 *   - The same fewest answers before totals show holds for a round.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { readPoll } from "@/lib/mail-poll";
import { MAX_POLLS_KEPT, openPoll } from "@/lib/mail-poll-votes";
import { stepCampaign } from "@/lib/mail-links";
import { MailPollResults } from "@/components/mail-poll-results";
import { NextRequest } from "next/server";
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
const POLL = "@poll Which lesson helped most?\n- The first one\n- The second one";
const OTHER = readPoll("@poll Another?\n- Yes\n- No")!;
const hex24 = (n: number) => n.toString(16).padStart(24, "0");
const linksIn = (html: string) => [...html.matchAll(/href="([^"]*\/poll\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_seq_poll_review_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_seq_poll_review_only_a_stand_in";
  const OWNER = "seq-poll-review@example.com";
  await claimHandle(OWNER, "seq-poll-review", "Review Lessons", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSeqReview001", true);
  await setSubscription(OWNER, { customerId: "cus_SeqReview01", subscriptionId: "sub_SeqReview01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Review Lessons", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const step = "c000000000000001";
  const saved = await saveFlow(store, { name: "Lessons", trigger: "tagged", tag: "poll", steps: [{ id: step, delayHours: 0, subject: "Lesson poll", body: `Hi.\n\n${POLL}` }] });
  if (!saved.ok) throw new Error(`not saved: ${saved.reason}`);
  const flowId = saved.flows.find((f) => f.name === "Lessons")!.id;
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  for (const name of ["ana", "ben", "cy"]) await upsertContact(list, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const now = Math.floor(Date.now() / 1000);
  const sentTo = (email: string) => mail.sent.find((m) => m.to.includes(email) && m.subject === "Lesson poll");

  part("A round already written down still goes when the list is full, and nothing is deleted");
  await enroll(store, "ana@example.com", { joined: false, tag: "poll" });
  await run();
  is("ana got the round", linksIn(sentTo("ana@example.com")?.html ?? "").length, 2);
  for (let i = 1; i < MAX_POLLS_KEPT; i += 1) await openPoll(list, store.handle, hex24(i), OTHER, now);
  const kept = async () => Number(((await redis.pipeline([["ZCARD", `nl:mpoll:ix:${list}`]])) as [number])[0]);
  is("the list keeps the most", await kept(), MAX_POLLS_KEPT);
  await enroll(store, "ben@example.com", { joined: false, tag: "poll" });
  await run();
  is("ben got the same round", linksIn(sentTo("ben@example.com")?.html ?? "").length, 2);
  const fillers = (await redis.pipeline(Array.from({ length: MAX_POLLS_KEPT - 1 }, (_, i) => ["EXISTS", `nl:mpoll:${list}:${hex24(i + 1)}`]))) as number[];
  is("every other poll is still there", fillers.every((n) => Number(n) === 1), true);

  part("A new round on a full list waits; nothing kept is deleted for it");
  // The round's record leaves (as when its time is over); the list stays full of other kept polls.
  const [round] = (await redis.pipeline([["ZREVRANGE", `nl:mpoll:ix:${list}`, 0, -1]])) as [string[]];
  const roundId = round.find((id) => !/^0{12}/.test(id))!;
  await redis.pipeline([["DEL", `nl:mpoll:${list}:${roundId}`, `nl:mpoll:v:${list}:${roundId}`], ["ZREM", `nl:mpoll:ix:${list}`, roundId]]);
  await openPoll(list, store.handle, hex24(MAX_POLLS_KEPT), OTHER, now);
  await enroll(store, "cy@example.com", { joined: false, tag: "poll" });
  const counted = await run();
  const after = (await redis.pipeline(Array.from({ length: MAX_POLLS_KEPT }, (_, i) => ["EXISTS", `nl:mpoll:${list}:${hex24(i + 1)}`]))) as number[];
  is("cy got nothing yet, and the step waits rather than ending", [Boolean(sentTo("cy@example.com")), counted.sent, counted.dropped], [false, 0, 0]);
  is("no kept poll was deleted for the round", after.every((n) => Number(n) === 1), true);

  part("A round's totals show only from the fewest answers");
  redis.clear();
  const again = await claimHandle(OWNER, "seq-poll-review", "Review Lessons", "");
  if (!again.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSeqReview001", true);
  await setSubscription(OWNER, { customerId: "cus_SeqReview01", subscriptionId: "sub_SeqReview01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Review Lessons", address: "1 Main St, Portland, OR 97201" });
  store = (await storeForEmail(OWNER))!;
  const list2 = store.listId as string;
  const saved2 = await saveFlow(store, { name: "Lessons", trigger: "tagged", tag: "poll", steps: [{ id: step, delayHours: 0, subject: "Lesson poll", body: `Hi.\n\n${POLL}` }] });
  if (!saved2.ok) throw new Error(`not saved: ${saved2.reason}`);
  const flow2 = saved2.flows.find((f) => f.name === "Lessons")!.id;
  await setFlowActive(store, flow2, true);
  store = (await storeForEmail(OWNER))!;
  await upsertContact(list2, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  mail.clearCaptured();
  await enroll(store, "dee@example.com", { joined: false, tag: "poll" });
  await run();
  const link = linksIn(sentTo("dee@example.com")?.html ?? "")[0] ?? "https://x/";
  const response = await pollPost(new NextRequest(`https://marktmorgen.com/api/mail/poll${new URL(link).search}`, { method: "POST", body: new URLSearchParams({ do: "vote" }), headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.40" } }));
  is("dee answered", new URL(response.headers.get("location") ?? "https://x/").searchParams.get("done"), "recorded");
  const html = renderToStaticMarkup(await MailPollResults({ listId: list2, subjects: new Map([[stepCampaign(flow2, step), "Lesson poll"]]) }));
  is("one answer: the round under its step, no count, no share", [html.includes("Lesson poll"), html.includes("Totals show once 5 people have answered."), /\(\d+%\)/.test(html)], [true, true, false]);

  mail.restore();
  done();
}

void main();
