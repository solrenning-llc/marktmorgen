/**
 * Test-only stand-in for lib/blob.ts in the backup files route tests: a list
 * answered from a queue, a token issuer and a local signer that count their
 * calls. Production code never imports this module; nothing real is reached.
 */
export const blobWorld = {
  pages: [] as unknown[],
  listCalls: [] as Record<string, unknown>[],
  tokenCalls: [] as Record<string, unknown>[],
  presignCalls: [] as Record<string, unknown>[],
  token: { delegationToken: "deleg-synthetic", clientSigningToken: "client-signing-secret-synthetic", validUntil: 0 } as unknown,
  tokenFails: false,
  listFails: false,
};

export function resetBlobWorld(): void {
  blobWorld.pages = [];
  blobWorld.listCalls = [];
  blobWorld.tokenCalls = [];
  blobWorld.presignCalls = [];
  blobWorld.token = { delegationToken: "deleg-synthetic", clientSigningToken: "client-signing-secret-synthetic", validUntil: 0 };
  blobWorld.tokenFails = false;
  blobWorld.listFails = false;
}

export async function list(options: Record<string, unknown> = {}): Promise<unknown> {
  blobWorld.listCalls.push(options);
  if (blobWorld.listFails) throw new Error("TEST: the store could not be listed");
  if (!blobWorld.pages.length) throw new Error("TEST: no listing page was queued");
  return blobWorld.pages.shift();
}

export async function issueSignedToken(options: Record<string, unknown>): Promise<unknown> {
  blobWorld.tokenCalls.push(options);
  if (blobWorld.tokenFails) throw new Error("TEST: the control API could not be reached");
  const token = blobWorld.token as Record<string, unknown> | null;
  if (token && typeof token === "object" && token.validUntil === 0) return { ...token, validUntil: options.validUntil };
  return token;
}

export async function presignUrl(token: Record<string, unknown>, options: Record<string, unknown>): Promise<{ presignedUrl: string }> {
  blobWorld.presignCalls.push({ token, options });
  const signature = Buffer.from(`${String(token.clientSigningToken)}|${String(options.pathname)}|${String(options.operation)}`).toString("hex").slice(-32);
  return { presignedUrl: `https://synthetic.private.blob.vercel-storage.com/${String(options.pathname)}?vercel-blob-delegation=${String(token.delegationToken)}&vercel-blob-signature=${signature}` };
}

const unused = async (): Promise<never> => { throw new Error("TEST: the backup files route must never read, write or delete a file"); };
export { unused as get, unused as head, unused as del, unused as put };
