/**
 * A stand-in for "@vercel/blob" for tests/blob-daily-measure.test.ts: an in-memory file store that lists pages of a
 * prefix and counts every call, so the test sees how often the store's Blob folder is listed. No network.
 */
export const blobs = new Map<string, number>();
export const calls = { list: 0, put: 0, token: 0, copy: 0 };

export class BlobNotFoundError extends Error {}

function sizeOf(body: unknown): number {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

export async function list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
  calls.list += 1;
  const all = [...blobs].filter(([pathname]) => pathname.startsWith(options.prefix ?? "")).sort(([a], [b]) => (a < b ? -1 : 1));
  const start = options.cursor ? Number(options.cursor) : 0;
  const page = all.slice(start, start + (options.limit ?? 1000));
  const hasMore = start + page.length < all.length;
  return { blobs: page.map(([pathname, size]) => ({ pathname, size })), hasMore, cursor: hasMore ? String(start + page.length) : undefined };
}

export async function put(pathname: string, body: unknown) {
  calls.put += 1;
  blobs.set(pathname, sizeOf(body));
  return { pathname };
}

export async function issueSignedToken() {
  calls.token += 1;
  return { token: "synthetic" };
}

export async function copy() {
  calls.copy += 1;
  return {};
}

export async function head(pathname: string) {
  const size = blobs.get(pathname);
  if (size === undefined) throw new BlobNotFoundError();
  return { pathname, size, contentType: "application/octet-stream" };
}

export async function get() {
  return null;
}

export async function del(pathnames: string | string[]) {
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) blobs.delete(pathname);
}

export const presignUrl = () => ({ presignedUrl: "https://blob.test/presigned" });
