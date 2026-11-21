/**
 * The daily sweep of students' uploads never handed in (app/api/cron/courses,
 * lib/assignment.ts), found by Claude 5 on #2836 (comment 6702280589):
 *
 *   - a hand-in that takes a file's door (takeTaskUpload) between the sweep's
 *     read of the list and its removal keeps its file: the sweep deletes only
 *     the paths whose ZREM it won itself, exactly 1;
 *   - a deletion that fails puts the path back on the list, so the next run
 *     deletes it; this is also where a deleted person's files go when the
 *     file store did not answer (lib/person-erasure.ts, noteTaskUpload(path, 0));
 *   - a reply in another shape (CX-123 rule 24) deletes nothing it cannot
 *     prove was the sweep's own: the list read, the pipeline's length and each
 *     ZREM's answer are read exactly.
 *
 * The real cron route is called as Vercel calls it (no CRON_SECRET set and not
 * production, so the local run is let in). Redis is tests/redis-stub.ts; the
 * files are in the stand-in vault (R2 settings set to synthetic values,
 * fetch replaced), so every DELETE the sweep sends is seen and can be made to
 * fail. Nothing real is reached.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { GET as coursesCron } from "@/app/api/cron/courses/route";
import { DOOR_SECONDS, noteTaskUpload, takeTaskUpload } from "@/lib/assignment";

type Commands = (string | number)[][];
const DOORS = "nl:tasks:doors";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "marktmorgen-files";
const FOLDER = "fedcba9876543210fedcba9876543210";
const realPipeline = redis.pipeline.bind(redis);
const realFetch = globalThis.fetch;
const deletes: string[] = [];
let deleteStatus = 204;
/** Paths whose DELETE always fails (500), whatever deleteStatus says. */
const poisoned = new Set<string>();

const path = (name: string) => `vault/${FOLDER}/tasks/${name}.pdf`;
const stale = () => Date.now() - (DOOR_SECONDS + 60) * 1000;
const run = async () => (await (await coursesCron(new NextRequest("https://local.example/api/cron/courses"))).json()) as { ok: boolean; unusedUploads?: number };
const onList = (p: string) => redis.run(["ZSCORE", DOORS, p]) !== null;

beforeEach(() => {
  redis.clear();
  redis.pipeline = realPipeline;
  deletes.length = 0;
  deleteStatus = 204;
  poisoned.clear();
  Object.assign(process.env, {
    RESEND_API_KEY: "re_test_task_upload_sweep_stand_in",
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: BUCKET,
    R2_ACCESS_KEY_ID: "TASKSWEEPKEY0000001",
    R2_SECRET_ACCESS_KEY: "s".repeat(40),
  });
  delete process.env.CRON_SECRET;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === `${ACCOUNT}.r2.cloudflarestorage.com` && init?.method === "DELETE") {
      const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
      deletes.push(key);
      return new Response(null, { status: poisoned.has(key) ? 500 : deleteStatus });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  redis.pipeline = realPipeline;
  globalThis.fetch = realFetch;
});

/** Every pipeline sent while `run` goes, and the replies of the ones `edit` changes after they really ran. */
async function watching<T>(edit: (commands: Commands, replies: unknown[]) => unknown[] | undefined | Promise<undefined>, go: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = (await realPipeline(commands)) as unknown[];
    return (await edit(commands, replies)) ?? replies;
  }) as typeof redis.pipeline;
  try {
    return await go();
  } finally {
    redis.pipeline = realPipeline;
  }
}

const isDoorRange = (commands: Commands) => commands[0]?.[0] === "ZRANGEBYSCORE" && commands[0]?.[1] === DOORS;
const isDoorTake = (commands: Commands) => commands.length > 0 && commands.every((c) => c[0] === "ZREM" && c[1] === DOORS);

test("healthy: a stale upload is deleted once, a fresh one is left, and a second run deletes nothing again", async () => {
  await noteTaskUpload(path("old"), stale());
  await noteTaskUpload(path("new"), Date.now());
  const first = await run();
  assert.equal(first.ok, true);
  assert.deepEqual(deletes, [path("old")]);
  assert.equal(first.unusedUploads, 1);
  assert.equal(onList(path("old")), false, "a deleted file's door is gone");
  assert.equal(onList(path("new")), true, "a fresh door stays");
  await run();
  assert.deepEqual(deletes, [path("old")], "nothing deleted twice");
});

test("healthy: a hand-in that won the door before the sweep keeps its file", async () => {
  await noteTaskUpload(path("handed"), stale());
  assert.equal(await takeTaskUpload(path("handed")), true);
  await run();
  assert.deepEqual(deletes, []);
});

test("the sweep does not hand the cron a file a hand-in already took", async () => {
  await noteTaskUpload(path("handed"), stale());
  await noteTaskUpload(path("left"), stale());
  let raced = false;
  const outcome = await watching(
    async (commands) => {
      if (!raced && isDoorRange(commands)) {
        raced = true;
        // The student's hand-in takes the door right after the sweep read the list, before it took anything off it.
        assert.equal(await takeTaskUpload(path("handed")), true, "the hand-in won the door");
      }
      return undefined;
    },
    run,
  );
  assert.equal(raced, true);
  assert.equal(deletes.includes(path("handed")), false, "the handed-in file is not deleted");
  assert.deepEqual(deletes, [path("left")], "the one nobody took is");
  assert.equal(outcome.unusedUploads, 1);
});

