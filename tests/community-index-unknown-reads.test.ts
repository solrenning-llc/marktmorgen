/**
 * Rule 24 on the community search index: a Redis reply is read in its exact
 * shape, and an unknown one is never taken as "nothing there".
 *
 * Two readers used to do exactly that, and each turned an odd reply into a
 * wrong write that nothing later could see:
 *
 *   - a lesson's text (lib/community-index.ts, lessonBodies): an unreadable or
 *     odd reply became "", and the reindex that followed took every word of
 *     the lesson's text out of the index, so a lesson stopped being findable
 *     by what it says until the creator saved it again;
 *   - the words a thing is indexed under (lib/community-search.ts, index and
 *     unindex): an odd SMEMBERS reply became [], so taking a member out
 *     deleted the set of their words and left them under every one of those
 *     words for good, and an erasure (lib/community-erasure.ts) that called it
 *     reported the person gone while their name stayed in the index.
 *
 * Synthetic data and the in-memory store only.
 */
import { courseChanged, lessonBodies, reindexCourse, indexMember, unindexMember } from "@/lib/community-index";
import { index, search, unindex } from "@/lib/community-search";
import type { Course } from "@/lib/course";
import type { Listing } from "@/lib/catalog";
import type { Member } from "@/lib/community";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const CM = "c1dec0de0000000000000000000c1dec";
const COURSE = "0123456789abcdef0123456789abcdef";
const LESSON = "lesson000001";
const product = { id: "prod1", title: "Field notes" } as unknown as Listing;
const course = {
  id: COURSE,
  modules: [{ id: "module000001", title: "Basics", dripDays: 0, lessons: [{ id: LESSON, title: "Opening", preview: false, video: null, files: [], link: null, hasBody: true }] }],
  certificate: false,
} as unknown as Course;
const bodyKey = `nl:course:${COURSE}:body:${LESSON}`;
const lessonWords = `nl:cm:${CM}:wil:prod1.${LESSON}`;
const memberWords = `nl:cm:${CM}:wim:mem1`;

const found = async (raw: string, kind: "lesson" | "member") => (await search(CM, raw, null, kind)).posts;

const real = redis.pipeline;
/** Answers one command in a shape the store never gives, or throws on it. */
function answer(match: (command: (string | number)[]) => boolean, reply: unknown | "throw"): void {
  redis.pipeline = async (commands) => {
    if (reply === "throw" && commands.some(match)) throw new Error("Redis request failed with status 503");
    const out = await real(commands);
    return out.map((one, at) => (match(commands[at]) ? reply : one));
  };
}
const healthy = () => {
  redis.pipeline = real;
};
const isGet = (key: string) => (c: (string | number)[]) => c[0] === "GET" && c[1] === key;
const isSmembers = (key: string) => (c: (string | number)[]) => c[0] === "SMEMBERS" && c[1] === key;

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

const ODD: [string, unknown][] = [
  ["a number", 7],
  ["a list", ["Learn the quinoa margins"]],
  ["an object", { value: "Learn the quinoa margins" }],
  ["a boolean", true],
];

async function lessonSetup(): Promise<void> {
  healthy();
  redis.clear();
  await redis.pipeline([["SET", bodyKey, "Learn the quinoa margins"]]);
  await reindexCourse(CM, product, course);
}

