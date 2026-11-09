/**
 * @/lib/blob for tests/picture-takedown.test.ts: files kept in memory, nothing reaches Vercel Blob. A test can make
 * the next copies or deletes fail, and can act while a copy is being made (as a creator saving at the same moment).
 */
export const kept = new Map<string, Uint8Array>();
export const calls: string[] = [];
export const faults = { copy: 0, del: 0 };
export const hooks: { onCopy: null | (() => Promise<void>) } = { onCopy: null };

class NotFound extends Error {
  constructor(pathname: string) {
    super(`not found: ${pathname}`);
    this.name = "BlobNotFoundError";
  }
}

export async function get(pathname: string) {
  calls.push(`get ${pathname}`);
  const bytes = kept.get(pathname);
  if (!bytes) return null;
  return { statusCode: 200, blob: { size: bytes.byteLength }, stream: new Blob([bytes]).stream() } as never;
}
export async function head(pathname: string) {
  calls.push(`head ${pathname}`);
  const bytes = kept.get(pathname);
  if (!bytes) throw new NotFound(pathname);
  return { pathname, size: bytes.byteLength, contentType: pathname.endsWith(".jpg") ? "image/jpeg" : "image/webp" } as never;
}
export async function copy(from: string, to: string, options: { access: string; allowOverwrite?: boolean; addRandomSuffix?: boolean; contentType?: string }) {
  calls.push(`copy ${from} ${to}`);
  if (hooks.onCopy) {
    const hook = hooks.onCopy;
    hooks.onCopy = null;
    await hook();
  }
  if (faults.copy > 0) {
    faults.copy -= 1;
    throw new Error("the file store did not answer");
  }
  if (options.access !== "private" || options.addRandomSuffix) throw new Error("copied with the wrong options");
  const bytes = kept.get(from);
  if (!bytes) throw new NotFound(from);
  if (kept.has(to) && !options.allowOverwrite) throw new Error("already there");
  kept.set(to, bytes);
  return { pathname: to, url: `https://blob.example/${to}`, downloadUrl: `https://blob.example/${to}?download=1`, contentType: options.contentType ?? "", contentDisposition: "", etag: "e" } as never;
}
export async function del(pathnames: string | string[]) {
  const all = Array.isArray(pathnames) ? pathnames : [pathnames];
  calls.push(`del ${all.join(",")}`);
  if (faults.del > 0) {
    faults.del -= 1;
    throw new Error("the file store did not answer");
  }
  for (const p of all) kept.delete(p);
}
export async function list() { return { blobs: [], hasMore: false } as never; }
export async function put() { throw new Error("no uploads in this test"); }
export async function issueSignedToken() { throw new Error("no tokens in this test"); }
export const presignUrl = () => { throw new Error("no presigned URLs in this test"); };
