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
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "ZREVRANGE") ? ([{}] as never) : realPipeline(commands));
  let listThrew = false;
  try {
    await storesWithHeld(t1 + 200);
  } catch {
    listThrew = true;
  }
  const unknownList = await run(t1 + DAY + 60);
  redis.pipeline = realPipeline;
  is("an unreadable list throws, and the day's run sends nothing", [listThrew, unknownList.sent, outbox.length], [true, 0, 1]);

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
