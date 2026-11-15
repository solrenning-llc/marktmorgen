/**
 * MM-SA-49 (docs/security-audit-2026-10-28.md; 506 [SG1]): setting up
 * two-step login sends a code to the recovery address typed
 * (lib/two-step.ts, startSetup), counted five an hour per account only. An
 * account costs nothing to make, so any number of them could send one
 * stranger's inbox our code email without bound (MM-SA-35's shape, for the
 * recovery address form). Now it is also five an hour per inbox, counted on a
 * hash so the counter's name never holds the address.
 *
 * What fails here: six accounts naming one inbox and all six sending it a
 * code; or another inbox, named by one of them, not sent its code (control).
 * Synthetic accounts, Redis stand-in, emails caught here.
 */
import { startSetup } from "@/lib/two-step";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// A synthetic key the Resend fixture knows (tests/resend-fixture-credentials.ts), the one reset-notices uses.
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    mails.push(Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const VICTIM = "someone-else@example.org";
const answer = (started: unknown) => (typeof started === "string" ? started : "sent");

async function main(): Promise<void> {
  redis.clear();
  part("One inbox named by many accounts");
  const answers: string[] = [];
  for (let i = 1; i <= 6; i += 1) answers.push(answer(await startSetup(`maker-${i}@example.com`, String(i).repeat(64), VICTIM)));
  is("five codes an hour to one inbox, from any number of accounts", answers, ["sent", "sent", "sent", "sent", "sent", "limited"]);
  is("and the inbox got five", mails.filter((to) => to === VICTIM).length, 5);
  is("however its address is capitalised", answer(await startSetup("maker-7@example.com", "7".repeat(64), "Someone-Else@Example.org")), "limited");

  part("Control: another inbox is still sent its code");
  is("a different address, from the sixth account", answer(await startSetup("maker-6@example.com", "8".repeat(64), "own-backup@example.net")), "sent");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
