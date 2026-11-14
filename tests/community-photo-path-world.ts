/**
 * The edges of the community picture door (app/api/store/community/upload) for tests/community-photo-path.test.ts:
 * one community, whoever is signed in, and no limit on the way. The file store is tests/failure-cleanup-world.ts and
 * the database is the in-memory Redis (tests/redis-stub.ts), so lib/community-files.ts runs as it is.
 */
let viewerKey = "victim";
let viewerOwner = false;
/** Signs in as this member (or as the creator, who owns the community). */
export function asViewer(key: string, owner = false): void {
  viewerKey = key;
  viewerOwner = owner;
}
// @/lib/store
export const normaliseHandle = (handle: string) => handle.toLowerCase();
export async function storeForHandle(handle: string) {
  return handle === "shop" ? { handle: "shop", community: { id: "community-1" } } : null;
}
// @/lib/community-access
export async function communityViewer() {
  return { state: "in", canWrite: true, owner: viewerOwner, key: viewerKey };
}
// @/lib/community
export async function within() {
  return true;
}
// @/lib/buyer-actions
export async function takeBuyerAction() {
  return true;
}
// @/lib/community-picture-rules
export const picturesLimitFor = () => 1000;
