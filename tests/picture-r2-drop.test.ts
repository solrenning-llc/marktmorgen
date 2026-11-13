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
 * Stand-in R2 (fetch replaced); nothing real is reached.
 */
import { readFileSync } from "node:fs";
import * as r2 from "@/lib/picture-r2";
import * as mirror from "@/lib/picture-r2-copy";
import type { PictureR2Config } from "@/lib/picture-r2";
import { done, is, part } from "./check";

const config: PictureR2Config = { endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "mm-pictures", origin: "https://images.example.com", key: { accessKeyId: "k".repeat(20), secretAccessKey: "s".repeat(40) } };
const FOLDER = "b".repeat(24);
const BIG = `images/${FOLDER}/${"1".repeat(32)}.jpg`;
const SMALL = `images/${FOLDER}/${"2".repeat(32)}.webp`;

const calls: { method: string; url: string; signed: boolean; redirect?: string }[] = [];
let status = 204;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ method: init?.method ?? "GET", url: String(input), signed: typeof headers.authorization === "string" && headers.authorization.startsWith("AWS4-HMAC-SHA256"), redirect: init?.redirect });
  return new Response("", { status });
}) as typeof fetch;

type Delete = (config: PictureR2Config, path: string) => Promise<void>;
type Drop = (paths: readonly string[], options?: { config?: PictureR2Config | null }) => Promise<boolean>;
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
    is("off: nothing to do, nothing sent", [await drop([BIG, SMALL], { config: null }), calls.length - before], [true, 0]);
    is("on: both files deleted", [await drop([BIG, SMALL], { config }), calls.slice(before).map((c) => `${c.method} ${c.url.split("/").pop()}`)], [true, [`DELETE ${BIG.split("/").pop()}`, `DELETE ${SMALL.split("/").pop()}`]]);
    status = 500;
    is("a failure is said, never thrown", await quietly(() => drop([BIG], { config })), false);
    status = 204;
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