test("a leftover whose deletion failed is found again by the next run", async () => {
  // As lib/person-erasure.ts hands a deleted person's files to the sweep when the file store did not answer.
  await noteTaskUpload(path("erased"), 0);
  deleteStatus = 500;
  await run();
  assert.deepEqual(deletes, [path("erased")], "the first run tried");
  assert.equal(onList(path("erased")), true, "and put it back when it failed");
  deleteStatus = 204;
  await run();
  assert.deepEqual(deletes, [path("erased"), path("erased")], "the next run deletes it");
  assert.equal(onList(path("erased")), false);
});

for (const [label, reply] of [
  ["the text \"1\"", "1"],
  ["2", 2],
  ["-1", -1],
  ["null", null],
  ["true", true],
  ["1.5", 1.5],
  ["an object", { result: 1 }],
  ["a list", [1]],
] as [string, unknown][]) {
  test(`a ZREM answered ${label} deletes nothing`, async () => {
    await noteTaskUpload(path("unknown"), stale());
    const outcome = await watching((commands, replies) => (isDoorTake(commands) ? replies.map(() => reply) : undefined), run);
    assert.equal(outcome.ok, true, "the rest of the job still answers");
    assert.deepEqual(deletes, [], "no file whose door the sweep cannot prove it won is deleted");
  });
}

for (const [label, edit] of [
  ["a list holding a number", (replies: unknown[]) => [[path("listed"), 7], ...replies.slice(1)]],
  ["an object, not a list", (replies: unknown[]) => [{ 0: path("listed") }, ...replies.slice(1)]],
  ["no reply at all", () => []],
  ["two replies for one command", (replies: unknown[]) => [...replies, [path("listed")]]],
] as [string, (replies: unknown[]) => unknown[]][]) {
  test(`the list read answered as ${label} deletes nothing`, async () => {
    await noteTaskUpload(path("listed"), stale());
    await watching((commands, replies) => (isDoorRange(commands) ? edit(replies) : undefined), run);
    assert.deepEqual(deletes, []);
    assert.equal(onList(path("listed")), true, "and leaves the door for a later run");
  });
}

test("one ZREM won and one in an unknown shape: only the won file is deleted, and the job still answers", async () => {
  await noteTaskUpload(path("won"), stale());
  await noteTaskUpload(path("unknown"), stale());
  const outcome = await watching(
    (commands, replies) => (isDoorTake(commands) ? commands.map((c, i) => (c[2] === path("unknown") ? "1" : replies[i])) : undefined),
    run,
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(deletes, [path("won")]);
});

test("cost: the healthy sweep is one list read and one pipeline of one ZREM per stale path, nothing more", async () => {
  for (const name of ["a", "b", "c"]) await noteTaskUpload(path(name), stale());
  const doorPipelines: Commands[] = [];
  await watching((commands) => {
    if (commands.some((c) => c[1] === DOORS)) doorPipelines.push(commands);
    return undefined;
  }, run);
  assert.deepEqual(
    doorPipelines.map((p) => p.map((c) => c[0])),
    [["ZRANGEBYSCORE"], ["ZREM", "ZREM", "ZREM"]],
  );
  assert.equal(deletes.length, 3);
});

// Claude 5's review of #3045 (6704214405).
test("MEDIUM: a path whose deletion always fails holds only itself, never the rest of the batch", async () => {
  await noteTaskUpload(path("poison"), stale());
  await noteTaskUpload(path("good"), stale());
  poisoned.add(path("poison"));
  const outcomes = [await run(), await run(), await run()];
  assert.equal(deletes.filter((d) => d === path("good")).length, 1, "the good file is deleted once, on the first run");
  assert.equal(onList(path("good")), false, "and its door is gone");
  assert.equal(onList(path("poison")), true, "the failing one is put back, alone");
  assert.deepEqual(outcomes.map((o) => o.unusedUploads), [1, 0, 0], "the cron counts what was deleted");
});

test("LOW: with one ZREM unknown and one won, the cron still counts the won file deleted", async () => {
  await noteTaskUpload(path("won"), stale());
  await noteTaskUpload(path("unknown"), stale());
  const outcome = await watching(
    (commands, replies) => (isDoorTake(commands) ? commands.map((c, i) => (c[2] === path("unknown") ? "1" : replies[i])) : undefined),
    run,
  );
  assert.equal(outcome.unusedUploads, 1);
});

test("LOW: the ZREMs go in pipelines of 25, so a reply lost after they ran leaves at most 25 doors off the list", async () => {
  const names = Array.from({ length: 30 }, (_, i) => `many-${String(i).padStart(2, "0")}`);
  for (const name of names) await noteTaskUpload(path(name), stale());
  const sizes: number[] = [];
  await watching((commands) => {
    if (isDoorTake(commands)) sizes.push(commands.length);
    return undefined;
  }, run);
  assert.deepEqual(sizes, [25, 5]);
  assert.equal(deletes.length, 30);

  redis.clear();
  deletes.length = 0;
  for (const name of names) await noteTaskUpload(path(name), stale());
  let first = true;
  const lost = await watching(async (commands) => {
    if (isDoorTake(commands) && first) {
      first = false;
      throw new Error("the reply was lost after the ZREMs ran");
    }
    return undefined;
  }, run);
  assert.equal(lost.ok, true, "the job still answers");
  assert.equal(deletes.length, 5, "the next pipeline's won doors are still deleted");
  assert.equal(names.filter((n) => onList(path(n))).length, 0, "the 25 of the lost reply left the list (their files may stay, as in community-files)");
});
