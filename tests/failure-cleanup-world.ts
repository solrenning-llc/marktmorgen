import { BlobNotFoundError } from "@vercel/blob";

/**
 * A file store in memory for tests/failure-cleanup-paths.test.ts: lib/blob (which lib/file-store reads) and the upload door's
 * SDK, so the real routes read, check and delete real (synthetic) files and the test reads what is left.
 */
/** Each file with when it was stored (ms); one with no time was stored long ago. */
export const files = new Map<string, { bytes: Uint8Array; contentType: string; at?: number }>();
export const deleted: string[] = [];

function missing(pathname: string): Error {
  void pathname;
  return new BlobNotFoundError();
}

// ---------------------------------------------------------------- lib/blob

export async function head(pathname: string) {
  const file = files.get(pathname);
  if (!file) throw missing(pathname);
  return { pathname, size: file.bytes.length, contentType: file.contentType, url: `https://blob.test/${pathname}`, downloadUrl: "", uploadedAt: new Date(file.at ?? 0), cacheControl: "", contentDisposition: "", etag: "" };
}

export async function get(pathname: string) {
  const file = files.get(pathname);
  if (!file) return null;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(file.bytes); controller.close(); } });
  return { statusCode: 200, stream, blob: await head(pathname) };
}

export async function del(pathnames: string | string[]): Promise<void> {
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) {
    deleted.push(pathname);
    files.delete(pathname);
  }
}

export async function put(pathname: string, body: Uint8Array, options: { contentType?: string } = {}) {
  files.set(pathname, { bytes: body, contentType: options.contentType ?? "application/octet-stream", at: Date.now() });
  return { pathname, url: `https://blob.test/${pathname}` };
}

export async function list() {
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