async function main(): Promise<void> {
  part("Control: a lesson is findable by its text and its title");
  await lessonSetup();
  is("found by a word of its text", await found("quinoa", "lesson"), [`prod1.${LESSON}`]);
  is("found by its title", await found("opening", "lesson"), [`prod1.${LESSON}`]);
  is("its text is read as written", await lessonBodies(course), ["Learn the quinoa margins"]);

  part("Control: a lesson with no text (an absent key) is indexed by its title alone");
  healthy();
  redis.clear();
  await reindexCourse(CM, product, course);
  is("an absent text reads as empty", await lessonBodies(course), [""]);
  is("still found by its title", await found("opening", "lesson"), [`prod1.${LESSON}`]);

  for (const [what, reply] of [...ODD, ["a failed read", "throw"] as [string, unknown]]) {
    part(`A lesson's text answered as ${what}`);
    await lessonSetup();
    answer(isGet(bodyKey), reply);
    is("reading the texts refuses", await rejects(() => lessonBodies(course)), true);
    is("keeping the index level with the course refuses", await rejects(() => courseChanged(CM, product, course, course)), true);
    healthy();
    is("the lesson is still found by its text", await found("quinoa", "lesson"), [`prod1.${LESSON}`]);
    is("its words are all still kept", ((await redis.pipeline([["SMEMBERS", lessonWords]]))[0] as string[]).includes("quinoa"), true);
  }

  part("Control: taking a member out takes every word out");
  healthy();
  redis.clear();
  await index(CM, "member", "mem1", 1_700_000_000, ["Zelda Quorn", "zeldaq"]);
  is("found by name before", await found("zelda", "member"), ["mem1"]);
  await unindexMember(CM, "mem1");
  is("not found after", await found("zelda", "member"), []);
  is("and not by the handle", await found("zeldaq", "member"), []);

  part("Control: taking out something never indexed (a confirmed-empty set) is fine");
  healthy();
  redis.clear();
  is("resolves", await rejects(() => unindex(CM, "member", "nobody")), false);

  const SMEMBERS_ODD: [string, unknown][] = [
    ["a number", 3],
    ["a string", "zelda"],
    ["null", null],
    ["a list holding a number", ["zelda", 4]],
    ["an object", { 0: "zelda", length: 1 }],
    ["a failed read", "throw"],
  ];
  const memberSetup = async (reply: unknown) => {
    healthy();
    redis.clear();
    await index(CM, "member", "mem1", 1_700_000_000, ["Zelda Quorn", "zeldaq"]);
    answer(isSmembers(memberWords), reply);
  };
  const wordsKept = async () => [...((await redis.pipeline([["SMEMBERS", memberWords]]))[0] as string[])].sort();
  for (const [what, reply] of SMEMBERS_ODD) {
    part(`A member's words answered as ${what}`);
    await memberSetup(reply);
    is("taking the member out refuses", await rejects(() => unindexMember(CM, "mem1")), true);
    healthy();
    is("the set of their words is still there, so they can still be taken out", await wordsKept(), ["quorn", "zelda", "zeldaq"]);
    await unindexMember(CM, "mem1");
    is("and once the store answers, they are taken out by every word", [await found("zelda", "member"), await found("quorn", "member"), await found("zeldaq", "member")], [[], [], []]);

    await memberSetup(reply);
    is("an erasure that takes them out says it is not done", await rejects(() => forgetCommunityPerson(CM, "mem1", "zelda@example.com", [])), true);
    healthy();
    await forgetCommunityPerson(CM, "mem1", "zelda@example.com", []);
    is("and the erasure run again takes their name out", await found("zelda", "member"), []);

    await memberSetup(reply);
    is("writing their words refuses", await rejects(() => index(CM, "member", "mem1", 1_700_000_000, ["Zelda Quorn"])), true);
    healthy();
    is("and writes nothing", await wordsKept(), ["quorn", "zelda", "zeldaq"]);
  }

  part("A member who leaves the directory while the store answers oddly is not left behind");
  healthy();
  redis.clear();
  const zelda = { k: "mem1", e: "zelda@example.com", n: "Zelda Quorn", h: "zeldaq", dir: true, mail: false, at: 1_700_000_000, seen: 0, muted: false } as unknown as Member;
  await indexMember(CM, zelda);
  answer(isSmembers(memberWords), 9);
  await indexMember(CM, { ...zelda, dir: false });
  healthy();
  await indexMember(CM, { ...zelda, dir: false });
  is("once the store answers, they are out", await found("zelda", "member"), []);
  is("by the handle too", await found("zeldaq", "member"), []);

  healthy();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
