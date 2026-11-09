import { NextRequest } from "next/server";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { GET as monthly } from "@/app/api/cron/monthly/route";
import { control } from "./numbers-email-claim-world";
import { resetRetry, retry } from "./numbers-email-retry-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Rule 24 (CX-123) after the claim, on the numbers-email crons. A store's week or month is claimed before
// anything is sent, so a summary that did not go (the provider refused the email, the channel refused the post)
// must let the claim go for a later run, a bounded number of times, and a part that did go must not go twice on
// that later run. A read that decides what the summary says (the ad spend, the team copies) and could not be
// made is not "none": nothing is sent on it, and the claim is let go. Synthetic stores, sender, channel, spend
// and team; no network.

const TRIES = 3; // the runs that may try one period's summary (SUMMARY_TRIES in lib/stats-report.ts)
const oldPipeline = redis.pipeline.bind(redis);
const commands: (string | number)[][] = [];
let teamReply: unknown = undefined;
const request = (path: string) => new NextRequest(`https://example.test${path}`);

function reset(): void {
  redis.clear();
  commands.length = 0;
  control.sent.length = 0;
  control.numbers = "visitors-5";
  resetRetry();
  teamReply = undefined;
}

/** Whether the period's claim for the fixture store is held now (the SET … NX on the sent key itself). */
function held(prefix: "nl:weekly:sent:" | "nl:monthly:sent:"): boolean {
  const pattern = new RegExp(`^${prefix}[^:]+:fixture-store$`);
  const set = commands.find((c) => c[0] === "SET" && pattern.test(String(c[1])) && c.includes("NX"));
  if (!set) throw new Error(`no claim was tried under ${prefix}`);
  return redis.run(["GET", String(set[1])]) !== null;
}

