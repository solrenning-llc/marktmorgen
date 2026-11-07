/**
 * 125 [F2-EMAIL-POLLS]: the second pre-review's findings on unit 1, each held
 * (7 November 2026). Synthetic stores and addresses, the in-memory Redis
 * double and a stand-in sender only.
 *
 *   - The poll's sending cost is in every line that prices a list email: the
 *     resale table, the SES-only credit and pack, and the plan's own brake.
 *   - A link names the store by its id, which a new address never changes:
 *     after the store is renamed, a reader's answer still counts.
 *   - The store's owner and team are not readers: their presses record
 *     nothing, so they cannot fill the fewest answers themselves.
 *   - Totals are shown only once the poll has closed (no answer moves them
 *     after) and at least 5 readers answered; the words say exactly that.
 *   - A poll whose saving could not be confirmed says so.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, renameHandle, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { putMember } from "@/lib/team";
import { upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast } from "@/lib/broadcasts";
import { readPoll } from "@/lib/mail-poll";
import { openPoll, pollResults, voteLinks } from "@/lib/mail-poll-votes";
import { pollWords } from "@/lib/buyer-words/mail-poll";
import { LANGUAGES } from "@/lib/store-language";
import { MailPollResults } from "@/components/mail-poll-results";
import PollPage from "@/app/poll/page";
import { POST as pollPost } from "@/app/api/mail/poll/route";
import { LIST_EMAIL_USD, POLL_SEND_USD } from "./plan-cost-registry";
import { candidates } from "./per-use-resale-table";
import { SES_DEAREST_PER_EMAIL, supplierVariant } from "./pack-cost-decomposition-table";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "poll-review-two@example.com";
const delivery = installSesMailFixture();
const POLL = "@poll Which day suits you?\n- Monday\n- Friday";
const hex24 = (n: number) => n.toString(16).padStart(24, "0");
const linksIn = (html: string) => [...html.matchAll(/href="([^"]*\/poll\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function press(link: string, action: "vote" | "withdraw" = "vote", ip = "198.51.100.61"): Promise<string> {
  const url = new URL(link);
  const response = await pollPost(new NextRequest(`https://marktmorgen.com/api/mail/poll${url.search}`, { method: "POST", body: new URLSearchParams({ do: action }), headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip } }));
  const location = response.headers.get("location") ?? "";
  return location ? new URL(location).searchParams.get("done") ?? "" : `status ${response.status}`;
}
async function page(link: string, extra: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await PollPage({ searchParams: Promise.resolve({ ...Object.fromEntries(new URL(link).searchParams), ...extra }) }));
}

async function main(): Promise<void> {
  part("The poll's sending cost is in every line that prices a list email");
  const resale = candidates().find((line) => line.id === "list-email");
  is("the resale table", resale?.unitUsd, LIST_EMAIL_USD);
  is("the SES-only pack", supplierVariant("list-email").pack.costUsd, supplierVariant("list-email").pack.units * (SES_DEAREST_PER_EMAIL + POLL_SEND_USD));
  const decomposition = readFileSync(join(process.cwd(), "tests/pack-cost-decomposition-table.ts"), "utf8");
  is("the SES-only credit", [decomposition.includes('listEmailVia === "ses-only" ? SES_DEAREST_PER_EMAIL + POLL_SEND_USD'), decomposition.includes('listEmailVia === "ses-only" ? SES_DEAREST_PER_EMAIL :')], [true, false]);
  const margin = readFileSync(join(process.cwd(), "tests/plan-margin.test.ts"), "utf8");
  is("the plan's own email brake", [margin.includes('["email", monthlyEmails(tier) * LIST_EMAIL_USD]'), margin.includes('["email", monthlyEmails(tier) * PER_EMAIL]')], [true, false]);

  redis.clear();
  delivery.configure();
  delivery.reset();
  process.env.RESEND_API_KEY = "re_test_poll_review_two_only_a_stand_in";
  const made = await claimHandle(OWNER, "poll-two", "Two Polls", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PollReviewTwo1", subscriptionId: "sub_PollReviewTwo1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Two Polls", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  await putMember(store, "mate@example.com", "editor");
  const readers = ["r1", "r2", "r3", "r4", "r5"].map((name) => `${name}@example.com`);
  for (const email of [...readers, OWNER, "mate@example.com"]) await upsertContact(listId, email, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("Sent: links name the store by its id");
  const created = await createBroadcast(store, { subject: "Pick a day", body: POLL, productId: "", notProductId: "", sendAt: undefined });
  if (!created.ok) throw new Error(`not made: ${created.reason}`);
  delivery.clearCaptured();
  await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 60_000);
  const linkOf = (email: string) => linksIn(delivery.sent.find((m) => m.to.includes(email))?.html ?? "");
  is("the store's id, not its address", [new URL(linkOf(readers[0])[0] ?? "https://x/").searchParams.get("i"), new URL(linkOf(readers[0])[0] ?? "https://x/").searchParams.get("h")], [store.sid, null]);

  part("The owner and the team are not readers");
  is("the owner's press records nothing and says why", await press(linkOf(OWNER)[0]), "team");
  is("a teammate's too", await press(linkOf("mate@example.com")[0]), "team");
  is("the page says it", (await page(linkOf(OWNER)[0], { done: "team" })).includes("not counted"), true);
  const [kept] = (await redis.pipeline([["HLEN", `nl:mpoll:v:${listId}:${created.broadcast.id}`]])) as [number];
  is("nothing of theirs is kept", Number(kept), 0);

  part("Renamed: a reader's answer still counts");
  const renamed = await renameHandle(OWNER, "poll-two-new");
  is("the store has a new address", renamed.ok, true);
  store = (await storeForEmail(OWNER))!;
  for (const [i, email] of readers.entries()) is(`${email} answers after the rename`, await press(linkOf(email)[i % 2]), "recorded");
  is("its poll is still itself for the rest of its email", await openPoll(listId, store.handle, created.broadcast.id, readPoll(POLL)!), "ok");

  part("Totals only once the poll has closed, from 5 readers");
  let results = (await pollResults(listId))!;
  is("five readers, still open: nothing shown", [results[0].shown, results[0].total], [false, null]);
  let html = renderToStaticMarkup(await MailPollResults({ listId, subjects: new Map() }));
  is("the studio says when they show", html.includes("Totals show after the poll closes, if at least 5 readers answered."), true);
  const key = `nl:mpoll:${listId}:${created.broadcast.id}`;
  const [raw] = (await redis.pipeline([["GET", key]])) as [string];
  await redis.pipeline([["SET", key, JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), closes: Math.floor(Date.now() / 1000) - 1 }), "KEEPTTL"]]);
  results = (await pollResults(listId))!;
  is("closed: shown", [results[0].shown, results[0].total, results[0].answers.map((a) => a.count)], [true, 5, [3, 2]]);
  html = renderToStaticMarkup(await MailPollResults({ listId, subjects: new Map() }));
  is("and drawn", html.includes("Monday: 3 (60%)"), true);

  part("The words say what the code keeps");
  is("in English", pollWords("en").privacy("Shop"), "Shop sees only totals, after the poll closes and only if at least 5 readers answered, never with names.");
  is("in every language, the number and no promise the code cannot keep", Object.keys(LANGUAGES).every((code) => pollWords(code).privacy("Shop").includes("5") && pollWords(code).emailNote("Shop").includes(pollWords(code).privacy("Shop"))), true);
  is("the old promise is gone", Object.keys(LANGUAGES).some((code) => /never who picked what|nunca quién eligió qué|jamais qui a choisi quoi|nie, wer was gewählt hat|mai chi ha scelto cosa|nooit wie wat koos|nunca quem escolheu o quê/.test(pollWords(code).privacy("Shop"))), false);

  part("A poll whose saving could not be confirmed says so");
  await redis.pipeline([["DEL", `nl:mpoll:ix:${listId}`]]);
  for (let i = 1; i <= 3; i += 1) await openPoll(listId, store.handle, hex24(i), readPoll(POLL)!);
  const shaky = await createBroadcast(store, { subject: "Shaky", body: POLL, productId: "", notProductId: "", sendAt: undefined });
  if (!shaky.ok) throw new Error(`not made: ${shaky.reason}`);
  const pipe = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("mail-poll-open"))) throw new Error("synthetic failure");
    return pipe.call(redis, commands);
  }) as typeof redis.pipeline;
  const paused = (await advanceBroadcast(shaky.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  redis.pipeline = pipe;
  is("its note says its saving could not be confirmed", [paused.note.includes("could not be confirmed"), paused.note.includes("written down")], [true, false]);

  delivery.restore();
  done();
}

void main();
