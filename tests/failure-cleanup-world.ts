import { BlobNotFoundError } from "@vercel/blob";

/**
 * A file store in memory for tests/failure-cleanup-paths.test.ts: lib/blob (which lib/file-store reads) and the upload door's
 * SDK, so the real routes read, check and delete real (synthetic) files and the test reads what is left.
 */
/** Each file with when it was stored (ms); one with no time was stored long ago. */
export const files = new Map<string, { bytes: Uint8Array; contentType: string; at?: number }>();
export const deleted: string[] = [];
/** Every call the code under test made to the file store, by kind (tests/page-picture-check-cost.test.ts counts them). */
export const calls = { head: 0, get: 0, put: 0, del: 0, list: 0 };

function stat(pathname: string) {
  const file = files.get(pathname);
  if (!file) throw missing(pathname);
  return { pathname, size: file.bytes.length, contentType: file.contentType, url: `https://blob.test/${pathname}`, downloadUrl: "", uploadedAt: new Date(file.at ?? 0), cacheControl: "", contentDisposition: "", etag: "" };
}

function missing(pathname: string): Error {
  void pathname;
  return new BlobNotFoundError();
}

// ---------------------------------------------------------------- lib/blob

/** A passing file-store error on the next calls of a path, by kind and how many times (tests/page-picture-unknown-check.test.ts). */
export const failNext = { head: new Map<string, number>(), get: new Map<string, number>() };
function failing(kind: "head" | "get", pathname: string): boolean {
  const left = failNext[kind].get(pathname) ?? 0;
  if (left <= 0) return false;
  failNext[kind].set(pathname, left - 1);
  return true;
}

export async function head(pathname: string) {
  calls.head += 1;
  if (failing("head", pathname)) throw new Error("fetch failed: ETIMEDOUT");
  return stat(pathname);
}

export async function get(pathname: string) {
  calls.get += 1;
  if (failing("get", pathname)) throw new Error("fetch failed: ECONNRESET");
  const file = files.get(pathname);
  if (!file) return null;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(file.bytes); controller.close(); } });
  return { statusCode: 200, stream, blob: stat(pathname) };
}

export async function del(pathnames: string | string[]): Promise<void> {
  calls.del += 1;
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) {
    deleted.push(pathname);
    files.delete(pathname);
  }
}

export async function put(pathname: string, body: Uint8Array, options: { contentType?: string } = {}) {
  calls.put += 1;
  files.set(pathname, { bytes: body, contentType: options.contentType ?? "application/octet-stream", at: Date.now() });
  return { pathname, url: `https://blob.test/${pathname}` };
}

export async function list() {
  calls.list += 1;
  return { blobs: [], hasMore: false, cursor: undefined };
}

export async function issueSignedToken(): Promise<string> {
  return "signed-test-token";
}

export const presignUrl = () => "https://blob.test/presigned";

// ---------------------------------------------------------------- @vercel/blob/client

/** The door's own answer: only the signing callback runs, as it does when the browser asks for a door. */
export async function handleUploadPresigned(value: {
  body: { type?: string; payload?: { pathname: string; clientPayload?: string } };
  getSignedToken: (pathname: string, clientPayload?: string) => Promise<unknown>;
}) {
  const payload = value.body.payload;
  if (!payload) throw new Error("invalid");
  await value.getSignedToken(payload.pathname, payload.clientPayload);
  return { type: "blob.generate-presigned-url", url: "https://blob.test/presigned" };
}
