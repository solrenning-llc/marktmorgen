/** A stand-in for "@vercel/blob" (tests/r2-mirror-delete.test.ts): `del` is recorded, everything else refuses. */
export const blobDeleted: string[][] = [];
export async function del(pathnames: string | string[]): Promise<void> {
  blobDeleted.push(typeof pathnames === "string" ? [pathnames] : [...pathnames]);
}
const refuse = () => {
  throw new Error("not used in this test");
};
export const get = refuse;
export const head = refuse;
export const copy = refuse;
export const list = refuse;
export const put = refuse;
export const issueSignedToken = refuse;
export const presignUrl = refuse;
export class BlobNotFoundError extends Error {}
