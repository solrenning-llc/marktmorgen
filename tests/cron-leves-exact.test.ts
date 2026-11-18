/**
 * Two daily sweeps read their Redis answers exactly (CX-123 rule 24).
 *
 * 1. The quiet-sales pass (app/api/cron/quiet): where today's walk over the
 *    stores goes on from is read exactly. Nil is the start; a whole number is
 *    the place; anything else is unknown, and the pass reads nothing on it
 *    and leaves the place as it was. A store that cannot be read is tried
 *    again at once; if it still cannot be, it is counted as failed and said in
 *    the log, never passed over as "no store", and the stores after it are
 *    still looked at in the same pass. The next day's walk tries it again.
 * 2. The sweep of community pictures never put in a post
 *    (lib/community-files.ts): a ZREM answered in another shape than 0 or 1
 *    may have taken the picture off the list; it is put back, so a later
 *    sweep deletes it and gives its place back, rather than leaving it kept
 *    and counted for ever; a ZREM that throws (a timeout after it was sent)
 *    is the same. A list of pictures answered in another shape is unknown,
 *    never "none to sweep", and the courses job says so in its log and
 *    answer rather than "0 swept".
 *
 * The quiet pass's place past the end of the day's list is unknown too: the
 * list only grows within a day, so this pass never wrote it.
 *
 * Synthetic data only; the healthy and confirmed answers work as before.
 */
