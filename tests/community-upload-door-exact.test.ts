/**
 * A member's door into the file store for a post picture
 * (app/api/store/community/upload/route.ts) is given only once Redis
 * answered, exactly, that the door is noted for this member and listed for
 * the sweep (lib/community-files.ts noteCommunityUpload; CX-123 rule 24,
 * audit R24 round 8, item 7). A door given without its listing lets a file
 * stay in the paid file store for ever, and its place never comes back.
 *
 * - A reply in another shape, or none: no door; the place this request took
 *   comes back once, a day on, through the sweep.
 * - A path that already had a door: no door, and the place this request took
 *   goes back at once; the earlier door is left as it was.
 * - A path already in a post (its door used): a failed request for it again
 *   never makes the sweep delete the post's picture (Codex Z on #3305, M1).
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/community/upload/route";
import { noteCommunityUpload, picturesKept, sweepCommunityUploads, takeCommunityUpload, takePicturePlace } from "@/lib/community-files";
import { communityFolder } from "@/lib/community-image";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { COMMUNITY_ID, MEMBER, deleted, files, tokens } from "./community-upload-door-exact-world";

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);
const folder = communityFolder(COMMUNITY_ID);
const DAY = 86_400_000;
let n = 0;
const freshPath = () => `community/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
const isNote = (commands: Command[]) => commands.length === 2 && commands[0][0] === "SET" && commands[1][0] === "ZADD";
const listed = async (path: string) => (await original([["ZSCORE", "nl:cimg:doors", path]]))[0] !== null;
const throwsBeforeSending = () =>
  ((async (commands: Command[]) => {
    if (isNote(commands)) throw new Error("the connection failed before the note was sent");
    return original(commands);
  }) as typeof redis.pipeline);

function reset(): void {
  redis.pipeline = original;
  redis.clear();
  tokens.length = 0;
  deleted.length = 0;
  files.clear();
}

/** A picture already in a post: its door was given, its file sent, and the post took it (takeCommunityUpload). */
async function inAPost(): Promise<string> {
  const path = freshPath();
  is("a place is taken for the picture", await takePicturePlace(path, 50), true);
  is("its door is noted", await noteCommunityUpload(path, MEMBER), true);
  files.add(path);
  is("the post takes it", await takeCommunityUpload(path, MEMBER), true);
  is("no longer a door to sweep", [await listed(path), await picturesKept(folder)], [false, 1]);
  return path;
}

async function ask(path: string): Promise<{ status: number; error: string | null; door: boolean }> {
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/store/community/upload", {
      method: "POST",
      headers: { "content-type": "application/json", host: "marktmorgen.com" },
      body: JSON.stringify({ pathname: path, clientPayload: JSON.stringify({ handle: "doorshop" }) }),
    }),
  );
  const body = (await response.json()) as { error?: string };
  return { status: response.status, error: body.error ?? null, door: tokens.includes(path) };
}

/** The note's pipeline answered as `answer` says, after it ran in full (`landed`) or with only its SET. */
function answerNote(answer: (replies: unknown[]) => unknown, landed: "both" | "set only" | "none" = "both"): void {
  redis.pipeline = (async (commands: Command[]) => {
    if (!isNote(commands)) return original(commands);
    const ran = landed === "both" ? await original(commands) : landed === "set only" ? [...(await original([commands[0]])), null] : [null, null];
    return answer(ran);
  }) as typeof redis.pipeline;
}

