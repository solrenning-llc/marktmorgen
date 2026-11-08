/**
 * Synthetic boundary for tests/cron-checks-exact.test.ts. Aliased for
 * @/lib/email, @/lib/verify-mail and @/lib/verify-stripe: every other export is
 * the real module's; only the notice sender and the checks the two cron routes
 * run are stood in for, so no test charges Stripe or sends an email.
 */
export * from "../lib/email";
export * from "../lib/verify-mail";
import { verifyMailLoop as realMailLoop } from "../lib/verify-mail";
export type Check = { check: string; ok: boolean; detail: string };
export const world = {
  /** When false, verifyMailLoop is the real one (lib/verify-mail.ts). */
  fakeLoop: true,
  checksOk: true,
  ran: [] as string[],
  notices: [] as string[],
};
export async function sendEmail(message: { subject: string }): Promise<boolean> {
  world.notices.push(message.subject);
  return true;
}
export function isSenderConfigured(): boolean { return true; }
const one = async (name: string): Promise<Check[]> => {
  world.ran.push(name);
  return [{ check: `synthetic ${name}`, ok: world.checksOk, detail: "checked" }];
};
export function verifyHostToken(): Check[] { world.ran.push("token"); return [{ check: "synthetic token", ok: true, detail: "checked" }]; }
export const verifyAmazonAccount = () => one("account");
export async function verifyProviderUsage() { world.ran.push("usage"); return { basis: "provider_reported_counters" }; }
export async function verifyMailLoop(deadline: number): Promise<Check[]> {
  return world.fakeLoop ? one("loop") : realMailLoop(deadline);
}
export const verifyTiers = () => one("tiers");
export const verifyPackages = () => one("packages");
export const verifyTaxDocuments = () => one("tax");
export const verifyCartShipping = () => one("cart");
