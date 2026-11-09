/**
 * Vercel Blob in memory for tests/stamped-copy-storage.test.ts (lib/blob, which lib/file-store reads). Unlike
 * tests/stamped-drop-retry-world.ts, a file may carry a synthetic `size` that stands for a large one without holding
 * its bytes, so lib/storage-quota.ts measures a store whose storage is full; and the listing can fail (`listing`).
 */
export const files = new Map<string, { bytes: Uint8Array; size?: number }>();
export const written: string[] = [];
/** How the next listings answer: as the file store does, by failing, or in a shape no page has. */
export const listing: { mode: "ok" | "fail" | "shapeless" } = { mode: "ok" };

export async function list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
  if (listing.mode === "fail") throw new Error("Vercel Blob: the request timed out");
  const prefix = options.prefix ?? "";
  const blobs = [...files.entries()].filter(([pathname]) => pathname.startsWith(prefix)).sort().map(([pathname, file]) => ({ pathname, size: file.size ?? file.bytes.byteLength }));
  if (listing.mode === "shapeless") return { blobs };
  return { blobs, hasMore: false, cursor: undefined };
}

export async function put(pathname: string, body: Uint8Array) {
  written.push(pathname);
  files.set(pathname, { bytes: new Uint8Array(body) });
  return { pathname, url: `https://blob.test/${pathname}` };
}

export async function get(pathname: string) {
  const file = files.get(pathname);
  if (!file) return null;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(file.bytes); controller.close(); } });
  return { statusCode: 200, stream };
}

export async function head(pathname: string) {
  const file = files.get(pathname);
  if (!file) throw new Error("not found");
  return { pathname, size: file.size ?? file.bytes.byteLength, contentType: "application/pdf" };
}

export async function del(pathnames: string | string[]): Promise<void> {
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(pathname);
}

export async function issueSignedToken(): Promise<string> {
  return "token";
}

export const presignUrl = async () => ({ presignedUrl: "https://blob.test/presigned" });
