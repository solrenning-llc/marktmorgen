/**
 * Lesson comments read exactly (rule 24, r24 fresh-2 unit 4). A reply of
 * another shape is never "comments on", never "no name yet" and never "no
 * comments" or "0 new": it throws, and the studio says the comments could not
 * be loaded. Confirmed absence (GET null, HGET null, an empty index) keeps
 * its meaning. Synthetic Redis only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { addComment, commenterName, commentsOn, freshCounts, markSeen, recentComments, setCommentsOn } from "@/lib/lesson-comments";
import { CourseCommentsStudio } from "@/components/course-comments-studio";
import { CourseToggle } from "@/components/course-toggle";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { dataUsed } from "@/lib/store-data";

const COURSE = "e".repeat(32), LESSON = "lessonone001", STUDENT = "synthetic-student-key";
type Commands = (string | number)[][];

/** Runs `body` with every pipeline whose first command is `match` answered by `reply`; the rest reach the stub. */
async function answering<T>(match: (command: (string | number)[]) => boolean, reply: () => unknown, body: () => Promise<T>, seen?: Commands[]): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: Commands) => {
    seen?.push(commands);
    if (commands.length && match(commands[0])) return reply() as never;
    return original(commands);
  };
  try {
    return await body();
  } finally {
    redis.pipeline = original;
  }
}

const malformed: [string, () => unknown][] = [
  ["a missing envelope", () => []],
  ["an extra reply", () => [null, null]],
  ["a number", () => [42]],
  ["a list", () => [["1"]]],
  ["a hole", () => new Array(1)],
  ["a getter", () => Object.defineProperty([null], "0", { get: () => null })],
];

test("comments on: confirmed absence is on, the creator's mark is off", async () => {
  redis.clear();
  assert.equal(await commentsOn(COURSE), true);
  await setCommentsOn(COURSE, false);
  assert.equal(await commentsOn(COURSE), false);
});

for (const [label, reply] of [...malformed, ["another text", () => ["0"]] as [string, () => unknown]]) {
  test(`comments on: ${label} is unknown, never on`, async () => {
    redis.clear();
    await setCommentsOn(COURSE, false);
    await assert.rejects(answering((c) => c[0] === "GET" && String(c[1]).endsWith(":off"), reply, () => commentsOn(COURSE)));
  });
}

test("a student's name: confirmed absence is no name yet, a text is the name", async () => {
  redis.clear();
  assert.equal(await commenterName(COURSE, STUDENT), "");
  const first = await addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Hello", now: 100 });
  assert.ok(first.ok);
  assert.equal(await commenterName(COURSE, STUDENT), "Dana");
});

for (const [label, reply] of malformed) {
  test(`a student's name: ${label} is unknown, never "no name yet"`, async () => {
    redis.clear();
    await assert.rejects(answering((c) => c[0] === "HGET" && String(c[1]).endsWith(":names"), reply, () => commenterName(COURSE, STUDENT)));
  });
}

