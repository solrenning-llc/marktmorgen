/**
 * Whether a file in the picture folder really is a picture.
 *
 * What a browser says it uploaded is never taken at face value
 * (app/api/store/image): the file store is asked how big the file really is
 * and what it says it is, and its first bytes have to be a JPEG's or a
 * WebP's. The same check, for a picture put on a product's page
 * (lib/sales-page.ts, PicturesBlock).
 */
import { BlobNotFoundError } from "@vercel/blob";
import { get, head } from "@/lib/blob";
import { dropTakenPictures, putBackOnce, returnToDoor } from "@/lib/picture-door";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "@/lib/product-image";
import { sniffPhotoType } from "@/lib/store-photo";

/** The first bytes of a stored file, to see what it really is; "gone" when the store says there is no such file, null when its answer is not known. */
async function firstBytes(path: string): Promise<Uint8Array | "gone" | null> {
  const found = await get(path, { access: "private" });
  if (!found) return "gone";
  if (found.statusCode !== 200 || !found.stream) return null;
  const reader = found.stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < 16) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    length += value.length;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * What the file store says of a file: "picture" when it is there, weighs no more than a picture may, and is a JPEG or
 * a WebP by its own bytes; "not" when the store answered and it is none of that (no such file, too big, other bytes);
 * "unknown" when the store did not answer (a timeout, a 5xx, a reset), never read as "not" (Claude 2 on #2843,
 * 6750890970; CX-123 rule 24).
 */
export async function pictureVerdict(path: string): Promise<"picture" | "not" | "unknown"> {
  let found: Awaited<ReturnType<typeof head>>;
  try {
    found = await head(path);
  } catch (error) {
    return error instanceof BlobNotFoundError ? "not" : "unknown";
  }
  if (found.size > MAX_IMAGE_BYTES) return "not";
  let bytes: Uint8Array | "gone" | null;
  try {
    bytes = await firstBytes(path);
  } catch {
    return "unknown";
  }
  if (bytes === "gone") return "not";
  if (bytes === null) return "unknown";
  const kind = sniffPhotoType(bytes);
  return kind !== null && (IMAGE_CONTENT_TYPES as readonly string[]).includes(kind) && kind === found.contentType ? "picture" : "not";
}

/** True when the file is there, weighs no more than a picture may, and is a JPEG or a WebP by its own bytes; anything not known is false. */
export async function isStoredPicture(path: string): Promise<boolean> {
  return (await pictureVerdict(path)) === "picture";
}

/** What the checks of a page save's pictures found: the pictures, and those whose check did not finish. */
export type PictureChecks = { good: string[]; unknown: string[] };

/**
 * The check of the pictures a page save has just taken from the picture door (lib/sales-page-store.ts,
 * claimNewPictures, before any is written down as the page's), each with when the door noted it. Each is checked in
 * the file store once (MR audit gap 1). Those that are not pictures are deleted through dropTakenPictures, so a file
 * stored before its note is kept: taken from the door by this very save, a file stored after it is nobody else's.
 *
 * A check that does not finish deletes nothing (Claude 2 on #2843, 6750890970): the picture is put back on the door,
 * once (returnToDoor, putBackOnce), so the creator's save tried again checks it again. That check made again is paid
 * for before it is made, one studio request each (`pay`), so the studio-blob line's bound still holds (a check costs
 * less than a studio request at its dearest); refused, nothing is checked and the picture is put back as it was. A
 * check made again that does not finish either leaves the file kept, out of the door: the creator uploads it again.
 */
export function pictureChecker(pay: (units: number) => Promise<boolean>): (taken: ReadonlyMap<string, number>) => Promise<PictureChecks> {
  return async (taken) => {
    const again = [...taken].filter(([, at]) => putBackOnce(at)).map(([path]) => path);
    const paid = again.length === 0 || (await pay(again.length).catch(() => false));
    const good: string[] = [];
    const bad: string[] = [];
    const unknown: string[] = [];
    const back: [string, number][] = [];
    for (const [path, at] of taken) {
      if (!paid && putBackOnce(at)) {
        unknown.push(path);
        back.push([path, at]);
        continue;
      }
      const verdict = await pictureVerdict(path);
      if (verdict === "picture") good.push(path);
      else if (verdict === "not") bad.push(path);
      else {
        unknown.push(path);
        if (!putBackOnce(at)) back.push([path, Math.floor(at) + 0.5]);
      }
    }
    if (bad.length) await dropTakenPictures(new Map(taken), bad);
    if (back.length) await returnToDoor(back);
    return { good, unknown };
  };
}
