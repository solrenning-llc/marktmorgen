/**
 * Two daily sweeps read their Redis answers exactly (CX-123 rule 24).
 *
 * 1. The quiet-sales pass (app/api/cron/quiet): where today's walk over the
 *    stores goes on from is read exactly. Nil is the start; a whole number is
 *    the place; anything else is unknown, and the pass reads nothing on it
 *    and leaves the place as it was. A store that cannot be read is tried
 *    again at once, and if it still cannot be, the pass stops on it, so the
 *    next run starts from it: it is never passed over as "no store".
 * 2. The sweep of community pictures never put in a post
 *    (lib/community-files.ts): a ZREM answered in another shape than 0 or 1
 *    may have taken the picture off the list; it is put back, so a later
 *    sweep deletes it and gives its place back, rather than leaving it kept
 *    and counted for ever. A list of pictures answered in another shape is
 *    unknown, never "none to sweep".
 *
 * Synthetic data only; the healthy and confirmed answers work as before.
 */
import { GET as quiet } from "@/app/api/cron/quiet/route";
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
    return { status: response?.status ?? -1, looked, place };
  };

  part("Quiet pass: where the walk goes on from, read exactly");
  is("nothing kept yet (nil): every store looked at, the place kept at the end", await run(), { status: 200, looked: [0, 1, 2], place: "3" });
  await pipeline([["SET", at, "1"]]);
  is("a place kept (1): goes on from there", await run(), { status: 200, looked: [1, 2], place: "3" });
  for (const [label, reply] of [...MALFORMED, ["not a number", () => ["abc"]], ["1e9", () => ["1e9"]], ["-1", () => ["-1"]], ["1.5", () => ["1.5"]]] as [string, () => unknown[]][]) {
    await pipeline([["SET", at, "1"]]);
    inject = (commands) => (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === at ? Promise.resolve(reply()) : null);
    is(`the place answered ${label}: nothing read, the place left as it was`, await run(), { status: 503, looked: [], place: "1" });
    inject = null;
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
  is("it fails once: tried again at once, and every store looked at", await run(), { status: 200, looked: [0, 1, 2], place: "3" });
  await pipeline([["DEL", at]]);
  failures = 2;
  is("it fails twice: the pass stops on it, the store after it waits, the place kept on it", await run(), { status: 200, looked: [0], place: "1" });
  failures = 0;
  is("the next run starts from it", await run(), { status: 200, looked: [1, 2], place: "3" });
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