const charges = (log: Commands[]) => log.filter((p) => p.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"))).length;
const nameWrites = (log: Commands[]) => log.filter((p) => p.some((c) => (c[0] === "HSET" || c[0] === "HSETNX") && String(c[1]).endsWith(":names"))).length;

test("a name given the first time is charged and written once", async () => {
  redis.clear();
  const log: Commands[] = [];
  const first = await answering(() => false, () => null, () => addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Hello", now: 100 }), log);
  assert.ok(first.ok);
  assert.equal(nameWrites(log), 1);
  assert.equal(charges(log), 2, "the name, then the comment");
});

test("a name given again keeps the one chosen before and is not charged twice", async () => {
  redis.clear();
  assert.ok((await addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Hello", now: 100 })).ok);
  const log: Commands[] = [];
  const again = await answering(() => false, () => null, () => addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Again", now: 101 }), log);
  assert.ok(again.ok);
  assert.equal(again.comment.name, "Dana");
  assert.equal(nameWrites(log), 0);
  assert.equal(charges(log), 1, "only the comment");
});

for (const [label, reply] of malformed) {
  for (const given of ["Dana", ""]) {
    test(`an unreadable stored name refuses the comment, with nothing charged or written: ${label}, name ${given ? "given" : "not given"}`, async () => {
      redis.clear();
      assert.ok((await addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Hello", now: 100 })).ok);
      const log: Commands[] = [];
      let result: unknown = "threw";
      try {
        result = await answering((c) => c[0] === "HGET" && String(c[1]).endsWith(":names"), reply, () =>
          addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: given, text: "Again", now: 101 }), log);
      } catch {
        result = "threw";
      }
      assert.equal(result, "threw");
      assert.equal(charges(log), 0);
      assert.equal(nameWrites(log), 0);
    });
  }
}

/**
 * Two first posts by one student at once (Codex V MEDIUM on #3554): the first two name reads are held until both
 * have started and answered "no name yet", as two requests racing would see them.
 */
async function racingFirstPosts(names: [string, string]) {
  const original = redis.pipeline.bind(redis);
  let held = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => (release = resolve));
  redis.pipeline = async (commands: Commands) => {
    if (held < 2 && commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).endsWith(":names")) {
      held += 1;
      if (held === 2) release();
      await bothStarted;
      return [null] as never;
    }
    return original(commands);
  };
  try {
    return await Promise.all(names.map((name, i) => addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name, text: `First ${i}`, now: 100 + i })));
  } finally {
    redis.pipeline = original;
  }
}

test("two first posts at once with different names: both comments and the kept name carry the one that won", async () => {
  redis.clear();
  const [a, b] = await racingFirstPosts(["Dana", "Eli"]);
  assert.ok(a.ok && b.ok);
  const kept = await commenterName(COURSE, STUDENT);
  assert.ok(kept === "Dana" || kept === "Eli");
  assert.equal(a.comment.name, kept);
  assert.equal(b.comment.name, kept);
});

test("two first posts at once with the same name: the name is charged once, as two posts one after the other", async () => {
  redis.clear();
  assert.ok((await addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "First 0", now: 100 })).ok);
  assert.ok((await addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "First 1", now: 101 })).ok);
  const sequential = (await dataUsed(ROOM))?.used;
  assert.equal(typeof sequential, "number");
  redis.clear();
  const [a, b] = await racingFirstPosts(["Dana", "Dana"]);
  assert.ok(a.ok && b.ok);
  assert.equal((await dataUsed(ROOM))?.used, sequential);
});

for (const [label, reply] of malformed) {
  test(`a name claim whose reply is not exact writes no post: ${label}; confirmed absence gives the charge back`, async () => {
    redis.clear();
    const before = (await dataUsed(ROOM))?.used;
    const result = await answering((c) => c[0] === "HSETNX" && String(c[1]).endsWith(":names"), reply, () =>
      addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Hello", now: 100 }));
    assert.deepEqual(result, { ok: false, reason: "unknown" });
    assert.equal(await commenterName(COURSE, STUDENT), "");
    assert.equal((await dataUsed(ROOM))?.used, before, "nothing was kept, so nothing stays charged");
  });
}

test("a name claim whose reply was lost after it was written keeps the charge and writes no post", async () => {
  redis.clear();
  const before = (await dataUsed(ROOM))?.used ?? 0;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: Commands) => {
    const reply = await original(commands);
    if (commands.length === 1 && commands[0][0] === "HSETNX") throw new Error("synthetic lost reply");
    return reply;
  };
  let result: unknown;
  try {
    result = await addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Hello", now: 100 });
  } finally {
    redis.pipeline = original;
  }
  assert.deepEqual(result, { ok: false, reason: "unknown" });
  assert.equal(await commenterName(COURSE, STUDENT), "Dana");
  assert.ok(((await dataUsed(ROOM))?.used ?? 0) > before, "the name is kept, so its charge stays");
});

async function oneComment() {
  redis.clear();
  const posted = await addComment({ room: ROOM, courseId: COURSE, lessonId: LESSON, by: STUDENT, name: "Dana", text: "Hello", now: 100 });
  assert.ok(posted.ok);
  return posted.comment;
}

test("the studio's list: an empty course is confirmed empty, a comment is new until seen", async () => {
  redis.clear();
  assert.deepEqual(await recentComments(COURSE), { comments: [], fresh: 0, seen: 0 });
  assert.equal((await freshCounts([COURSE])).get(COURSE), 0);
  const comment = await oneComment();
  const recent = await recentComments(COURSE);
  assert.deepEqual(recent.comments.map((c) => c.id), [comment.id]);
  assert.equal(recent.fresh, 1);
  assert.equal((await freshCounts([COURSE])).get(COURSE), 1);
  await markSeen(COURSE, 200);
  assert.equal((await recentComments(COURSE)).fresh, 0);
  assert.equal((await freshCounts([COURSE])).get(COURSE), 0);
});

