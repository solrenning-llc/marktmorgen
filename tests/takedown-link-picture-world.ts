/**
 * The file store for tests/takedown-link-picture.test.ts: the real lib/blob,
 * with the delete kept in memory and able to fail, as a timeout or an error
 * of the file store would.
 */
export * from "../lib/blob";

export const files = new Map<string, true>();
export const deleted: string[] = [];
export const blobDown = { on: false };

export async function del(pathnames: string | string[]): Promise<void> {
  if (blobDown.on) throw new Error("the file store did not answer");
  for (const path of Array.isArray(pathnames) ? pathnames : [pathnames]) {
    deleted.push(path);
    files.delete(path);
  }
}
