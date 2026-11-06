import { BlobNotFoundError } from "@vercel/blob";

/**
 * A file store in memory for tests/picture-serve-cost.test.ts, standing in for lib/blob: the public picture route
 * and a product's shared card read real (synthetic) files from it, and every call is counted, so the test can say
 * how many reads of the file store a store's public pictures caused. It also stands in for next/og (below).
 */
export const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
/** Every call made to the file store, by kind, and each `get` by the path it asked for. */
export const calls = { head: 0, get: 0, put: 0, del: 0, list: 0 };
export const gets: string[] = [];

export function resetCalls(): void {
  calls.head = calls.get = calls.put = calls.del = calls.list = 0;
  gets.length = 0;
}

function describe(pathname: string) {
  const file = files.get(pathname);
  if (!file) throw new BlobNotFoundError();
  return { pathname, size: file.bytes.length, contentType: file.contentType, url: `https://blob.test/${pathname}`, downloadUrl: "", uploadedAt: new Date(0), cacheControl: "", contentDisposition: "", etag: "" };
}

export async function head(pathname: string) {
  calls.head += 1;
  return describe(pathname);
}

/** A read: what Vercel Blob charges as an operation, and the file's bytes as data transfer. */
export async function get(pathname: string) {
  calls.get += 1;
  gets.push(pathname);
  const file = files.get(pathname);
  if (!file) return null;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(file.bytes); controller.close(); } });
  return { statusCode: 200, stream, blob: describe(pathname) };
}

export async function del(pathnames: string | string[]): Promise<void> {
  calls.del += 1;
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(pathname);
}

export async function put(pathname: string, body: Uint8Array, options: { contentType?: string } = {}) {
  calls.put += 1;
  files.set(pathname, { bytes: body, contentType: options.contentType ?? "application/octet-stream" });
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

// ---------------------------------------------------------------- next/og

/** The card drawer stood in for: what this file counts (the picture's read) happens before anything is drawn. */
export class ImageResponse extends Response {
  constructor(element: unknown, init: { width?: number; height?: number } = {}) {
    void element;
    super("card", { headers: { "Content-Type": "image/png", "X-Size": `${init.width ?? 0}x${init.height ?? 0}` } });
  }
}
