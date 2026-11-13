/**
 * Test-only stand-in for "@/lib/blob" (tests/outage-free-link-delivery.test.ts): the file store down or back, and
 * nothing else. A small file is read with `get`, which throws while the store is down, as the SDK does on a 5xx or a
 * timeout, and answers the file once it is back. Production code never imports this module.
 */
export const blobDown = { now: true, reads: 0 };

export async function get(): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> }> {
  blobDown.reads += 1;
  if (blobDown.now) throw new Error("TEST: the Blob store answered 503");
  return { statusCode: 200, stream: new Response("%PDF-1.7 synthetic").body as ReadableStream<Uint8Array> };
}

const unused = async (): Promise<never> => {
  throw new Error("TEST: unexpected Blob operation");
};
export { unused as head, unused as del, unused as list, unused as put, unused as issueSignedToken, unused as presignUrl };