const owner = () => retry.mails.filter((to) => to === "owner@example.test").length;
const member = () => retry.mails.filter((to) => to === "member@example.test").length;
const run = async (route: typeof weekly, path: string) => (await route(request(path))).json();

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("No real network request belongs in a numbers-email route test"); };
  redis.pipeline = async (batch) => {
    commands.push(...batch.map((c) => [...c]));
    const replies = await oldPipeline(batch);
    if (teamReply !== undefined) {
      return replies.map((reply, i) => (batch[i][0] === "SMEMBERS" && String(batch[i][1]).startsWith("nl:weekly:to:") ? teamReply : reply));
    }
    return replies;
  };
  const chooseMember = () => redis.run(["SADD", "nl:weekly:to:fixture-store", "member@example.test"]);

  part("Weekly control: the summary goes once to the owner, the chosen member and the channel, and the week stays claimed");
  reset();
  chooseMember();
  retry.chat = "channel";
  let body = await run(weekly, "/api/cron/weekly");
  is("sent, nothing failed", [body.ok, body.sent, body.failed], [true, 1, 0]);
  is("owner, member, one post", [owner(), member(), retry.posts.length], [1, 1, 1]);
  is("the week stays claimed", held("nl:weekly:sent:"), true);
  commands.length = 0;
  body = await run(weekly, "/api/cron/weekly");
  is("a second run sends nothing more", [owner(), member(), retry.posts.length, body.sent], [1, 1, 1, 0]);

  part("Weekly: the owner's email refused lets the week go; the next run emails, and does not post twice");
  reset();
  chooseMember();
  retry.chat = "channel";
  retry.sendOk = () => false;
  body = await run(weekly, "/api/cron/weekly");
  is("counted as failed, not sent", [body.sent, body.failed], [0, 1]);
  is("the post went; no team copy before the owner's email went", [retry.posts.length, member()], [1, 0]);
  is("the week's claim is let go, so a later run tries again", held("nl:weekly:sent:"), false);
  retry.sendOk = () => true;
  commands.length = 0;
  body = await run(weekly, "/api/cron/weekly");
  is("the next run sends the email and the team copy", [body.sent, body.failed, owner(), member()], [1, 0, 2, 1]);
  is("the channel is not posted to twice", retry.posts.length, 1);
  is("the week is claimed now", held("nl:weekly:sent:"), true);
  const ownerKeys = retry.keys.filter((_, i) => retry.mails[i] === "owner@example.test");
  is("both tries of the owner's email go under one key for the week, so one the sender could not confirm is not sent twice",
    [ownerKeys.length, typeof ownerKeys[0] === "string" && ownerKeys[0].startsWith("numbers-summary:nl:weekly:sent:"), ownerKeys[0] === ownerKeys[1]], [2, true, true]);

  part(`Weekly: an email refused every time is tried by ${TRIES} runs, never more`);
  reset();
  retry.sendOk = () => false;
  for (let i = 1; i <= TRIES + 2; i += 1) {
    commands.length = 0;
    await run(weekly, "/api/cron/weekly");
  }
  is(`${TRIES} attempts in all`, owner(), TRIES);

  part("Weekly: the channel refusing the post lets the week go; the next run posts, and does not email twice");
  reset();
  chooseMember();
  retry.chat = "channel";
  retry.postOk = false;
  body = await run(weekly, "/api/cron/weekly");
  is("the email went; the miss is counted", [owner(), member(), body.failed], [1, 1, 1]);
  is("the week's claim is let go", held("nl:weekly:sent:"), false);
  retry.postOk = true;
  commands.length = 0;
  body = await run(weekly, "/api/cron/weekly");
  is("the next run posts", retry.posts.length, 2);
  is("and emails nobody again", [owner(), member()], [1, 1]);
  is("the week is claimed now", held("nl:weekly:sent:"), true);

  part("Weekly: a post whose outcome is unknown (timeout, abort, thrown, 5xx) is never posted again by a later run");
  reset();
  chooseMember();
  retry.chat = "channel";
  retry.sendOk = () => false;
  retry.postUnknown = true;
  body = await run(weekly, "/api/cron/weekly");
  is("one post tried, the owner's email refused, the miss counted", [retry.posts.length, body.sent, body.failed], [1, 0, 1]);
  retry.sendOk = () => true;
  retry.postUnknown = false;
  commands.length = 0;
  body = await run(weekly, "/api/cron/weekly");
  is("the next run, with a healthy channel, emails the owner and the member", [body.sent, body.failed, owner(), member()], [1, 0, 2, 1]);
  is("and still exactly one post", retry.posts.length, 1);
  commands.length = 0;
  await run(weekly, "/api/cron/weekly");
  is("a further run posts nothing more", retry.posts.length, 1);

  part("Weekly: emails stopped, a post whose outcome is unknown is not posted again");
  reset();
  redis.run(["SADD", "nl:weekly:off", "fixture-store"]);
  retry.chat = "channel";
  retry.postUnknown = true;
  body = await run(weekly, "/api/cron/weekly");
  is("one post tried, counted as a miss", [retry.posts.length, body.failed, owner()], [1, 1, 0]);
  retry.postUnknown = false;
  for (let i = 1; i <= TRIES; i += 1) {
    commands.length = 0;
    await run(weekly, "/api/cron/weekly");
  }
  is("later runs with a healthy channel: still exactly one post, no email", [retry.posts.length, owner()], [1, 0]);

  part("Weekly: emails stopped, the post refused, is tried again by a later run");
  reset();
  redis.run(["SADD", "nl:weekly:off", "fixture-store"]);
  retry.chat = "channel";
  retry.postOk = false;
  body = await run(weekly, "/api/cron/weekly");
  is("no email, the miss counted, the week let go", [owner(), body.failed, held("nl:weekly:sent:")], [0, 1, false]);
  retry.postOk = true;
  commands.length = 0;
  await run(weekly, "/api/cron/weekly");
  is("the next run posts, still no email", [retry.posts.length, owner()], [2, 0]);

  part("Weekly: an ad spend that could not be read sends nothing that says 'none', and lets the week go");
  reset();
  retry.chat = "channel";
  retry.spends = "throws";
  body = await run(weekly, "/api/cron/weekly");
  is("failed, not quiet, nothing sent or posted", [body.failed, body.quiet, body.sent, owner(), retry.posts.length], [1, 0, 0, 0, 0]);
  is("the week's claim is let go", held("nl:weekly:sent:"), false);
  retry.spends = "none";
  commands.length = 0;
  body = await run(weekly, "/api/cron/weekly");
  is("the next run sends and posts", [body.sent, owner(), retry.posts.length], [1, 1, 1]);

  part("Weekly: a team that could not be read sends no summary without the team's copies, and lets the week go");
  reset();
  chooseMember();
  retry.team = "throws";
  body = await run(weekly, "/api/cron/weekly");
  is("failed, nothing sent", [body.failed, body.sent, owner(), member()], [1, 0, 0, 0]);
  is("the week's claim is let go", held("nl:weekly:sent:"), false);
  retry.team = "members";
  commands.length = 0;
  await run(weekly, "/api/cron/weekly");
  is("the next run sends to both", [owner(), member()], [1, 1]);

  for (const [label, reply] of [["a number", 1], ["a string", "member@example.test"], ["a list holding a number", [7]]] as const) {
    part(`Weekly: who gets the team copies answered in an unknown shape (${label}) is not 'nobody'`);
    reset();
    teamReply = reply;
    body = await run(weekly, "/api/cron/weekly");
    is("failed, nothing sent", [body.failed, body.sent, owner()], [1, 0, 0]);
    is("the week's claim is let go", held("nl:weekly:sent:"), false);
  }

  part("Weekly control: nobody chosen for the team copies, read exactly, is nobody");
  reset();
  body = await run(weekly, "/api/cron/weekly");
  is("the owner's email only, nothing failed", [body.sent, body.failed, owner(), member()], [1, 0, 1, 0]);

  part("Monthly: the email refused lets the month go; the next run emails, and does not post twice");
  reset();
  retry.chat = "channel";
  retry.sendOk = () => false;
  body = await run(monthly, "/api/cron/monthly");
  is("posted, the email counted as failed", [body.posted, body.sent, body.failed], [1, 0, 1]);
  is("the month's claim is let go", held("nl:monthly:sent:"), false);
  retry.sendOk = () => true;
  commands.length = 0;
  body = await run(monthly, "/api/cron/monthly");
  is("the next run emails, no second post", [body.sent, body.posted, owner(), retry.posts.length], [1, 0, 2, 1]);
  is("the month is claimed now", held("nl:monthly:sent:"), true);

  part(`Monthly: an email refused every time is tried by ${TRIES} runs, never more`);
  reset();
  retry.sendOk = () => false;
  for (let i = 1; i <= TRIES + 2; i += 1) {
    commands.length = 0;
    await run(monthly, "/api/cron/monthly");
  }
  is(`${TRIES} attempts in all`, owner(), TRIES);

  part("Monthly: the post refused lets the month go; the next run posts, and does not email twice");
  reset();
  retry.chat = "channel";
  retry.postOk = false;
  body = await run(monthly, "/api/cron/monthly");
  is("emailed, the post's miss counted", [body.sent, body.posted, body.failed], [1, 0, 1]);
  is("the month's claim is let go", held("nl:monthly:sent:"), false);
  retry.postOk = true;
  commands.length = 0;
  body = await run(monthly, "/api/cron/monthly");
  is("the next run posts and emails nobody again", [body.posted, owner(), retry.posts.length], [1, 1, 2]);

  part("Monthly: a post whose outcome is unknown is never posted again by a later run");
  reset();
  retry.chat = "channel";
  retry.sendOk = () => false;
  retry.postUnknown = true;
  body = await run(monthly, "/api/cron/monthly");
  is("one post tried, not counted as posted; the miss counted", [retry.posts.length, body.posted, body.sent, body.failed], [1, 0, 0, 1]);
  retry.sendOk = () => true;
  retry.postUnknown = false;
  commands.length = 0;
  body = await run(monthly, "/api/cron/monthly");
  is("the next run, with a healthy channel, emails and does not post again", [body.sent, body.posted, body.failed, owner(), retry.posts.length], [1, 0, 0, 2, 1]);

  part("Monthly control: emailed and posted once, the month stays claimed");
  reset();
  retry.chat = "channel";
  body = await run(monthly, "/api/cron/monthly");
  is("one email, one post", [body.sent, body.posted, body.failed, owner(), retry.posts.length], [1, 1, 0, 1, 1]);
  is("claimed", held("nl:monthly:sent:"), true);

  // Claude 2's first review of #3297 (MEDIUM): an owner email whose answer was lost may have been delivered, and
  // lib/email.ts answers it as false, the same as a refusal. The sender keeps its key for a day and the crons try a
  // period for two, so a try more than a day after the first must never send it blind.
  const realNow = Date.now;
  const HOUR = 3_600_000;
  const ownerDelivered = () => retry.delivered.filter((to) => to === "owner@example.test").length;
  try {
    part("Weekly: an owner email whose answer was lost is delivered once, even when the next try is more than a day later");
    reset();
    chooseMember();
    retry.lostAnswer = true;
    const monday = Date.parse("2026-11-09T00:20:00Z");
    let clock = monday;
    Date.now = () => clock;
    body = await run(weekly, "/api/cron/weekly");
    is("delivered, not counted as sent, no team copy yet", [ownerDelivered(), body.sent, member()], [1, 0, 0]);
    control.numbers = "throws";
    for (let hour = 1; hour <= 24; hour += 1) {
      clock = monday + hour * HOUR;
      commands.length = 0;
      await run(weekly, "/api/cron/weekly");
    }
    control.numbers = "visitors-5";
    clock = monday + 25 * HOUR;
    commands.length = 0;
    body = await run(weekly, "/api/cron/weekly");
    is("Tuesday 01:20: the owner has the week's summary exactly once", ownerDelivered(), 1);
    is("no team copy goes on an owner's email that was never confirmed", member(), 0);
    is("counted as unconfirmed, and the week stays claimed", [body.unconfirmed, body.failed, held("nl:weekly:sent:")], [1, 0, true]);
    commands.length = 0;
    await run(weekly, "/api/cron/weekly");
    is("a further run tries nothing", [ownerDelivered(), retry.mails.filter((to) => to === "owner@example.test").length], [1, 1]);

    part("Weekly control: inside the day, a lost answer is tried again under the same key, and delivered once");
    reset();
    retry.lostAnswer = true;
    clock = monday;
    await run(weekly, "/api/cron/weekly");
    for (let hour = 1; hour <= TRIES + 1; hour += 1) {
      clock = monday + hour * HOUR;
      commands.length = 0;
      await run(weekly, "/api/cron/weekly");
    }
    is(`${TRIES} tries in all, one delivery, every try under one key`, [owner(), ownerDelivered(), new Set(retry.keys).size], [TRIES, 1, 1]);

    part("Monthly: an email whose answer was lost is delivered once, even when the next try is more than a day later");
    reset();
    retry.lostAnswer = true;
    const today = new Date();
    const first = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1, 0, 20);
    clock = first;
    body = await run(monthly, "/api/cron/monthly");
    is("delivered, not counted as sent", [ownerDelivered(), body.sent], [1, 0]);
    control.numbers = "throws";
    for (let hour = 1; hour <= 24; hour += 1) {
      clock = first + hour * HOUR;
      commands.length = 0;
      await run(monthly, "/api/cron/monthly");
    }
    control.numbers = "visitors-5";
    clock = first + 25 * HOUR;
    commands.length = 0;
    body = await run(monthly, "/api/cron/monthly");
    is("the 2nd at 01:20: the owner has the month's summary exactly once", ownerDelivered(), 1);
    is("counted as unconfirmed, and the month stays claimed", [body.unconfirmed, body.failed, held("nl:monthly:sent:")], [1, 0, true]);
  } finally {
    Date.now = realNow;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
