/**
 * 125 [F2-EMAIL-POLLS]: the pre-review findings on unit 1, each held
 * (6 November 2026). Synthetic stores and addresses, the in-memory Redis
 * double and a stand-in sender only.
 *
 *   - Totals are shown only from POLL_MIN_SHOWN answers: with one reader,
 *     "1 (100%)" would say what that reader picked. The email and the page
 *     say exactly that.
 *   - A list keeps at most MAX_POLLS_KEPT polls at once, and a poll is never
 *     deleted while it is kept: a new one past the cap is refused, with its
 *     reason in the studio, and a poll whose time is over leaves the count
 *     by itself.
 *   - A poll that could not be written down says so, not that the email
 *     service asked to slow down.
 *   - The store's public request is taken before the poll is read: a store
 *     whose requests are refused reads nothing of the poll.
 *   - The copy of a person's data fails on a poll it cannot read.
 *   - The 60 presses an hour a connection is said in the answer.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast } from "@/lib/broadcasts";
import { readPoll } from "@/lib/mail-poll";
import { MAX_POLLS_KEPT, POLL_MIN_SHOWN, openPoll, pollAnswersOf, pollResults, voteLinks } from "@/lib/mail-poll-votes";
import { pollWords } from "@/lib/buyer-words/mail-poll";
import { LANGUAGES } from "@/lib/store-language";
import { takePublicRequest } from "@/lib/traffic";
import { MailPollResults } from "@/components/mail-poll-results";
import PollPage from "@/app/poll/page";
import { POST as pollPost } from "@/app/api/mail/poll/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "poll-review@example.com";
const delivery = installSesMailFixture();
const POLL = "@poll Which day suits you?\n- Monday\n- Friday";
const DAY = 86_400;

async function page(link: string, extra: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await PollPage({ searchParams: Promise.resolve({ ...Object.fromEntries(new URL(link).searchParams), ...extra }) }));
}
async function press(link: string, action: "vote" | "withdraw" = "vote", ip = "198.51.100.21"): Promise<string> {
  const url = new URL(link);
  const response = await pollPost(new NextRequest(`https://marktmorgen.com/api/mail/poll${url.search}`, { method: "POST", body: new URLSearchParams({ do: action }), headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip } }));
  const location = response.headers.get("location") ?? "";
  return location ? new URL(location).searchParams.get("done") ?? "" : `status ${response.status}`;
}
const hex24 = (n: number) => n.toString(16).padStart(24, "0");

async function main(): Promise<void> {
  redis.clear();
  delivery.configure();
  delivery.reset();
  process.env.RESEND_API_KEY = "re_test_poll_review_only_a_stand_in";

  const made = await claimHandle(OWNER, "poll-review", "Review Polls", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PollReview01", subscriptionId: "sub_PollReview01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Review Polls", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  const poll = readPoll(POLL)!;
  const now = Math.floor(Date.now() / 1000);

  part("The email and the page say exactly when totals show");
  is("five answers at the least", POLL_MIN_SHOWN, 5);
  is("in every language, the number is said", Object.keys(LANGUAGES).every((code) => pollWords(code).emailNote("Shop").includes("5") && pollWords(code).privacy("Shop").includes("5")), true);
  is("in English, plainly", pollWords("en").privacy("Shop"), "Shop sees only how many people picked each answer, and only once at least 5 people have answered, never who picked what.");

  part("Totals hidden below the least, shown from it");
  const pollId = hex24(1);
  is("a poll opened", await openPoll(listId, store.handle, pollId, poll, now), "ok");
  const voters = ["a1", "a2", "a3", "a4", "a5"].map((name) => voteLinks(listId, store.handle, pollId, `${name}@example.com`, 2)!);
  is("one answer", await press(voters[0][0]), "recorded");
  let results = (await pollResults(listId))!;
  is("one answer shows no total and no count", [results[0].shown, results[0].total, results[0].answers.map((a) => a.count)], [false, null, [null, null]]);
  let html = renderToStaticMarkup(await MailPollResults({ listId, subjects: new Map() }));
  is("the studio says when totals show, and no count or share", [html.includes("Totals show once 5 people have answered."), /\(\d+%\)/.test(html), html.includes("Monday:")], [true, false, false]);
  for (const links of voters.slice(1)) await press(links[1]);
  results = (await pollResults(listId))!;
  is("five answers show", [results[0].shown, results[0].total, results[0].answers.map((a) => a.count)], [true, 5, [1, 4]]);
  html = renderToStaticMarkup(await MailPollResults({ listId, subjects: new Map() }));
  is("and the studio draws them", [html.includes("Monday: 1 (20%)"), html.includes("Friday: 4 (80%)")], [true, true]);

  part("The cap: never a kept poll deleted; a new one refused, with its reason");
  for (let i = 2; i <= MAX_POLLS_KEPT; i += 1) is(`poll ${i} opened`, await openPoll(listId, store.handle, hex24(i), poll, now), "ok");
  is("one more is refused", await openPoll(listId, store.handle, hex24(MAX_POLLS_KEPT + 1), poll, now), "full");
  const [first, votes] = (await redis.pipeline([["GET", `nl:mpoll:${listId}:${pollId}`], ["HLEN", `nl:mpoll:v:${listId}:${pollId}`]])) as [string | null, number];
  is("the oldest is still there, its answers whole", [first !== null, votes], [true, 5]);
  is("and still takes its readers' presses", await press(voters[0][1], "withdraw"), "withdrawn");
  is("a kept one opened again is still itself", await openPoll(listId, store.handle, pollId, poll, now), "ok");
  is("a new email with a poll is refused when it is made", await createBroadcast(store, { subject: "Poll", body: POLL, productId: "", notProductId: "", sendAt: undefined }).then((r) => (r.ok ? "made" : r.reason)), "poll_full");
  html = renderToStaticMarkup(await MailPollResults({ listId, subjects: new Map() }));
  is("the studio says the list is full and why", html.includes(`Your list keeps ${MAX_POLLS_KEPT} polls, the most at once.`), true);

  part("A poll whose time is over leaves the count by itself");
  redis.clear();
  const again = await claimHandle(OWNER, "poll-review", "Review Polls", "");
  if (!again.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PollReview01", subscriptionId: "sub_PollReview01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Review Polls", address: "1 Main St, Portland, OR 97201" });
  const fresh = (await storeForEmail(OWNER))!;
  const list2 = fresh.listId as string;
  const long = now - 91 * DAY;
  is("an old poll, long gone", await openPoll(list2, fresh.handle, hex24(100), poll, long), "ok");
  for (let i = 1; i < MAX_POLLS_KEPT; i += 1) await openPoll(list2, fresh.handle, hex24(100 + i), poll, now);
  is("its place is free again", await openPoll(list2, fresh.handle, hex24(200), poll, now), "ok");

  part("A broadcast whose poll meets a full list fails, saying why; one that could not be written says so");
  for (const name of ["ana", "ben"]) await upsertContact(list2, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  // One place left: the email is made, then the last place is taken before it goes.
  await redis.pipeline([["ZREM", `nl:mpoll:ix:${list2}`, hex24(200)], ["DEL", `nl:mpoll:${list2}:${hex24(200)}`]]);
  const late = await createBroadcast(fresh, { subject: "Late poll", body: POLL, productId: "", notProductId: "", sendAt: undefined });
  if (!late.ok) throw new Error(`not made: ${late.reason}`);
  await openPoll(list2, fresh.handle, hex24(300), poll, now);
  delivery.clearCaptured();
  const failed = (await advanceBroadcast(late.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  is("nothing went, and it says the list keeps the most polls", [delivery.sent.length, failed.status, failed.note.includes(`${MAX_POLLS_KEPT} polls`)], [0, "failed", true]);
  await redis.pipeline([["ZREM", `nl:mpoll:ix:${list2}`, hex24(300)], ["DEL", `nl:mpoll:${list2}:${hex24(300)}`]]);
  const shaky = await createBroadcast(fresh, { subject: "Shaky poll", body: POLL, productId: "", notProductId: "", sendAt: undefined });
  if (!shaky.ok) throw new Error(`not made: ${shaky.reason}`);
  const pipe = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("mail-poll-open"))) throw new Error("synthetic write failure");
    return pipe.call(redis, commands);
  }) as typeof redis.pipeline;
  const paused = (await advanceBroadcast(shaky.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  redis.pipeline = pipe;
  is("it says its poll could not be written down, not that the service asked to slow down", [paused.note.includes("poll could not be written down"), paused.note.includes("slow down")], [true, false]);

  part("The store's public request comes before anything of the poll is read");
  const [open] = (await redis.pipeline([["ZREVRANGE", `nl:mpoll:ix:${list2}`, 0, 0]])) as [string[]];
  const ballot = voteLinks(list2, fresh.handle, open[0], "ana@example.com", 2)![0];
  is("the link names its store, signed", new URL(ballot).searchParams.get("h"), fresh.handle);
  is("another store's name breaks the signature", await press(ballot.replace(`h=${fresh.handle}`, "h=poll-other")), "status 404");
  // The store's window of requests is used up: every count comes back past any limit.
  const touched: string[] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) for (const word of c.slice(1)) if (String(word).startsWith("nl:mpoll:")) touched.push(String(c[0]));
    if (commands.length === 1 && commands[0][0] === "INCRBY" && String(commands[0][1]).startsWith("nl:traffic:r:")) return [1e12];
    return pipe.call(redis, commands);
  }) as typeof redis.pipeline;
  const refused = await takePublicRequest(fresh).catch(() => false);
  const shown = await page(ballot);
  const pressed = await press(ballot);
  redis.pipeline = pipe;
  is("this store's requests are refused now", refused, false);
  is("the page and the button read nothing of the poll", [touched, shown.includes("could not be recorded"), pressed], [[], true, "failed"]);

  part("The limit of presses a connection is said");
  let last = "";
  for (let i = 0; i < 61; i += 1) last = await press(ballot, "withdraw", "198.51.100.99");
  is("past 60 an hour, it says so", last, "limited");
  is("the page says the limit", (await page(ballot, { done: "limited" })).includes("60"), true);

  part("The copy of a person's data fails on a poll it cannot read");
  await press(ballot, "vote", "198.51.100.30");
  await redis.pipeline([["SET", `nl:mpoll:${list2}:${open[0]}`, "{not json", "KEEPTTL"]]);
  is("it fails, never skips", await pollAnswersOf(list2, "ana@example.com").then(() => "copied", () => "failed"), "failed");

  delivery.restore();
  done();
}

void main();
