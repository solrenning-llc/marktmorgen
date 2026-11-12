/** A stand-in for lib/file-store.ts for tests/pdf-preview-room.test.ts: files kept in memory, reads counted. */
export const files = new Map<string, Uint8Array>();
export const counts = { reads: 0, writes: 0 };
export async function readFileWhole(pathname: string, limit: number): Promise<Uint8Array | null> {
  counts.reads += 1;
  const bytes = files.get(pathname);
  return bytes && bytes.byteLength <= limit ? bytes : null;
}
export async function writeFileWhole(pathname: string, bytes: Uint8Array): Promise<void> {
  counts.writes += 1;
  files.set(pathname, bytes);
}
export async function deleteFile(pathnames: string | string[]): Promise<void> {
  for (const p of [pathnames].flat()) files.delete(p);
}
export async function listFiles(prefix: string): Promise<string[]> {
  return [...files.keys()].filter((p) => p.startsWith(prefix));
}
