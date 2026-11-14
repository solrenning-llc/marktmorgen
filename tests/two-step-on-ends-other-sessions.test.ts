/**
 * Turning two-step login on logs out every other browser of the account that no second step let in, and keeps this
 * one (the security audit of 14 November 2026; Claude 3's decision of the same day). A passkey's session keeps its
 * mark and stays (tests/second-step-gate.test.ts). finishSetup only logged out the sessions an earlier app or
 * a recovery address had opened ("app", "recovery"), so a session opened by the emailed link alone (a borrowed
 * laptop, a stolen cookie) stayed open for up to 30 days with no second step ever asked. Now every other session is
 * logged out when the app is turned on; the session that turned it on stays signed in. Synthetic data only.
 */
import { openSession, sessionEmail } from "@/lib/auth";
import { finishSetup, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

async function main(): Promise<void> {
  const email = "owner@example.com";
  part("Turning the app on");
  const here = await openSession(email);
  const laptop = await openSession(email);
  const phone = await openSession(email);
  const byPasskey = await openSession(email, "passkey", "cred-owner-1");
  const someoneElse = await openSession("other@example.com");
  is("(four sessions open before)", await Promise.all([here, laptop, phone, someoneElse].map(sessionEmail)), [email, email, email, "other@example.com"]);
  const backup = "backup@example.org";
  const started = await startSetup(email, here, backup);
  if (typeof started === "string") throw new Error(started);
  const finished = await finishSetup(email, here, nowCode(started.secret), codeTo(backup));
  is("it is on", typeof finished === "object", true);
  is("this browser stays signed in", await sessionEmail(here), email);
  is("the other browsers opened by the emailed link are logged out", await Promise.all([laptop, phone].map(sessionEmail)), [null, null]);
  is("a session a passkey let in stays", await sessionEmail(byPasskey), email);
  is("another account's session is untouched", await sessionEmail(someoneElse), "other@example.com");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