import { GET as quiet } from "@/app/api/cron/quiet/route";
import { GET as courses } from "@/app/api/cron/courses/route";
import { rememberFolderOwner } from "@/lib/delivery";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { communityFolder } from "@/lib/community-image";
import { noteCommunityUpload, picturesKept, sweepCommunityUploads, takePicturePlace } from "@/lib/community-files";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
delete process.env.CRON_SECRET;
delete process.env.BLOB_READ_WRITE_TOKEN;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Command = (string | number)[];
/** What the test does in place of Redis for a command it picks: a reply, or a throw. */
let inject: ((commands: Command[]) => Promise<unknown[]> | null) | null = null;
/** The commands Redis itself answered (not those the test answered or failed). */
let seen: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  const instead = inject?.(commands);
  if (instead) return instead;
  seen.push(...commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

const MALFORMED: [string, () => unknown[]][] = [
  ["no reply at all", () => []],
  ["undefined", () => [undefined]],
  ["QUEUED", () => ["QUEUED"]],
  ["two replies", () => [0, 0]],
];

async function quietPass(): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  const stores: { email: string; folder: string; ownerKey: string }[] = [];
  for (const handle of ["alder", "birch", "cedar"]) {
    const email = `${handle}@example.com`;
    await claimHandle(email, handle, handle, "");
    const store = (await storeForEmail(email))!;
    const folder = await storeFolder(storeRef(store));
    await rememberFolderOwner(folder, email);
    await pipeline([["SADD", `nl:traffic:folders:${month}`, folder]]);
    // The key the store's record is read from, as storeForEmail asks for it.
    seen = [];
    await storeForEmail(email);
    const ownerKey = String(seen.find((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:"))?.[1]);
    stores.push({ email, folder, ownerKey });
  }
  stores.sort((a, b) => (a.folder < b.folder ? -1 : 1));
  const at = `nl:quiet:at:${new Date().toISOString().slice(0, 10)}`;
  const run = async () => {
    seen = [];
    const response = await quiet({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/quiet") } as unknown as Parameters<typeof quiet>[0]).catch(() => null);
    // A store looked at is one whose record was read.
    const looked = stores.map((s, i) => (seen.some((c) => c[0] === "GET" && c[1] === s.ownerKey) ? i : -1)).filter((i) => i >= 0);
    const [place] = await pipeline([["GET", at]]);
    const body = response ? ((await response.json()) as { failed?: number }) : {};
    return { status: response?.status ?? -1, looked, place, failed: body.failed ?? null };
  };

  part("Quiet pass: where the walk goes on from, read exactly");
  is("nothing kept yet (nil): every store looked at, the place kept at the end", await run(), { status: 200, looked: [0, 1, 2], place: "3", failed: 0 });
  await pipeline([["SET", at, "1"]]);
  is("a place kept (1): goes on from there", await run(), { status: 200, looked: [1, 2], place: "3", failed: 0 });
  for (const [label, reply] of [...MALFORMED, ["not a number", () => ["abc"]], ["1e9", () => ["1e9"]], ["-1", () => ["-1"]], ["1.5", () => ["1.5"]]] as [string, () => unknown[]][]) {
    await pipeline([["SET", at, "1"]]);
    inject = (commands) => (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === at ? Promise.resolve(reply()) : null);
    is(`the place answered ${label}: nothing read, the place left as it was`, await run(), { status: 503, looked: [], place: "1", failed: null });
    inject = null;
  }

  part("Quiet pass: a place past the day's list was not written by this pass");
  // Within one UTC day the list only grows (SADD only, kept 400 days), so a place past its end is unknown (V-2902).
  is("the place at the end (3 of 3): the day's walk is done, nothing read", await (async () => {
    await pipeline([["SET", at, "3"]]);
    return run();
  })(), { status: 200, looked: [], place: "3", failed: 0 });
  for (const past of ["4", "999999999"]) {
    await pipeline([["SET", at, past]]);
    is(`the place ${past} with 3 stores: nothing read, the place left as it was`, await run(), { status: 503, looked: [], place: past, failed: null });
  }

  part("Quiet pass: a store that cannot be read is never passed over");
  const middle = stores[1].ownerKey;
  let failures = 0;
  inject = (commands) => {
    if (failures > 0 && commands.some((c) => c[0] === "GET" && c[1] === middle)) {
      failures -= 1;
      return Promise.reject(new Error("the database did not answer"));
    }
    return null;
  };
  await pipeline([["DEL", at]]);
  failures = 1;
  is("it fails once: tried again at once, and every store looked at", await run(), { status: 200, looked: [0, 1, 2], place: "3", failed: 0 });
  await pipeline([["DEL", at]]);
  failures = Infinity;
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const failing = await run().finally(() => { console.error = log; });
  is("it cannot be read at all: tried twice, counted as failed, the stores after it still looked at", failing, { status: 200, looked: [0, 2], place: "3", failed: 1 });
  is("and it is said in the log, by its folder", errors.some((e) => e.includes(stores[1].folder)), true);
  failures = 0;
  await pipeline([["DEL", at]]);
  is("the next day's walk reads it again", await run(), { status: 200, looked: [0, 1, 2], place: "3", failed: 0 });
  inject = null;
}

async function pictures(): Promise<void> {
  const folder = communityFolder("d".repeat(32));
  const path = (n: number) => `community/${folder}/${String(n).padStart(16, "0")}.jpg`;
  const now = Date.now();
  const listed = async (p: string) => (await pipeline([["ZSCORE", "nl:cimg:doors", p]]))[0] !== null;

  part("Pictures: a ZREM answered in another shape never loses the picture");
  for (const [n, [label, reply]] of MALFORMED.entries()) {
    const p = path(n + 1);
    await noteCommunityUpload(p, "member", now - 2 * 86_400_000);
    await takePicturePlace(p, 50);
    const kept = await picturesKept(folder);
    // The ZREM is carried out, and its answer comes back in another shape.
    inject = (commands) => (commands.length === 1 && commands[0][0] === "ZREM" ? pipeline(commands).then(() => reply()) : null);
    const swept = await sweepCommunityUploads(now).catch(() => -1);
    inject = null;
    is(`ZREM landed, answered ${label}: the picture is listed again for a later sweep, its place still counted`, [swept, await listed(p), await picturesKept(folder)], [0, true, kept]);
    await pipeline([["ZREM", "nl:cimg:doors", p]]);
  }

  part("Pictures: a ZREM carried out and then thrown never loses the picture");
  {
    // A timeout after the command was sent: Redis took it off the list, the answer never came (C5-2902).
    const p = path(20);
    await noteCommunityUpload(p, "member", now - 2 * 86_400_000);
    await takePicturePlace(p, 50);
    const kept = await picturesKept(folder);
    inject = (commands) =>
      commands.length === 1 && commands[0][0] === "ZREM" ? pipeline(commands).then(() => Promise.reject(new Error("the database did not answer in time"))) : null;
    const swept = await sweepCommunityUploads(now).catch(() => -1);
    inject = null;
    is("ZREM landed, then threw: listed again for a later sweep, its place still counted", [swept, await listed(p), await picturesKept(folder)], [0, true, kept]);
    // This test has no file store (no blob token), so the later sweep's delete is not run here: it is found again.
    seen = [];
    await sweepCommunityUploads(now).catch(() => -1);
    is("a later sweep finds it again", seen.some((c) => c[0] === "ZREM" && c[2] === p), true);
    await pipeline([["ZREM", "nl:cimg:doors", p]]);
  }

  part("Pictures: the courses job says when the list could not be read");
  {
    inject = (commands) => (commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE" ? Promise.resolve(["QUEUED"]) : null);
    const errors: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    const response = await courses({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/courses") } as unknown as Parameters<typeof courses>[0]).finally(() => {
      console.error = log;
    });
    inject = null;
    const body = (await response.json()) as { unusedPictures?: unknown; picturesFailed?: unknown };
    is("the job answers that the pictures were not swept, never 0 swept", [body.unusedPictures, body.picturesFailed], [null, true]);
    is("and says it in the log", errors.some((e) => e.includes("community pictures")), true);
    const healthy = (await (await courses({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/courses") } as unknown as Parameters<typeof courses>[0])).json()) as Record<string, unknown>;
    is("healthy: the count, and no failure said", [healthy.unusedPictures, "picturesFailed" in healthy], [0, false]);
  }

  part("Pictures: the list read exactly");
  for (const [label, reply] of [...MALFORMED, ["a list holding a number", () => [[1]]]] as [string, () => unknown[]][]) {
    inject = (commands) => (commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE" ? Promise.resolve(reply()) : null);
    const answer = await sweepCommunityUploads(now).then(() => "answered", () => "unknown");
    inject = null;
    is(`the list answered ${label}: unknown, never "none to sweep"`, answer, "unknown");
  }
  is("an empty list (confirmed): none to sweep", await sweepCommunityUploads(now), 0);
}

async function main(): Promise<void> {
  redis.clear();
  await quietPass();
  await pictures();
  done();
}

void main();
