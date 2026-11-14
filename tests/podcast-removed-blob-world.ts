/** Test world for tests/podcast-removed-*.test.ts: lib/blob stand-in that records every deletion; nothing reaches Vercel Blob. */
export const deleted: string[] = [];
export async function del(pathnames: string | string[]): Promise<void> {
  deleted.push(...(Array.isArray(pathnames) ? pathnames : [pathnames]));
}
export async function head(pathname: string) {
  return { pathname, size: 1000, contentType: "audio/mpeg", uploadedAt: new Date(), url: "", downloadUrl: "", contentDisposition: "", cacheControl: "" };
}
export async function get() {
  return null;
}
export async function list() {
  return { blobs: [], hasMore: false, cursor: undefined };
}
export async function put(pathname: string) {
  return { pathname, url: "", downloadUrl: "", contentType: "", contentDisposition: "" };
}
export async function issueSignedToken() {
  return "token";
}
export async function presignUrl(_token: string, options: { pathname: string }) {
  return { presignedUrl: `https://blob.example/${options.pathname}` };
}
