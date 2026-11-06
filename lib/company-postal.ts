/**
 * Marktmorgen's own postal address, printed under the service emails it
 * sends to the buyers of a store that closes (lib/closing-buyers.ts, queue
 * item 307 [EC1]).
 *
 * Empty until the company has a real business address (the US business
 * address of docs/codex-queue.md, item 275 [FX1], "Depende do dono"): then
 * it is written here, or set as COMPANY_POSTAL_ADDRESS in the deployment.
 * It is never invented: while there is none those emails are not sent, and a
 * store whose buyers must be told does not close until they are
 * (lib/plan-closing.ts, "no company postal address"), so no buyer ever loses
 * access without the notice the checkout promised.
 */
export const COMPANY_POSTAL_ADDRESS = "";

/** The address, once there is one: at least a street, a city and a country, on one line. */
export function companyPostal(): string | null {
  const address = (process.env.COMPANY_POSTAL_ADDRESS || COMPANY_POSTAL_ADDRESS).replace(/\s+/g, " ").trim();
  return address.length >= 10 && address.length <= 300 ? address : null;
}
