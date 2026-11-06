/**
 * The file store for tests/review-photo-limit.test.ts: the in-memory one of tests/failure-cleanup-world.ts, with
 * every put written down (each one is a paid Advanced Operation on Vercel Blob, retried by the SDK) and a switch
 * that makes the next puts fail, as a provider error would.
 */
import { files } from "./failure-cleanup-world";

export * from "./failure-cleanup-world";

export const blobControl = { puts: [] as string[], fail: false };

export async function put(pathname: string, body: Uint8Array, options: { contentType?: string } = {}) {
  blobControl.puts.push(pathname);
  if (blobControl.fail) throw new Error("the file store did not answer (test)");
  files.set(pathname, { bytes: body, contentType: options.contentType ?? "application/octet-stream", at: Date.now() });
  return { pathname, url: `https://blob.test/${pathname}` };
}
