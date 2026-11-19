import { BlobNotFoundError } from "@vercel/blob";

/**
 * A file store in memory for the R30 upload proofs: lib/blob and the upload door's SDK. Unlike
 * tests/failure-cleanup-world.ts, `list` honours the prefix and reports each file's size (a synthetic
 * `size` may stand for a large file without holding its bytes), so lib/storage-quota.ts measures it.
 */
export const files = new Map<string, { bytes: Uint8Array; contentType: string; at?: number; size?: number }>();
export const signed: string[] = [];
/** Whole reads of each path through `get`. */
export const reads = new Map<string, number>();

export async function head(pathname: string) {
  const file = files.get(pathname);
  if (!file) throw new BlobNotFoundError();
  return { pathname, size: file.size ?? file.bytes.length, contentType: file.contentType, url: `https://blob.test/${pathname}`, downloadUrl: "", uploadedAt: new Date(file.at ?? 0), cacheControl: "", contentDisposition: "", etag: "" };
}
export async function get(pathname: string) {
  reads.set(pathname, (reads.get(pathname) ?? 0) + 1);
  const file = files.get(pathname);
  if (!file) return null;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(file.bytes); controller.close(); } });
  return { statusCode: 200, stream, blob: await head(pathname) };
}
export async function del(pathnames: string | string[]): Promise<void> {
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(pathname);
}
export async function put(pathname: string, body: Uint8Array, options: { contentType?: string } = {}) {
  files.set(pathname, { bytes: new Uint8Array(body), contentType: options.contentType ?? "application/octet-stream", at: Date.now() });
  return { pathname, url: `https://blob.test/${pathname}` };
}
export async function list(options: { prefix?: string } = {}) {
  const prefix = options.prefix ?? "";
  const blobs = [...files.entries()].filter(([path]) => path.startsWith(prefix)).map(([pathname, file]) => ({ pathname, size: file.size ?? file.bytes.length, uploadedAt: new Date(file.at ?? 0), url: `https://blob.test/${pathname}`, downloadUrl: "" }));
  return { blobs, hasMore: false, cursor: undefined };
}
export async function issueSignedToken(options: { pathname?: string } = {}): Promise<string> {
  signed.push(String(options.pathname ?? ""));
  return "signed-test-token";
}
export const presignUrl = () => "https://blob.test/presigned";

export async function handleUploadPresigned(value: {
  body: { type?: string; payload?: { pathname: string; clientPayload?: string } };
  getSignedToken: (pathname: string, clientPayload?: string) => Promise<unknown>;
}) {
  const payload = value.body.payload;
  if (!payload) throw new Error("invalid");
  await value.getSignedToken(payload.pathname, payload.clientPayload);
  return { type: "blob.generate-presigned-url", url: "https://blob.test/presigned" };
}