async function sweptADayOn(): Promise<number> {
  redis.pipeline = original;
  return sweepCommunityUploads(Date.now() + 2 * DAY);
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const quiet = console.error;
  console.error = () => {};
  try {
    part("Control: a confirmed note gives the door, and the sweep finds it");
    {
      reset();
      const path = freshPath();
      is("the door is given", await ask(path), { status: 200, error: null, door: true });
      is("listed, and its place taken", [await listed(path), await picturesKept(folder)], [true, 1]);
      is("never used, it is swept a day on and its place comes back", [await sweptADayOn(), deleted.includes(path), await picturesKept(folder)], [1, true, 0]);
    }

    part("A note answered in another shape gives no door; the place comes back through the sweep");
    const odd: [string, (replies: unknown[]) => unknown, "both" | "set only" | "none"][] = [
      ["ZADD landed, answered as text", (r) => [r[0], "1"], "both"],
      ["ZADD landed, answered true", (r) => [r[0], true], "both"],
      ["ZADD landed, answered 2", (r) => [r[0], 2], "both"],
      ["ZADD not carried out, answered as text", (r) => [r[0], "1"], "set only"],
      ["ZADD not carried out, answered null", (r) => [r[0], null], "set only"],
      ["SET landed, answered 1", (r) => [1, r[1]], "both"],
      ["SET landed, answered true", (r) => [true, r[1]], "both"],
      ["SET landed, answered lowercase", (r) => ["ok", r[1]], "both"],
      ["one reply for two commands", (r) => [r[0]], "both"],
      ["three replies", (r) => [...r, 1], "both"],
      ["not a list", () => null, "both"],
      ["nothing carried out, answered empty", () => [], "none"],
    ];
    for (const [label, answer, landed] of odd) {
      reset();
      const path = freshPath();
      answerNote(answer, landed);
      const result = await ask(path);
      redis.pipeline = original;
      is(`${label}: no door`, [result.status, result.error, result.door], [500, "server_error", false]);
      is(`${label}: its place still counted`, await picturesKept(folder), 1);
      await sweptADayOn();
      is(`${label}: a day on its place comes back`, await picturesKept(folder), 0);
    }

    part("A note that throws gives no door; the place comes back through the sweep");
    {
      reset();
      const path = freshPath();
      redis.pipeline = (async (commands: Command[]) => {
        if (!isNote(commands)) return original(commands);
        await original(commands);
        throw new Error("the database did not answer in time");
      }) as typeof redis.pipeline;
      const result = await ask(path);
      redis.pipeline = original;
      is("no door", [result.status, result.door], [500, false]);
      is("its place counted", await picturesKept(folder), 1);
      await sweptADayOn();
      is("given back a day on", await picturesKept(folder), 0);
    }
    {
      reset();
      const path = freshPath();
      redis.pipeline = throwsBeforeSending();
      const result = await ask(path);
      redis.pipeline = original;
      is("never sent: no door", [result.status, result.door], [500, false]);
      is("never sent: its place counted", await picturesKept(folder), 1);
      await sweptADayOn();
      is("never sent: given back a day on", await picturesKept(folder), 0);
    }

    part("Two failed requests for the same new path: each place comes back once, a day on");
    {
      reset();
      const path = freshPath();
      redis.pipeline = throwsBeforeSending();
      const first = await ask(path);
      const second = await ask(path);
      redis.pipeline = original;
      is("no door either time", [first.status, first.door, second.status, second.door], [500, false, 500, false]);
      is("both places counted", await picturesKept(folder), 2);
      await sweptADayOn();
      is("both given back a day on, once each", await picturesKept(folder), 0);
      is("a later sweep gives nothing more back", [await sweptADayOn(), await picturesKept(folder)], [0, 0]);
    }

    part("A note that landed and then threw: its place comes back once, whatever order the sweep reads it in");
    // [label, a failure once, how many the sweep reads a run]: one at a time, or the doubt and its path in one run.
    const sweeps: [string, (commands: Command[]) => Promise<unknown> | null, number][] = [
      ["read one at a time", () => null, 1],
      ["read together", () => null, 300],
      [
        "the doubt's removal never sent, then read again",
        (commands) => {
          if (commands[0][0] === "ZREM" && String(commands[0][2]).startsWith("?")) return Promise.reject(new Error("the connection failed before the removal was sent"));
          return null;
        },
        300,
      ],
      [
        "the doubt's removal carried out, then no answer",
        (commands) => {
          if (commands[0][0] === "ZREM" && String(commands[0][2]).startsWith("?")) return original(commands).then(() => Promise.reject(new Error("the answer was lost")));
          return null;
        },
        300,
      ],
    ];
    for (const [label, failOnce, most] of sweeps) {
      reset();
      const kept = await inAPost();
      const path = freshPath();
      redis.pipeline = (async (commands: Command[]) => {
        if (!isNote(commands)) return original(commands);
        await original(commands);
        throw new Error("the database did not answer in time");
      }) as typeof redis.pipeline;
      const result = await ask(path);
      is(`${label}: no door`, [result.status, result.door], [500, false]);
      is(`${label}: the note listed the path, and both places are counted`, [await listed(path), await picturesKept(folder)], [true, 2]);
      let failed = false;
      redis.pipeline = (async (commands: Command[]) => {
        if (!failed) {
          const answer = failOnce(commands);
          if (answer) {
            failed = true;
            return answer;
          }
        }
        return original(commands);
      }) as typeof redis.pipeline;
      for (let run = 0; run < 4; run++) await sweepCommunityUploads(Date.now() + 2 * DAY, most);
      redis.pipeline = original;
      is(`${label}: its place came back once; the post's picture and place are kept`, [await picturesKept(folder), files.has(kept), await listed(path)], [1, true, false]);
    }

    part("A path already in a post: a failed request for it again never makes the sweep delete its picture");
    const again: [string, () => typeof redis.pipeline][] = [
      ["the note never sent", throwsBeforeSending],
      [
        "the note answered nothing, nothing carried out",
        () =>
          ((async (commands: Command[]) => (isNote(commands) ? [] : original(commands))) as typeof redis.pipeline),
      ],
      [
        "only the note's SET carried out, answered in another shape",
        () =>
          ((async (commands: Command[]) => (isNote(commands) ? [(await original([commands[0]]))[0], "1"] : original(commands))) as typeof redis.pipeline),
      ],
    ];
    for (const [label, pipeline] of again) {
      reset();
      const path = await inAPost();
      redis.pipeline = pipeline();
      const result = await ask(path);
      redis.pipeline = original;
      is(`${label}: no door`, [result.status, result.error, result.door], [500, "server_error", false]);
      is(`${label}: the post's place and this request's are counted`, await picturesKept(folder), 2);
      await sweptADayOn();
      is(`${label}: a day on, the post's picture is still there`, [files.has(path), deleted.includes(path)], [true, false]);
      is(`${label}: only this request's place came back`, await picturesKept(folder), 1);
    }

    part("A path that already had a door: no door, and this request's place goes back at once");
    {
      reset();
      const path = freshPath();
      // Somebody's earlier door on this path, with its own place and listing.
      await takePicturePlace(path, 50);
      await noteCommunityUpload(path, "other-member");
      const result = await ask(path);
      is("no door for this member", [result.status, result.error, result.door], [400, "invalid", false]);
      is("only the earlier door's place is counted", await picturesKept(folder), 1);
      is("the earlier door is left as it was", [await listed(path), await takeCommunityUpload(path, "other-member")], [true, true]);
      is("and this member cannot use it", await takeCommunityUpload(path, MEMBER), false);
    }

    part("noteCommunityUpload reads its two replies exactly");
    const shapes: [string, unknown, boolean | "unknown"][] = [
      ["noted and listed", ["OK", 1], true],
      ["noted, already listed", ["OK", 0], true],
      ["a door there already", [null, 0], false],
      ["a door there already, listed now", [null, 1], false],
      ["SET as text", ["1", 1], "unknown"],
      ["ZADD as text", ["OK", "1"], "unknown"],
      ["ZADD negative", ["OK", -1], "unknown"],
      ["ZADD fraction", ["OK", 0.5], "unknown"],
      ["ZADD missing", ["OK"], "unknown"],
      ["an object", { 0: "OK", 1: 1, length: 2 }, "unknown"],
    ];
    for (const [label, reply, expected] of shapes) {
      reset();
      redis.pipeline = (async () => reply) as unknown as typeof redis.pipeline;
      let got: unknown;
      try {
        got = await noteCommunityUpload(freshPath(), MEMBER);
      } catch (error) {
        got = error instanceof UnknownReplyError ? "unknown" : `threw: ${(error as Error).message}`;
      }
      redis.pipeline = original;
      is(label, got, expected);
    }
  } finally {
    console.error = quiet;
    redis.pipeline = original;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
