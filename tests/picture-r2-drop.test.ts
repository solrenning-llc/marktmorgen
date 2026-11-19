/**
 * A product picture copied to the pictures' own R2 bucket goes from there too when it goes from the file store
 * (#4237, item 4; Claude 1's storage and media cost audit).
 *
 * lib/picture-r2.ts could only copy: every picture replaced, removed with its product, dropped after a record that
 * could not be written, or moved away by a takedown left its copy in the bucket for good, paid storage and, once the
 * images' domain serves it (PICTURE_R2_CEILING set), still public. Now a picture marked as copied (`r2`) is deleted
 * from the bucket wherever its file store copy is deleted: one signed DELETE a file, while the bucket is on; off,
 * nothing is sent.
 *
 * A delete that fails never leaves a copy behind for good (Codex U, X5 and P and Claude 7 on #4357): every file is
 * tried whatever the one before it answered, each failure is put down on PICTURE_DROP_QUEUE, and the next drop or copy
 * tries it again, taking it off the list only once it is confirmed gone.
 *
 * Stand-in R2 (fetch replaced) and in-memory Redis; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import * as r2 from "@/lib/picture-r2";
import * as mirror from "@/lib/picture-r2-copy";
import type { PictureR2Config } from "@/lib/picture-r2";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const config: PictureR2Config = { endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "mm-pictures", origin: "https://images.example.com", key: { accessKeyId: "k".repeat(20), secretAccessKey: "s".repeat(40) } };
const FOLDER = "b".repeat(24);
const BIG = `images/${FOLDER}/${"1".repeat(32)}.jpg`;
const SMALL = `images/${FOLDER}/${"2".repeat(32)}.webp`;

const calls: { method: string; url: string; signed: boolean; redirect?: string }[] = [];
let status = 204;
/** Answers for the next requests, one each, before `status` is used again. */
const statuses: number[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ method: init?.method ?? "GET", url: String(input), signed: typeof headers.authorization === "string" && headers.authorization.startsWith("AWS4-HMAC-SHA256"), redirect: init?.redirect });
  const answer = statuses.shift() ?? status;
  return new Response(answer === 204 ? null : "", { status: answer });
}) as typeof fetch;

type Delete = (config: PictureR2Config, path: string) => Promise<void>;
type Drop = (paths: readonly string[], options?: { config?: PictureR2Config | null }) => Promise<string>;
type Retry = (limit: number, options?: { config?: PictureR2Config | null }) => Promise<number>;
const retry = (mirror as unknown as { retryPictureDrops?: Retry }).retryPictureDrops;
const QUEUE = (mirror as unknown as { PICTURE_DROP_QUEUE?: string }).PICTURE_DROP_QUEUE ?? "nl:picture-r2:drop";
const queued = async () => ((await redis.pipeline([["SMEMBERS", QUEUE]]))[0] as string[]).slice().sort();
const sent = (from: number) => calls.slice(from).map((c) => `${c.method} ${c.url.split("/").pop()}`);
const name = (path: string) => `DELETE ${path.split("/").pop()}`;
const del = (r2 as unknown as { deletePictureFromR2?: Delete }).deletePictureFromR2;
const drop = (mirror as unknown as { dropMirroredPicture?: Drop }).dropMirroredPicture;
const outcome = async (run: () => Promise<unknown>) => run().then((v) => v ?? "ok", () => "failed");
const quietly = async <T>(body: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.error = log;
  }
};

async function main(): Promise<void> {
  part("One picture deleted from the bucket: a signed DELETE of its own name, redirects refused");
  is("there is a delete", typeof del, "function");
  if (del) {
    is("deleted", await outcome(() => del(config, BIG)), "ok");
    is("of its own name, signed, never following a redirect", calls.at(-1), { method: "DELETE", url: `https://acc.r2.cloudflarestorage.com/mm-pictures/${BIG}`, signed: true, redirect: "error" });
    status = 404;
    is("already gone counts as gone", await outcome(() => del(config, BIG)), "ok");
    status = 500;
    is("any other answer is a failure", await outcome(() => del(config, BIG)), "failed");
    status = 204;
    const before = calls.length;
    is("a name the picture folder could not hold is refused, nothing sent", [await outcome(() => del(config, "images/../vault/secret")), calls.length - before], ["failed", 0]);
  }

  part("A picture's files dropped from the bucket, only while it is on");
  is("there is a drop", typeof drop, "function");
  if (drop) {
    const before = calls.length;
    is("off: nothing to do, nothing sent", [await drop([BIG, SMALL], { config: null }), calls.length - before], ["gone", 0]);
    is("on: both files deleted", [await drop([BIG, SMALL], { config }), sent(before)], ["gone", [name(BIG), name(SMALL)]]);
  }

  part("A delete that fails: every file is still tried, and the failed one is put down to be tried again");
  if (drop) {
    redis.clear();
    const before = calls.length;
    statuses.push(500, 204);
    is("said, never thrown: put down to be tried again", await quietly(() => drop([BIG, SMALL], { config })), "queued");
    is("the smaller copy is deleted although the picture's delete failed", sent(before), [name(BIG), name(SMALL)]);
    is("the picture's name is on the list, and only it", await queued(), [BIG]);
  }

  part("The next drop tries it again first, and takes it off the list only once it is gone");
  if (drop) {
    const OTHER = `images/${FOLDER}/${"3".repeat(32)}.jpg`;
    let before = calls.length;
    statuses.push(500, 204);
    is("tried again and failed again: it stays, and the new file goes", [await quietly(() => drop([OTHER], { config })), sent(before), await queued()], ["gone", [name(BIG), name(OTHER)], [BIG]]);
    before = calls.length;
    is("tried again and gone: off the list", [await drop([OTHER], { config }), sent(before), await queued()], ["gone", [name(BIG), name(OTHER)], []]);
  }

  part("A failure the list cannot hold either: unknown, said in the log");
  if (drop) {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "SADD")) throw new Error("synthetic: Redis request timed out");
      return real(commands);
    }) as typeof redis.pipeline;
    statuses.push(500);
    try {
      is("unknown, never thrown", await quietly(() => drop([BIG], { config })), "unknown");
    } finally {
      redis.pipeline = real;
    }
    is("and nothing is on the list", await queued(), []);
  }

  part("The list: only a picture's own name is ever sent, and nothing while the bucket is off");
  is("there is a retry", typeof retry, "function");
  if (retry) {
    await redis.pipeline([["SADD", QUEUE, BIG], ["SADD", QUEUE, "images/../vault/secret"]]);
    let before = calls.length;
    is("off: nothing read, nothing sent", [await retry(5, { config: null }), calls.length - before, await queued()], [0, 0, [BIG, "images/../vault/secret"].sort()]);
    before = calls.length;
    is("on: the picture's name deleted and taken off, the other never sent", [await retry(5, { config }), sent(before), await queued()], [1, [name(BIG)], ["images/../vault/secret"]]);
    redis.clear();
  }

  part("Every place that deletes a copied picture's files drops them from the bucket too");
  for (const file of ["app/api/store/image/route.ts", "app/api/store/product/route.ts", "lib/picture-withdraw.ts"]) {
    is(`${file} drops a copied picture from the bucket`, /dropMirroredPicture\(/.test(readFileSync(file, "utf8")), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
