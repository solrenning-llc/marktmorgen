/**
 * Test-only stand-in for "@/lib/blob" (tests/blob-download-attachment.test.ts).
 *
 * Only the one call that would leave the machine is answered here: the
 * signed token Blob's API would issue. It is built in the shape the real one
 * has (a base64url JSON payload naming the store, the path, the operations
 * and the expiry, a dot, then a signature), so the address itself is made by
 * the real SDK's `presignUrl`, exactly as in production. Nothing is reached.
 * Production code never imports this module.
 */
import * as sdk from "@vercel/blob";

export const blobWorld = { issued: 0, failIssue: false };

export function resetBlobWorld(): void {
  blobWorld.issued = 0;
  blobWorld.failIssue = false;
}

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function issueSignedToken(options: { pathname?: string; operations?: string[]; validUntil?: number }): Promise<{ delegationToken: string; clientSigningToken: string; validUntil: number }> {
  if (blobWorld.failIssue) throw new Error("TEST: the Blob API could not be reached");
  blobWorld.issued += 1;
  const validUntil = options.validUntil ?? Date.now() + 3600_000;
  const delegationToken = `${segment({ storeId: "store_SyntheticStore01", pathname: options.pathname, operations: options.operations, validUntil })}.c2lnbmF0dXJl`;
  return { delegationToken, clientSigningToken: "c3ludGhldGljLWNsaWVudC1zaWduaW5nLXRva2Vu", validUntil };
}

export const presignUrl: typeof sdk.presignUrl = (...args) => sdk.presignUrl(...args);

const unused = async (): Promise<never> => {
  throw new Error("TEST: unexpected Blob operation");
};
export { unused as get, unused as head, unused as del, unused as list, unused as put };
