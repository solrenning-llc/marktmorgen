/** Test-only @/lib/blob, vault and stream for tests/b-cost-a3-picture-storage.test.ts: listings kept by prefix. */
export const held = new Map<string, number>();
export const broken = new Set<string>();
export async function list(options: { prefix: string }): Promise<unknown> {
  if ([...broken].some((prefix) => options.prefix.startsWith(prefix))) throw new Error("TEST: listing unavailable");
  const blobs = [...held].filter(([path]) => path.startsWith(options.prefix)).map(([pathname, size]) => ({ pathname, size }));
  return { blobs, hasMore: false };
}
export async function vaultHeld(): Promise<number | null> { return 0; }
export async function streamHeld(): Promise<number | null> { return 0; }
const unused = async (): Promise<never> => { throw new Error("TEST: unexpected provider operation"); };
export { unused as deleteVault, unused as headVault, unused as listVault, unused as readVault, unused as vaultUrl, unused as writeVault, unused as head, unused as del, unused as issueSignedToken, unused as presignUrl, unused as get, unused as put };
