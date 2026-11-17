/**
 * Security audit 506 [SG1], MM-SA-21: /signin/lost answered later when the address had a recovery address. The route
 * waited for the link to be written and for the two emails (the link to the recovery address, the notice to the
 * sign-in address) before answering, and returned at once for an address without one: the same answer, but its time
 * told which sign-in addresses have an account with a recovery address.
 *
 * Checked: the route answers the same, at once, for both addresses, with no link written and no email sent before
 * its answer; the link and the notice go only after it (next/server `after`, held here by
 * tests/next-server-after-world.ts and run by this test); an address with none still emails nobody.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST as lostRoute } from "@/app/api/auth/lost/route";
import { confirmRecoveryAddress, startRecoveryAddress } from "@/lib/recovery-address";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const ME = "timing.maker@example.com";
const SPARE = "timing.spare@example.org";
const SESSION = "d".repeat(64);
const post = (email: string, ip: string) =>
  new NextRequest(`${ORIGIN}/api/auth/lost`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: new URLSearchParams({ email }) });
const runAfter = async () => {
  for (const task of afterTasks.splice(0)) await (task as () => unknown)();
};

async function main(): Promise<void> {
  redis.clear();
  const code = async () => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === SPARE)?.text ?? "")?.[1] ?? "";
  await startRecoveryAddress(ME, SESSION, SPARE);
  is("control: the recovery address is kept", await confirmRecoveryAddress(ME, SESSION, await code()), { address: SPARE });
  mails.length = 0;
  afterTasks.length = 0;

  part("An address with a recovery address: the answer comes before any link or email");
  const withOne = await lostRoute(post(ME, "203.0.113.10"));
  is("the route answers 'sent'", [withOne.status, withOne.headers.get("location")], [303, `${ORIGIN}/signin/lost?status=sent`]);
  is("RED: no email has gone when it answers", mails.length, 0);
  await runAfter();
  is("after its answer, the link goes to the recovery address and the notice to the sign-in address", mails.map((m) => m.to), [SPARE, ME]);

  part("An address with none: the same answer, and nobody emailed, before or after");
  const none = await lostRoute(post("timing.nobody@example.com", "203.0.113.11"));
  is("the same answer", [none.status, none.headers.get("location")], [303, `${ORIGIN}/signin/lost?status=sent`]);
  await runAfter();
  is("nobody emailed", mails.length, 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
