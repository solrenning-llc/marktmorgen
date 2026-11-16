/**
 * The world app/api/store/community/upload/route.ts runs in for
 * tests/community-upload-door-exact.test.ts: one store with a community, one
 * member who may write in it, the file store as a set of paths, and the
 * signed door counted instead of signed. Redis is the test's own stand-in.
 */
export const COMMUNITY_ID = "doorcommunity01";
export const MEMBER = "member-key-1";
export const PICTURES = 50;

/** Every door handed out, by path. */
export const tokens: string[] = [];
export const files = new Set<string>();
export const deleted: string[] = [];

// @vercel/blob/client
export async function handleUploadPresigned(options: {
  body: { pathname: string; clientPayload: string | null };
  getSignedToken: (pathname: string, clientPayload: string | null) => Promise<unknown>;
}): Promise<unknown> {
  return { type: "blob.generate-client-token", ...(await options.getSignedToken(options.body.pathname, options.body.clientPayload) as object) };
}

// @/lib/blob
export async function issueSignedToken(options: { pathname: string }): Promise<string> {
  tokens.push(options.pathname);
  return "signed-door";
}
export async function del(pathnames: string | string[]): Promise<void> {
  for (const path of Array.isArray(pathnames) ? pathnames : [pathnames]) {
    files.delete(path);
    deleted.push(path);
  }
}
export async function head(path: string): Promise<{ size: number; contentType: string }> {
  if (!files.has(path)) throw new Error("not found");
  return { size: 1000, contentType: "image/jpeg" };
}
export async function get(): Promise<null> {
  return null;
}

// @/lib/store
export const normaliseHandle = (raw: string): string => raw.trim().toLowerCase();
export async function storeForHandle(handle: string): Promise<unknown> {
  return handle === "doorshop" ? { handle, sid: "door-store", community: { id: COMMUNITY_ID } } : null;
}

// @/lib/community
export async function within(): Promise<boolean> {
  return true;
}

// @/lib/community-access
export async function communityViewer(): Promise<unknown> {
  return { state: "in", canWrite: true, owner: false, key: MEMBER };
}

// @/lib/buyer-actions
export async function takeBuyerAction(): Promise<boolean> {
  return true;
}

// @/lib/community-picture-rules
export function picturesLimitFor(): number {
  return PICTURES;
}
