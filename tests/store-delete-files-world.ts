/** A file store in memory for tests/store-delete-files.test.ts: what it keeps, listed and deleted as Vercel Blob does. */
export const files = new Map<string, number>();
export const state = { failing: false };

export async function del(pathnames: string | string[]): Promise<void> {
  if (state.failing) throw new Error("the file store did not answer");
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(pathname);
}
export async function list(options: { prefix?: string } = {}) {
  const prefix = options.prefix ?? "";
  const blobs = [...files.entries()].filter(([pathname]) => pathname.startsWith(prefix)).map(([pathname, size]) => ({ pathname, size, url: "", downloadUrl: "", uploadedAt: new Date(0) }));
  return { blobs, hasMore: false, cursor: undefined };
}
export async function head(pathname: string) {
  if (!files.has(pathname)) throw new Error("missing");
  return { pathname, size: files.get(pathname)!, contentType: "image/webp" };
}
export async function get() {
  return null;
}
export async function copy() {
  throw new Error("not in this test");
}
export async function put() {
  throw new Error("not in this test");
}
export async function issueSignedToken(): Promise<string> {
  return "signed-test-token";
}
export const presignUrl = () => "https://blob.test/presigned";
