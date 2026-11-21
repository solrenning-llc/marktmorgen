/** A file store in memory for tests/community-picture-drop-retry.test.ts: its delete can be made to fail, as the real one does on a timeout. */
export const files = new Set<string>();
export const state = { failing: false };

export async function del(pathnames: string | string[]): Promise<void> {
  if (state.failing) throw new Error("the file store did not answer");
  for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) files.delete(pathname);
}
export async function head(pathname: string) {
  if (!files.has(pathname)) throw new Error("missing");
  return { pathname, size: 10, contentType: "image/png" };
}
export async function get() {
  return null;
}
