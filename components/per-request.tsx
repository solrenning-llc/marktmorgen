import { connection } from "next/server";

/**
 * Renders nothing; while it is in the tree, the page waits for a real request instead of being built ahead of time
 * (next/server connection). The Terms and the pricing page include it only once a VAT switch can turn on
 * (lib/vat-fee-words.ts, vatCanTurnOn), so that from then on they read the same decision as the checkout, per request.
 */
export async function PerRequest(): Promise<null> {
  await connection();
  return null;
}
