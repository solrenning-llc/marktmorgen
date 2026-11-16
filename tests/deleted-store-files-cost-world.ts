/**
 * Vercel Blob as tests/deleted-store-files-cost.test.ts sees it (in place of lib/blob.ts): files in memory, listed a
 * page of `limit` at a time with a cursor, as the SDK pages them, and every page listed and every delete call
 * counted, so the test holds what a pass sends to Blob against the priced line.
 */
export const files = new Set<string>();
export const calls = { listPages: 0, deleteCalls: 0 };

export async function list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
  calls.listPages += 1;
  const prefix = options.prefix ?? "";
  const limit = options.limit ?? 1000;
  const all = [...files].filter((path) => path.startsWith(prefix)).sort();
  const from = options.cursor ? Number(options.cursor) : 0;
  const page = all.slice(from, from + limit);
  const hasMore = from + limit < all.length;
  return { blobs: page.map((pathname) => ({ pathname, size: 1, uploadedAt: new Date(0), url: `https://blob.test/${pathname}`, downloadUrl: "" })), hasMore, cursor: hasMore ? String(from + limit) : undefined };
}
export async function del(pathnames: string | string[]): Promise<void> {
  calls.deleteCalls += 1;
  for (const path of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(path);
}
const unused = async (): Promise<never> => {
  throw new Error("not used by tests/deleted-store-files-cost.test.ts");
};
export { unused as get, unused as head, unused as copy, unused as put, unused as issueSignedToken };
export const presignUrl = () => {
  throw new Error("not used by tests/deleted-store-files-cost.test.ts");
};
