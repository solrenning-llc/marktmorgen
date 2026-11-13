/**
 * #4237 item 4 (cost and privacy audit, Claude 1): a product picture copied to the pictures' own R2 bucket
 * (lib/picture-r2-copy.ts) was never deleted there. Every place that deletes a picture (replaced, withdrawn, taken off
 * a page, its product removed, its store closed) called only the file store's `del`, and lib/picture-r2.ts had no
 * delete at all, so once PICTURE_R2_CEILING is set every removed picture would stay public and billed for good.
 * Now `del` (lib/blob.ts), the one door every deletion goes through, deletes the R2 copy of each picture path too,
 * while the bucket is on; off, nothing is sent. A copy R2 could not delete makes the deletion fail, so the caller
 * logs it as it does a file store failure; one already gone is fine.
 * Synthetic only: "@vercel/blob" and the bucket's settings are stand-ins (tests/aliases), R2 is a stubbed fetch.
 */
import { del } from "@/lib/blob";
import { blobDeleted } from "./r2-mirror-blob-world";
import { setMirrorOn } from "./r2-mirror-config-world";
import { done, is, part } from "./check";

const PICTURE = "images/0123456789abcdef01234567/0123456789abcdef0123456789abcdef.webp";
const SMALL = "images/0123456789abcdef01234567/fedcba9876543210fedcba9876543210.jpg";
const FILE = "stores/0123456789abcdef0123456789abcdef/prod01/guide-Xy12AbCdEf.pdf";
const r2: { method: string; path: string }[] = [];
let answer = 204;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error("unexpected synthetic request");
  r2.push({ method: String(init?.method), path: url.pathname });
  return new Response(null, { status: answer });
}) as typeof fetch;

async function main(): Promise<void> {
  part("The bucket on: a picture deleted from the file store is deleted from R2 too");
  await del([PICTURE, SMALL, FILE]);
  is("the file store deletes all three", blobDeleted.at(-1), [PICTURE, SMALL, FILE]);
  is("R2 is asked to delete each picture, and nothing else", r2, [
    { method: "DELETE", path: `/synthetic-pictures/${PICTURE}` },
    { method: "DELETE", path: `/synthetic-pictures/${SMALL}` },
  ]);

  part("A single path, as some callers pass it");
  r2.length = 0;
  await del(PICTURE);
  is("its copy is deleted too", r2.map((r) => r.path), [`/synthetic-pictures/${PICTURE}`]);

  part("A copy already gone is fine; one R2 would not delete fails the deletion, so the caller logs it");
  r2.length = 0;
  answer = 404;
  let failed = false;
  await del(PICTURE).catch(() => (failed = true));
  is("404: done", failed, false);
  answer = 500;
  await del(PICTURE).catch(() => (failed = true));
  is("500: the deletion fails", failed, true);

  part("The bucket off (today): nothing is sent to R2");
  setMirrorOn(false);
  answer = 204;
  r2.length = 0;
  await del([PICTURE, SMALL]);
  is("nothing", r2.length, 0);
  done();
}

void main();
