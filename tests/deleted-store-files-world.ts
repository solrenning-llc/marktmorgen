/**
 * Vercel Blob as tests/deleted-store-files.test.ts sees it (in place of lib/blob.ts): files in memory, every listing
 * recorded, an optional wait on each call (a slow store), and credentials resolved the way @vercel/blob 2.8.0 does
 * from the environment: an OIDC token with a store id, or a read-write token; with neither, a call throws, as the
 * SDK's does ("No blob credentials found"), never answering an empty folder.
 */
export const files = new Set<string>();
export const listed: string[] = [];
export const world = { waitMs: 0 };

function credentials(): void {
  const env = (name: string) => (process.env[name] ?? "").trim();
  if (env("VERCEL_OIDC_TOKEN") && env("BLOB_STORE_ID")) return;
  if (env("BLOB_READ_WRITE_TOKEN")) return;
  throw new Error("No blob credentials found.");
}

async function slow(): Promise<void> {
  if (world.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, world.waitMs));
}

export async function list(options: { prefix?: string } = {}) {
  credentials();
  await slow();
  const prefix = options.prefix ?? "";
  listed.push(prefix);
  const blobs = [...files].filter((path) => path.startsWith(prefix)).map((pathname) => ({ pathname, size: 1, uploadedAt: new Date(0), url: `https://blob.test/${pathname}`, downloadUrl: "" }));
  return { blobs, hasMore: false, cursor: undefined };
}
export async function del(pathnames: string | string[]): Promise<void> {
  credentials();
  await slow();
  for (const path of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(path);
}
const unused = async (): Promise<never> => {
  throw new Error("not used by tests/deleted-store-files.test.ts");
};
export { unused as get, unused as head, unused as copy, unused as put, unused as issueSignedToken };
export const presignUrl = () => {
  throw new Error("not used by tests/deleted-store-files.test.ts");
};
