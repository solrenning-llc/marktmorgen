/**
 * Test-only stand-in for lib/blob.ts in the deletion records tests
 * (tests/backup-deletions.test.ts): a `del` that records what it was asked to
 * delete and can be made to fail, and a `list` answered from a queue.
 * Production code never imports this module; nothing real is reached.
 */
export const deletionWorld = {
  deleted: [] as string[][],
  delFails: false,
  pages: [] as unknown[],
};

export function resetDeletionWorld(): void {
  deletionWorld.deleted = [];
  deletionWorld.delFails = false;
  deletionWorld.pages = [];
}

export async function del(pathnames: string | string[]): Promise<void> {
  if (deletionWorld.delFails) throw new Error("TEST: Blob could not delete");
  deletionWorld.deleted.push(Array.isArray(pathnames) ? [...pathnames] : [pathnames]);
}

export async function list(): Promise<unknown> {
  if (!deletionWorld.pages.length) throw new Error("TEST: no listing page was queued");
  return deletionWorld.pages.shift();
}

const unused = async (): Promise<never> => {
  throw new Error("TEST: not used by the deletion records tests");
};
export { unused as get, unused as head, unused as put, unused as issueSignedToken, unused as presignUrl };