const listReplies: [string, (command: (string | number)[]) => boolean, () => unknown][] = [
  ["a missing envelope", (c) => c[0] === "ZREVRANGE", () => []],
  ["a short envelope", (c) => c[0] === "ZREVRANGE", () => [[]]],
  ["a number for the list", (c) => c[0] === "ZREVRANGE", () => [5, null]],
  ["a bad id in the list", (c) => c[0] === "ZREVRANGE", () => [["../bad"], null]],
  ["a getter in the list", (c) => c[0] === "ZREVRANGE", () => [Object.defineProperty([""], "0", { get: () => "abc000000001" }), null]],
  ["an unreadable seen time", (c) => c[0] === "ZREVRANGE", () => [[], "soon"]],
  ["a missing count", (c) => c[0] === "ZCOUNT", () => []],
  ["a text count", (c) => c[0] === "ZCOUNT", () => ["3", [null]]],
  ["a negative count", (c) => c[0] === "ZCOUNT", () => [-1, [null]]],
  ["a short row list", (c) => c[0] === "ZCOUNT", () => [1, []]],
  ["an unreadable row", (c) => c[0] === "ZCOUNT", () => [1, ["{"]]],
];

for (const [label, match, reply] of listReplies) {
  test(`the studio's list: ${label} is unknown, never "no comments" or 0 new`, async () => {
    await oneComment();
    await assert.rejects(answering(match, reply, () => recentComments(COURSE)));
  });
}

const countReplies: [string, (command: (string | number)[]) => boolean, () => unknown][] = [
  ["a missing seen time", (c) => c[0] === "GET", () => []],
  ["an unreadable seen time", (c) => c[0] === "GET", () => ["soon"]],
  ["a missing count", (c) => c[0] === "ZCOUNT", () => []],
  ["a text count", (c) => c[0] === "ZCOUNT", () => ["2"]],
  ["a fractional count", (c) => c[0] === "ZCOUNT", () => [1.5]],
];

for (const [label, match, reply] of countReplies) {
  test(`the studio's count of new comments: ${label} is unknown, never 0`, async () => {
    await oneComment();
    await assert.rejects(answering(match, reply, () => freshCounts([COURSE])));
  });
}

function studio(props: { initialOn: boolean | null; unread?: boolean }) {
  return renderToStaticMarkup(
    createElement(CourseCommentsStudio, { productId: "p1", storeName: "Synthetic store", initial: [], lessonHref: null, now: 0, ...props } as never),
  );
}

test("the studio says the comments could not be loaded, never that there are none", () => {
  const html = studio({ initialOn: true, unread: true });
  assert.match(html, /could not be loaded/);
  assert.doesNotMatch(html, /No comments yet/);
  assert.match(studio({ initialOn: true }), /No comments yet/);
});

test("the studio says whether comments are on could not be read, never On or Off", () => {
  const html = studio({ initialOn: null });
  assert.match(html, /could not be read/);
  assert.doesNotMatch(html, />On<|>Off</);
  // Codex X6's LOW (and Claude's earlier LOW) on #3554: beside "Comments under lessons", a tag "Not read" reads like
  // "the comments are unread". The tag says the state is unknown; the paragraph below says why (AX274 3.1.5).
  assert.match(html, /<span class="tag ">Unknown<\/span>/);
  assert.doesNotMatch(html, />Not read</);
});

function toggle(newComments: number | null) {
  const product = { id: "p1", title: "Synthetic course", priceCents: 1000, options: [], course: { id: COURSE, lessons: 2 } };
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(CourseToggle, { product: product as never, newComments })));
}

test("the studio's product list says new comments could not be loaded, never nothing", () => {
  assert.match(toggle(null), /could not be loaded/);
  assert.match(toggle(2), /2 new comments to read/);
  assert.doesNotMatch(toggle(0), /comment/);
});

test("the studio pages keep an unread list or count apart from none", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const course = read("app/studio/course/[product]/page.tsx");
  assert.match(course, /recentComments\(course\.id, 50\)\.catch\(\(\) => null\)/);
  assert.match(course, /if \(recent\) await markSeen\(course\.id\)/, "comments not shown are not marked seen");
  const studioPage = read("app/studio/page.tsx");
  assert.doesNotMatch(studioPage, /freshCounts\([^)]*\)\)\.catch\(\(\) => new Map/);
  const editor = read("components/product-editor.tsx");
  assert.doesNotMatch(editor, /newComments\[product\.id\] \?\? 0/);
});
