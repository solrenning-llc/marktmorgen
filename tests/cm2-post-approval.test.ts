/**
 * 543 [CM2]: optional approval of posts and comments before they publish.
 *
 * Per space, the creator picks "Publish right away" (the default), "Approve
 * the first posts of new members" (1 to 5) or "Approve every post", and the
 * same for comments, separately. What waits is kept apart from the feed and
 * the comments (lib/community-approval.ts), so nothing that reads the
 * community can show it: only its author (marked "Waiting for approval") and
 * the creator's queue see it. Approving publishes it; removing tells the
 * author, with the creator's sentence; 30 days without an answer refuse it by
 * themselves. The queue is capped per community and per member, and deleting
 * the person deletes what they had waiting. An unknown reply never publishes.
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREATOR, feed, readComments } from "@/lib/community";
import {
  HELD_DAYS,
  MAX_HELD,
  MAX_MINE,
  PUBLISH_RIGHT_AWAY,
  approvalFor,
  approveHeld,
  forgetHeldPerson,
  heldOf,
  heldQueue,
  holdComment,
  holdPost,
  mustHold,
  parseSpaceApproval,
  removeHeld,
  setApproval,
  withdrawHeld,
} from "@/lib/community-approval";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { PERSON_DATA } from "@/lib/person-data";
import { approvalWords } from "@/lib/buyer-words/community-approval";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const id = "c".repeat(32);
const SPACE = "aaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbb";
const ada = "a".repeat(31) + "1";
const bob = "b".repeat(31) + "2";
const DAY = 86_400;
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const post = (author: string, text: string) => ({ space: SPACE, author, title: "", text, img: null, kind: "post" as const, poll: null });

async function main(): Promise<void> {
  redis.clear();
  const t0 = Math.floor(Date.now() / 1000);

  part("The setting: publish right away unless the creator chose otherwise");
  is("a space never set publishes right away", await approvalFor(id, SPACE), PUBLISH_RIGHT_AWAY);
  is("every post", (await setApproval(id, SPACE, { posts: { mode: "all", n: 0 }, comments: { mode: "first", n: 3 } }, [SPACE, OTHER], t0)).posts.mode, "all");
  const set = await approvalFor(id, SPACE);
  is("comments: the first three of new members, from now", [set.comments.mode, set.comments.n, set.comments.since], ["first", 3, t0]);
  is("another space keeps its own setting", await approvalFor(id, OTHER), PUBLISH_RIGHT_AWAY);
  for (const n of [0, 6, 2.5, -1]) {
    let refused = false;
    try {
      await setApproval(id, SPACE, { posts: { mode: "first", n }, comments: { mode: "off", n: 0 } }, [SPACE], t0);
    } catch {
      refused = true;
    }
    is(`"first" with ${n} is refused`, refused, true);
  }
  let unknownSpace = false;
  try {
    await setApproval(id, "cccccccccccc", { posts: { mode: "all", n: 0 }, comments: { mode: "off", n: 0 } }, [SPACE], t0);
  } catch {
    unknownSpace = true;
  }
  is("a space the community does not have is refused", unknownSpace, true);
  is("a malformed setting parses as nothing, never as publish right away", parseSpaceApproval('{"p":{"m":"sometimes"}}'), null);
  redis.run(["HSET", `nl:cm:${id}:ap:r`, OTHER, "{not json"]);
  let unknownRule = false;
  try {
    await approvalFor(id, OTHER);
  } catch {
    unknownRule = true;
  }
  is("an unreadable setting throws: the route refuses rather than publishing", unknownRule, true);
  await setApproval(id, OTHER, { posts: { mode: "off", n: 0 }, comments: { mode: "off", n: 0 } }, [SPACE, OTHER], t0);
  is("saving again writes a readable setting", await approvalFor(id, OTHER), PUBLISH_RIGHT_AWAY);

  part("Who is held");
  const rules = await approvalFor(id, SPACE);
  is("every post: a member is held", await mustHold(id, rules.posts, "p", { k: ada, at: t0 - 400 * DAY }), true);
  is("publish right away: nobody is held", await mustHold(id, PUBLISH_RIGHT_AWAY.posts, "p", { k: ada, at: t0 }), false);
  is("first posts: a member who joined before the rule is not new", await mustHold(id, rules.comments, "c", { k: ada, at: t0 - 1 }), false);
  is("first posts: a member who joined since is held", await mustHold(id, rules.comments, "c", { k: bob, at: t0 + 10 }), true);
  is("no member record: held", await mustHold(id, rules.comments, "c", null), true);

  part("A held post is seen by its author and the creator, nobody else");
  const held = await holdPost(id, post(bob, "Hello, I am new here"), ROOM, t0 + 20);
  if (!held.ok) throw new Error("not held");
  is("not in the feed", (await feed(id, { withHidden: true })).posts.length, 0);
  const mine = await heldOf(id, bob, t0 + 21);
  is("its author sees it, waiting", mine.map((h) => [h.id, h.state, h.text]), [[held.held.id, "held", "Hello, I am new here"]]);
  is("another member sees nothing of it", await heldOf(id, ada, t0 + 21), []);
  is("the creator's queue has it", (await heldQueue(id, t0 + 21)).map((h) => [h.id, h.a, h.kind]), [[held.held.id, bob, "post"]]);

  part("Approving publishes it, once");
  const approved = await approveHeld(id, held.held.id, ROOM, t0 + 30);
  is("approved", approved.ok, true);
  const published = (await feed(id, {})).posts;
  is("now in the feed, as the member wrote it", published.map((p) => [p.a, p.text]), [[bob, "Hello, I am new here"]]);
  is("gone from the queue", await heldQueue(id, t0 + 31), []);
  is("gone from the author's waiting list", await heldOf(id, bob, t0 + 31), []);
  is("approving again publishes nothing more", [(await approveHeld(id, held.held.id, ROOM, t0 + 32)).ok, (await feed(id, {})).posts.length], [false, 1]);

  part("First posts of new members: approved ones count toward the number");
  const rule = { mode: "first" as const, n: 2, since: t0 };
  is("one approved post: still new", await mustHold(id, rule, "p", { k: bob, at: t0 + 10 }), true);
  const second = await holdPost(id, post(bob, "A second one"), ROOM, t0 + 40);
  if (!second.ok) throw new Error("not held");
  await approveHeld(id, second.held.id, ROOM, t0 + 41);
  is("two approved posts: trusted", await mustHold(id, rule, "p", { k: bob, at: t0 + 10 }), false);
  is("comments are counted on their own", await mustHold(id, { mode: "first", n: 1, since: t0 }, "c", { k: bob, at: t0 + 10 }), true);

  part("Comments wait the same way");
  const target = published[0];
  const c1 = await holdComment(id, { post: target.id, space: SPACE, parent: "", author: ada, text: "Welcome!" }, ROOM, t0 + 50);
  if (!c1.ok) throw new Error("comment not held");
  is("not under the post", (await readComments(id, target.id)).length, 0);
  is("its author sees it", (await heldOf(id, ada, t0 + 51)).map((h) => [h.kind, h.post, h.text]), [["comment", target.id, "Welcome!"]]);
  const c1ok = await approveHeld(id, c1.held.id, ROOM, t0 + 52);
  is("approved: under the post", [c1ok.ok, (await readComments(id, target.id)).map((c) => [c.a, c.text])], [true, [[ada, "Welcome!"]]]);

  part("Removing tells the author, with the creator's sentence");
  const c2 = await holdComment(id, { post: target.id, space: SPACE, parent: "", author: ada, text: "Buy my course" }, ROOM, t0 + 60);
  if (!c2.ok) throw new Error("comment not held");
  is("removed", (await removeHeld(id, c2.held.id, "  Please keep links to yourself.  ", t0 + 61)).ok, true);
  is("never published", (await readComments(id, target.id)).length, 1);
  is("off the queue", await heldQueue(id, t0 + 62), []);
  is("the author is told, with the sentence", (await heldOf(id, ada, t0 + 62)).map((h) => [h.state, h.why]), [["removed", "Please keep links to yourself."]]);
  is("a removed item cannot be approved after", (await approveHeld(id, c2.held.id, ROOM, t0 + 63)).ok, false);
  is("the author can dismiss the note", [await withdrawHeld(id, c2.held.id, ada), await heldOf(id, ada, t0 + 64)], ["done", []]);

  part("An author can take back what waits, and only theirs");
  const w = await holdPost(id, post(ada, "Second thoughts"), ROOM, t0 + 70);
  if (!w.ok) throw new Error("not held");
  is("another member cannot", await withdrawHeld(id, w.held.id, bob), "gone");
  is("its author can", [await withdrawHeld(id, w.held.id, ada), await heldQueue(id, t0 + 71), (await feed(id, {})).posts.length], ["done", [], 2]);

  part(`After ${HELD_DAYS} days without an answer, refused by itself`);
  const old = await holdPost(id, post(ada, "Anyone there?"), ROOM, t0 + 80);
  if (!old.ok) throw new Error("not held");
  is(`still waiting just before ${HELD_DAYS} days`, (await heldQueue(id, t0 + 80 + HELD_DAYS * DAY - 1)).length, 1);
  is("off the queue after", await heldQueue(id, t0 + 80 + HELD_DAYS * DAY + 1), []);
  is("the author is told it expired", (await heldOf(id, ada, t0 + 80 + HELD_DAYS * DAY + 2)).map((h) => h.state), ["expired"]);
  is("an expired item cannot be approved", (await approveHeld(id, old.held.id, ROOM, t0 + 80 + HELD_DAYS * DAY + 3)).ok, false);
  is("never published", (await feed(id, {})).posts.length, 2);

  part("The queue never grows without a limit");
  redis.clear();
  const many: string[] = [];
  for (let i = 0; i < MAX_MINE; i += 1) {
    const one = await holdPost(id, post(ada, `post ${i}`), ROOM, t0 + i);
    if (one.ok) many.push(one.held.id);
  }
  is(`one member holds at most ${MAX_MINE}`, [many.length, await holdPost(id, post(ada, "one more"), ROOM, t0 + 100)], [MAX_MINE, { ok: false, reason: "mine" }]);
  redis.clear();
  for (let i = 0; i < MAX_HELD; i += 1) {
    const who = i.toString(16).padStart(32, "0");
    await holdPost(id, post(who, `post ${i}`), ROOM, t0 + i);
  }
  is(`the community holds at most ${MAX_HELD}`, [(await heldQueue(id, t0 + 300)).length, await holdPost(id, post(bob, "late"), ROOM, t0 + 300)], [MAX_HELD, { ok: false, reason: "full" }]);
  is("a refused hold leaves nothing behind", (await heldOf(id, bob, t0 + 301)).length, 0);

  part("Deleting the person deletes what they had waiting");
  redis.clear();
  const gone = await holdPost(id, post(ada, "Delete me with me"), ROOM, t0);
  const stays = await holdPost(id, post(bob, "Not hers"), ROOM, t0);
  if (!gone.ok || !stays.ok) throw new Error("not held");
  await approveHeld(id, (await holdPost(id, post(ada, "counted"), ROOM, t0 + 1) as { held: { id: string } }).held.id, ROOM, t0 + 2);
  const records = await forgetHeldPerson(id, ada);
  is("her waiting post and her count went", [records >= 2, await heldOf(id, ada, t0 + 3), (await heldQueue(id, t0 + 3)).map((h) => h.a)], [true, [], [bob]]);
  is("her count is gone: she is new again", await mustHold(id, { mode: "first", n: 1, since: 0 }, "p", { k: ada, at: t0 }), true);
  is("the community erasure runs it", /forgetHeldPerson\(id, who\)/.test(read("lib/community-erasure.ts")), true);
  const again = await holdPost(id, post(ada, "Once more"), ROOM, t0 + 4);
  if (!again.ok) throw new Error("not held");
  await forgetCommunityPerson(id, ada, "ada@example.com", []);
  is("through the community erasure too", await heldOf(id, ada, t0 + 5), []);
  is("lib/person-data.ts says so", PERSON_DATA.some((d) => d.file === "lib/community-approval.ts" && d.how === "erased" && d.via === "lib/community-erasure.ts"), true);
  is("the copy of their data includes it", /heldOf\(id, who\)/.test(read("lib/person-copy.ts")), true);

  part("An unknown reply never publishes a held post");
  redis.clear();
  const unsure = await holdPost(id, post(ada, "Unsure"), ROOM, t0);
  if (!unsure.ok) throw new Error("not held");
  const realPipeline = redis.pipeline.bind(redis);
  for (const broken of [[undefined], ["{garbage"], [{ id: unsure.held.id }], [42]]) {
    redis.pipeline = async (commands) => (commands[0]?.[0] === "GET" && String(commands[0][1]).includes(":ap:i:") ? (broken as never) : realPipeline(commands));
    let threw = false;
    let result: unknown = null;
    try {
      result = await approveHeld(id, unsure.held.id, ROOM, t0 + 1);
    } catch {
      threw = true;
    }
    redis.pipeline = realPipeline;
    is(`a record read as ${JSON.stringify(broken)} is not approved`, [threw || (result as { ok: boolean }).ok === false, (await feed(id, { withHidden: true })).posts.length], [true, 0]);
  }
  redis.pipeline = async (commands) => (commands[0]?.[0] === "ZREM" && String(commands[0][1]).endsWith(":ap:q") ? ([null] as never) : realPipeline(commands));
  let claimThrew = false;
  try {
    await approveHeld(id, unsure.held.id, ROOM, t0 + 2);
  } catch {
    claimThrew = true;
  }
  redis.pipeline = realPipeline;
  is("an unknown claim on the queue is not approved", [claimThrew, (await feed(id, { withHidden: true })).posts.length], [true, 0]);
  is("and the item is still waiting", (await heldQueue(id, t0 + 3)).map((h) => h.id), [unsure.held.id]);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "ZRANGEBYSCORE" || c[0] === "ZREVRANGE" || c[0] === "ZRANGE") ? ([{}] as never) : realPipeline(commands));
  let queueThrew = false;
  try {
    await heldQueue(id, t0 + 4);
  } catch {
    queueThrew = true;
  }
  redis.pipeline = realPipeline;
  is("an unknown queue read is an error, never an empty queue", queueThrew, true);

  part("Wired into the community: a member's post or comment asks first");
  const route = read("app/api/store/community/route.ts");
  is("a post asks the space's rule before it is written", /mustHold\([\s\S]*?holdPost\([\s\S]*?createPost\(/.test(route), true);
  is("a comment asks too", /mustHold\([\s\S]*?holdComment\([\s\S]*?addComment\(/.test(route), true);
  is("the creator is never held", /!owner && \(await mustHold\(/.test(route), true);
  const approval = read("app/api/store/community/approval/route.ts");
  is("the creator approves, removes and sets the rule from the studio", ["approve", "remove", "setting"].every((a) => approval.includes(`"${a}"`)), true);
  is("approving is moderation, setting is settings", /\? "settings" : "community"/.test(approval), true);
  is("the feed shows the author's own waiting posts", /heldOf\(/.test(read("app/[handle]/community/page.tsx")), true);
  is("a post's page shows the author's own waiting comments", /heldOf\(/.test(read("app/[handle]/community/post/[post]/page.tsx")), true);

  part("Words: in every store language, and the state said in text");
  for (const language of LANGUAGE_CODES) {
    const w = approvalWords(language);
    is(`${language}: every word is there`, [w.waiting, w.waitingNote, w.notices.held, w.notices.heldcomment, w.notices.heldfull, w.notices.withdrawn, w.removed(""), w.removed("x"), w.expired, w.takeBack, w.dismiss, w.unreadable].every((s) => typeof s === "string" && s.length > 2), true);
  }
  is("English says it plainly", approvalWords("en").waiting, "Waiting for approval");
  is("the expiry the words promise is the code's", approvalWords("en").expired.includes(`${HELD_DAYS} days`), true);
  is("the wait is 30 days", HELD_DAYS, 30);
  is("the privacy policy names the 30 days, from the code's own figure", /waiting for approval[\s\S]{0,400}\{HELD_DAYS\} days/i.test(read("app/privacy/page.tsx")) && /import \{[^}]*HELD_DAYS[^}]*\} from "@\/lib\/community-approval-rules"/.test(read("app/privacy/page.tsx")), true);
  is("the terms say the creator may hold posts", /waiting for approval/i.test(read("app/terms/page.tsx")), true);
  is("the creator is never held in the studio's words either", CREATOR, "creator");

  done();
}

void main();
