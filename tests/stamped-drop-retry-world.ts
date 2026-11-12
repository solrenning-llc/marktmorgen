/**
 * Vercel Blob in memory for tests/stamped-drop-retry.test.ts (lib/blob, which lib/file-store reads), with the two
 * answers the test bends: a listing page made by the test (`pages`), and a deletion that fails (`failDeletes`).
 */
export const files = new Map<string, Uint8Array>();
export const deleted: string[] = [];
/** Listing pages handed out in order, in place of the files kept; when none is left, the files kept are listed. */
export const pages: unknown[] = [];
export const listed: { prefix?: string; cursor?: string }[] = [];
let failing = 0;
/** The next `n` deletions fail as a Blob that could not be reached does. */
export function failDeletes(n: number): void {
  failing = n;
}

export async function list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
  listed.push({ prefix: options.prefix, cursor: options.cursor });
  if (pages.length) return pages.shift();
  const prefix = options.prefix ?? "";
  const blobs = [...files.keys()].filter((pathname) => pathname.startsWith(prefix)).sort().map((pathname) => ({ pathname, size: files.get(pathname)!.byteLength }));
  return { blobs, hasMore: false, cursor: undefined };
}

export async function del(pathnames: string | string[]): Promise<void> {
  if (failing > 0) {
    failing -= 1;
    throw new Error("Vercel Blob: the request timed out");
  }
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) {
    deleted.push(pathname);
    files.delete(pathname);
  }
}

export async function put(pathname: string, body: Uint8Array) {
  files.set(pathname, new Uint8Array(body));
  return { pathname, url: `https://blob.test/${pathname}` };
}

export async function get(pathname: string) {
  const bytes = files.get(pathname);
  if (!bytes) return null;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return { statusCode: 200, stream };
}

export async function head(pathname: string) {
  const bytes = files.get(pathname);
  if (!bytes) throw new Error("not found");
  return { pathname, size: bytes.byteLength, contentType: "application/pdf" };
}

export async function issueSignedToken(): Promise<string> {
  return "token";
}

export const presignUrl = async () => ({ presignedUrl: "https://blob.test/presigned" });
