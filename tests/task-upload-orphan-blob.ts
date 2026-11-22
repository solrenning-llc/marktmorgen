/**
 * The file store for tests/task-upload-orphan.test.ts: a set of paths, deletes that can fail, a head that can fail
 * while the file is there (the store not answering), and the content type the head reports.
 */
export const files = new Set<string>();
export const blobState = { failDeletes: false, failHeads: false, contentType: "image/jpeg" };
export async function del(pathnames: string | string[]): Promise<void> {
  if (blobState.failDeletes) throw new Error("the file store is down");
  for (const path of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(path);
}
export async function head(path: string): Promise<{ pathname: string; size: number; contentType: string }> {
  if (blobState.failHeads) throw new Error("the file store did not answer");
  if (!files.has(path)) throw new Error("not found");
  return { pathname: path, size: 1000, contentType: blobState.contentType };
}
export async function get(): Promise<null> {
  return null;
}
