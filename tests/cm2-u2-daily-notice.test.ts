/**
 * 543 [CM2] unit 2: the creator is told, once a day, that posts or comments
 * wait for their approval (lib/community-held-notice.ts).
 *
 * A held item puts its store on a short company list (lib/community-approval.ts,
 * storesWithHeld). Once a day the courses job reads that list, counts each
 * store's queue and, only when something waits, emails the creator one plain
 * US English message with the counts and a link to the studio queue. The email
 * is the store's own figure ("store" meter, kind "email"), taken before it goes
 * (lib/email.ts). At most one a store a day (an exact claim, lib/claim-mark.ts).
 * An unknown reply sends nothing and takes no mark, so the next day tries again.
 * Synthetic data only: no real email is sent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "@/lib/store";
import { HELD_DAYS, approveHeld, holdComment, holdPost, removeHeld, storesWithHeld } from "@/lib/community-approval";
import { NOTICE_STORES_PER_RUN, heldNoticeEmail, noticeHeldStores } from "@/lib/community-held-notice";
import { createPost, CREATOR } from "@/lib/community";
import { EMAIL_SITES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const id = "d".repeat(32);
const SID = "e".repeat(32);
const OTHER_SID = "f".repeat(32);
const SPACE = "aaaaaaaaaaaa";
const ada = "a".repeat(31) + "1";
const bob = "b".repeat(31) + "2";
const DAY = 86_400;
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const room = { ...ROOM, sid: SID };
const post = (author: string, text: string) => ({ space: SPACE, author, title: "", text, img: null, kind: "post" as const, poll: null });

const creatorStore = (over: Partial<Store> = {}): Store =>
  ({
    sid: SID,
    handle: "maple",
    name: "Maple Studio",
    email: "creator@example.test",
    tier: "scale",
    subscriptionActive: true,
    subscriptionId: "sub_synthetic",
    trialEnds: 0,
    planEndedAt: "",
    community: { id, on: true },
    ...over,
  }) as unknown as Store;

type Sent = { meter: unknown; from: string; to: string; subject: string; text: string };

async function main(): Promise<void> {
  redis.clear();
  const t0 = Math.floor(Date.now() / 1000);
  const ms = (seconds: number) => seconds * 1000;
  let outbox: Sent[] = [];
  let answer = true;
  const sendEmail = async (message: Sent) => {
    outbox.push(message);
    return answer;
  };
  let stores = new Map<string, Store>([[SID, creatorStore()]]);
  const load = async (sid: string) => stores.get(sid) ?? null;
  const run = (now: number) => noticeHeldStores({ now: ms(now), until: ms(now) + 60_000, load, sendEmail: sendEmail as never });

  part("A held item puts its store on the list, and only then");
  is("nothing held, no store listed", await storesWithHeld(t0), []);
  const nothing = await run(t0);
  is("nothing held, no email", [outbox.length, nothing.sent], [0, 0]);
  const p1 = await holdPost(id, post(ada, "First"), room, t0);
  const p2 = await holdPost(id, post(bob, "Second"), room, t0);
  const made = await createPost(id, { space: SPACE, author: CREATOR, title: "", text: "Hello", img: null, kind: "post", poll: null }, ROOM);
  if (!made.ok) throw new Error("not published");
  const c1 = await holdComment(id, { post: made.post.id, space: SPACE, parent: "", author: ada, text: "A comment" }, room, t0);
  if (!p1.ok || !p2.ok || !c1.ok) throw new Error("not held");
  is("the store is listed once", await storesWithHeld(t0), [SID]);
  await holdPost("9".repeat(32), post(ada, "No store id"), ROOM, t0);
  is("a room without a store id lists nothing more", await storesWithHeld(t0), [SID]);

  part("One email a day, with the counts and the way to the queue");
  const first = await run(t0 + 60);
  is("one email went", [outbox.length, first.sent], [1, 1]);
  const mail = outbox[0];
  is("to the creator", mail.to, "creator@example.test");
  is("counted as the store's own email, before it goes", mail.meter, { by: "store", store: stores.get(SID), kind: "email" });
  is("the subject says what waits", mail.subject, "2 posts and 1 comment are waiting for your approval");
  is("the text names the community", mail.text.includes("in the Maple Studio community"), true);
  is("the text links to the studio queue", mail.text.includes(`/studio/community?store=${SID}#cm-held-title`), true);
  is("the text says how often it comes", /at most once a day/.test(mail.text), true);
  is("the text says what happens after 30 days", mail.text.includes(`${HELD_DAYS} days`), true);
  is("plain words: no urgency, no exclamation", /!|urgent|hurry|now or never/i.test(mail.subject + mail.text), false);
  const again = await run(t0 + 120);
  is("a second run the same day sends nothing", [outbox.length, again.sent, again.seen], [1, 0, 1]);
  const nextDay = await run(t0 + DAY + 60);
  is("the next day, still waiting, one more", [outbox.length, nextDay.sent], [2, 1]);

  part("Nothing waiting, nothing sent");
  await approveHeld(id, p1.held.id, room, t0 + DAY + 100);
  await removeHeld(id, p2.held.id, "", t0 + DAY + 101);
  await approveHeld(id, c1.held.id, room, t0 + DAY + 102);
  outbox = [];
  const empty = await run(t0 + 2 * DAY + 60);
  is("the queue answered, empty: no email", [outbox.length, empty.sent, empty.none], [0, 0, 1]);

  part("The words, one and many");
  is("one post", heldNoticeEmail(creatorStore(), 1, 0).subject, "1 post is waiting for your approval");
  is("one comment", heldNoticeEmail(creatorStore(), 0, 1).subject, "1 comment is waiting for your approval");
  is("many comments", heldNoticeEmail(creatorStore(), 0, 3).subject, "3 comments are waiting for your approval");
  is("one item: it", /do not see it until you approve it/.test(heldNoticeEmail(creatorStore(), 1, 0).text), true);
  is("several: them", /do not see them until you approve them/.test(heldNoticeEmail(creatorStore(), 2, 0).text), true);

  part("An unknown answer sends nothing and takes no mark, so the next day tries again");
  redis.clear();
  outbox = [];
  const t1 = t0 + 10 * DAY;
  const q = await holdPost(id, post(ada, "Waiting"), room, t1);
  if (!q.ok) throw new Error("not held");
  const realPipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) =>
    commands.some((c) => c[0] === "ZRANGEBYSCORE" && String(c[1]).endsWith(":ap:q")) ? ([{}] as never) : realPipeline(commands);
  const unknownQueue = await run(t1 + 60);
  redis.pipeline = realPipeline;
  is("an unreadable queue: no email", [outbox.length, unknownQueue.sent, unknownQueue.skipped], [0, 0, 1]);
  redis.pipeline = async (commands) => (commands[0]?.[0] === "SET" && String(commands[0][1]).includes(":ap:t:") ? ([undefined] as never) : realPipeline(commands));
  const unknownClaim = await run(t1 + 120);
  redis.pipeline = realPipeline;
  is("an unknown claim on the day's mark: no email", [outbox.length, unknownClaim.sent], [0, 0]);
  const retried = await run(t1 + 180);
  is("a later run, answered, sends the one email", [outbox.length, retried.sent], [1, 1]);
  // The list is read in its turn order (review of #3033): the line's read is the one made unreadable.
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "ZRANGEBYSCORE" && c[1] === "nl:cm:ap:turns") ? ([{}] as never) : realPipeline(commands));
  let listThrew = false;
  try {
    await storesWithHeld(t1 + 200);
  } catch {
    listThrew = true;
  }
  const unknownList = await run(t1 + DAY + 60);
  redis.pipeline = realPipeline;
  is("an unreadable list throws, and the day's run sends nothing", [listThrew, unknownList.sent, outbox.length], [true, 0, 1]);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "ZSCORE" && c[1] === "nl:cm:ap:stores") ? ([{}] as never) : realPipeline(commands));
  let listedThrew = false;
  try {
    await storesWithHeld(t1 + DAY + 100);
  } catch {
    listedThrew = true;
  }
  const unknownListed = await run(t1 + DAY + 120);
  redis.pipeline = realPipeline;
  is("whether a store in line is still listed, unknown: it throws, and the run sends nothing", [listedThrew, unknownListed.sent, outbox.length], [true, 0, 1]);

  part("Only a store on a plan, with this community, that still exists");
  redis.clear();
  outbox = [];
  const t2 = t0 + 20 * DAY;
  await holdPost(id, post(ada, "Waiting"), room, t2);
  stores = new Map([[SID, creatorStore({ subscriptionActive: false, subscriptionId: "sub_ended", planEndedAt: "2026-10-01" } as Partial<Store>)]]);
  is("a plan that ended: no email", [(await run(t2 + 60)).sent, outbox.length], [0, 0]);
  stores = new Map([[SID, creatorStore({ community: null } as Partial<Store>)]]);
  is("no community: no email", [(await run(t2 + DAY + 60)).sent, outbox.length], [0, 0]);
  stores = new Map();
  is("a store gone: no email", [(await run(t2 + 2 * DAY + 60)).sent, outbox.length], [0, 0]);
  stores = new Map([[SID, creatorStore()]]);
  answer = false;
  const refused = await run(t2 + 3 * DAY + 60);
  is("an email the figure refused counts as failed", [refused.sent, refused.failed, outbox.length], [0, 1, 1]);
  is("and is not tried twice the same day", [(await run(t2 + 3 * DAY + 120)).seen, outbox.length], [1, 1]);
  answer = true;

  part("The list forgets a store once nothing it held can still wait");
  is("listed while an item can wait", await storesWithHeld(t2 + HELD_DAYS * DAY), [SID]);
  is("gone a day after the last item could wait", await storesWithHeld(t2 + (HELD_DAYS + 2) * DAY), []);

  part("Bounded: a run reads at most so many stores, and stops at its deadline");
  is("a ceiling a run", NOTICE_STORES_PER_RUN > 0 && NOTICE_STORES_PER_RUN <= 1000, true);
  redis.clear();
  outbox = [];
  await holdPost(id, post(ada, "Waiting"), room, t2);
  await holdPost("8".repeat(32), post(ada, "Waiting too"), { ...ROOM, sid: OTHER_SID }, t2);
  const late = await noticeHeldStores({ now: ms(t2 + 60), until: ms(t2 + 60) - 1, load, sendEmail: sendEmail as never });
  is("past its deadline, a run reads nothing", [late.sent, outbox.length], [0, 0]);

  // Review of #3033 (Claude 1, LOW): the run's time used to go to the stores held from most lately, every day,
  // so a store whose item had waited longest could never be told. Now the stores take turns: the one waiting
  // its turn longest goes first, a store goes to the back of the line once its run answered, and a new hold
  // never moves a store already in line. The clock is the test's: each email takes 60 ms of a 50 ms run.
  part("Every listed store gets its turn, the one held first first, however short the run");
  redis.clear();
  outbox = [];
  const t3 = t0 + 40 * DAY;
  const turn = [0, 1, 2].map((n) => ({ sid: "c".repeat(31) + n, id: "7".repeat(31) + n, email: `creator${n}@example.test` }));
  for (const [n, s] of turn.entries()) {
    const held = await holdPost(s.id, post(ada, `Waiting ${n}`), { ...ROOM, sid: s.sid }, t3 + 60 * n);
    if (!held.ok) throw new Error("not held");
  }
  stores = new Map(turn.map((s) => [s.sid, creatorStore({ sid: s.sid, email: s.email, community: { id: s.id, on: true } } as Partial<Store>)]));
  const realNow = Date.now;
  let clock = realNow();
  const slowSend = async (message: Sent) => {
    clock += 60;
    return sendEmail(message);
  };
  const shortRun = async (at: number): Promise<string> => {
    const before = outbox.length;
    Date.now = () => clock;
    try {
      await noticeHeldStores({ now: ms(at), until: ms(at) + 50, load, sendEmail: slowSend as never });
    } finally {
      Date.now = realNow;
    }
    return outbox.slice(before).map((m) => m.to).join(",");
  };
  const days: string[] = [];
  for (let day = 1; day <= 4; day += 1) days.push(await shortRun(t3 + day * DAY));
  is(
    "one email a run, each store in turn, the store held first told on the first day",
    days,
    ["creator0@example.test", "creator1@example.test", "creator2@example.test", "creator0@example.test"],
  );
  const heldAgain = await holdPost(turn[2].id, post(bob, "Waiting again"), { ...ROOM, sid: turn[2].sid }, t3 + 4 * DAY + 600);
  if (!heldAgain.ok) throw new Error("not held");
  is(
    "a store that holds again keeps its place in line",
    [await shortRun(t3 + 5 * DAY), await shortRun(t3 + 6 * DAY)],
    ["creator1@example.test", "creator2@example.test"],
  );
  // Rule 24: an unknown answer is never read as the store's turn being done.
  const queue0 = `nl:cm:${turn[0].id}:ap:q`;
  const realPipe = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "ZRANGEBYSCORE" && c[1] === queue0) ? ([{}] as never) : realPipe(commands));
  let day7 = "";
  try {
    day7 = await shortRun(t3 + 7 * DAY);
  } finally {
    redis.pipeline = realPipe;
  }
  is("an unreadable queue: that store is not told, and the run goes on to the next", day7, "creator1@example.test");
  is("and the store keeps its turn: it goes first on the next run", await shortRun(t3 + 8 * DAY), "creator0@example.test");

  part("A store let go from the list leaves the line, unless it holds again meanwhile");
  redis.clear();
  outbox = [];
  const t4 = t0 + 80 * DAY;
  await holdPost(turn[0].id, post(ada, "Waiting"), { ...ROOM, sid: turn[0].sid }, t4);
  const tLate = t4 + (HELD_DAYS + 2) * DAY;
  // While the run lets the store go, the store holds again, and the hold lands just before the run's removal.
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "ZREM" && c.includes(turn[0].sid))) {
      redis.pipeline = realPipe;
      const back = await holdPost(turn[0].id, post(bob, "Back"), { ...ROOM, sid: turn[0].sid }, tLate);
      if (!back.ok) throw new Error("not held");
    }
    return realPipe(commands);
  };
  try {
    await storesWithHeld(tLate);
  } finally {
    redis.pipeline = realPipe;
  }
  is("a hold that lands while the run lets the store go keeps it listed", await storesWithHeld(tLate + 60), [turn[0].sid]);
  is("and its creator is told on the next run", await shortRun(tLate + 120), "creator0@example.test");
  const tGone = tLate + (HELD_DAYS + 2) * DAY;
  // Rule 24 on the way out: the second look at the list unknown, the store is put back in line and the read throws.
  redis.pipeline = async (commands) => {
    const replies = await realPipe(commands);
    return commands.some((c) => c[0] === "ZREM" && c.includes(turn[0].sid)) ? ([replies[0], {}] as never) : replies;
  };
  let goneThrew = false;
  try {
    await storesWithHeld(tGone);
  } catch {
    goneThrew = true;
  }
  redis.pipeline = realPipe;
  is("let go on an unknown second look: it throws and the store stays in line", [goneThrew, (await redis.run(["ZSCORE", "nl:cm:ap:turns", turn[0].sid])) !== null], [true, true]);
  is("once nothing it held can wait, it is let go", await storesWithHeld(tGone), []);
  is("and it has left the line", await redis.run(["ZSCORE", "nl:cm:ap:turns", turn[0].sid]), null);

  part("Wired into the daily job, and its email registered");
  const cron = read("app/api/cron/courses/route.ts");
  is("the courses job runs the notice", /noticeHeldStores\(/.test(cron), true);
  is("the job's run is still one at a time on an exact claim", /claimMark\("nl:courses:lock"/.test(cron) && /releaseMark\("nl:courses:lock"/.test(cron), true);
  is("EMAIL_SITES lists the file, store meter only", EMAIL_SITES["lib/community-held-notice.ts"], ["store"]);
  const notice = read("lib/community-held-notice.ts");
  is("the file counts its email as the store's own", /sendEmail\(\{ meter: \{ by: "store", store, kind: "email" \}/.test(notice), true);
  is("the day's mark is an exact claim", /claimMark\(heldNoticeKey\(/.test(notice), true);

  done();
}

void main();
