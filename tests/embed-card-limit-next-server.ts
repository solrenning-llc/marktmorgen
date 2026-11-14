/**
 * next/server for tests/embed-card-limit.test.ts: everything from Next's own, except connection(), which outside
 * Next has no request to wait for. The card's own reads are what is measured.
 */
export * from "../node_modules/next/server.js";
export async function connection(): Promise<void> {}
