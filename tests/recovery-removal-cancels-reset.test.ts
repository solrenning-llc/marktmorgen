/**
 * Taking the recovery address away (or replacing it) calls off a pending
 * request to turn two-step login off (lib/two-step.ts enterLocked, resetIfDue).
 *
 * Somebody who can read the recovery inbox gets in without the second step:
 * a locked session opens and two-step login is set to turn off RESET_DAYS
 * later. The owner, in a browser that got in with the app's code, takes that
 * recovery address away from the studio. Before this test, the day stayed
 * set: on it two-step login turned off and the locked session opened
 * everything, although the way in it came through had been revoked. Now the
 * removal, made from a session that holds the second step, calls the day
 * off and logs out the browsers let in without it, as Cancel does.
 *
 * Synthetic accounts, Redis stand-in, emails caught here.
 */
import { NextRequest } from "next/server";
import { openSession } from "@/lib/auth";
import { RESET_DAYS, enterLocked, finishSetup, holdSignIn, lockedUntil, resetIfDue, startSetup, twoStepOn, twoStepStatus } from "@/lib/two-step";
import { recoveryAddress } from "@/lib/recovery-address";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { POST as recoveryRoute } from "@/app/api/auth/recovery-address/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// A synthetic key the Resend fixture knows (tests/resend-fixture-credentials.ts), the one reset-notices uses.
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
type Mail = { to: string; subject: string; text: string };
const mails: Mail[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const SETUP = "c".repeat(64);
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
let browsers = 0;
const recovery = async (session: string, body: Record<string, unknown>) => {
  const request = new NextRequest(`${ORIGIN}/api/auth/recovery-address`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `nl_session=${session}`, "x-forwarded-for": `198.51.100.${browsers++ % 250}` },
    body: JSON.stringify(body),
  });
  const r = await recoveryRoute(request);
  return ((await r.json()) as { ok?: boolean; error?: string }).error ?? "ok";
};
const later = Date.now() + (RESET_DAYS + 1) * 86_400_000;

/** Two-step login on with `backup` as its recovery address, a browser that got in with the app, then a login through the recovery inbox. */
async function attacked(email: string, backup: string): Promise<{ owner: string; locked: string }> {
  const started = await startSetup(email, SETUP, backup);
  if (typeof started === "string") throw new Error(started);
  const finished = await finishSetup(email, SETUP, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(finished);
  const owner = await openSession(email, "app");
  const entered = await enterLocked(await holdSignIn(email, true));
  if (!entered) throw new Error("the recovery login did not open");
  return { owner, locked: entered.session };
}

async function main(): Promise<void> {
  redis.clear();

  part("Taking the recovery address away calls off the day two-step login turns off");
  const ANA = "ana-revoke@example.com";
  const ana = await attacked(ANA, "ana-backup@example.org");
  is("the login through the recovery inbox set the day", (await twoStepStatus(ANA)).reset > 0, true);
  is("and its session is locked", (await lockedUntil(ana.locked)) > 0, true);
  is("the owner, with the app's code, takes the recovery address away", await recovery(ana.owner, { action: "remove" }), "ok");
  is("it is gone", await recoveryAddress(ANA), "");
  is("the day is called off", (await twoStepStatus(ANA)).reset, 0);
  is("on the old day two-step login does not turn off", await resetIfDue(ANA, later), false);
  is("it is still on", await twoStepOn(ANA), true);
  is(
    "the owner is told why the request was canceled",
    mails.some((m) => m.to === ANA && m.subject === "Two-step login stays on for your Marktmorgen account" && m.text.startsWith("The recovery address was changed from your studio")),
    true,
  );

  part("Replacing it calls the day off too");
  const BEN = "ben-replace@example.com";
  const ben = await attacked(BEN, "ben-backup@example.org");
  is("a new address is started", await recovery(ben.owner, { action: "start", address: "ben-new@example.org" }), "ok");
  is("and confirmed", await recovery(ben.owner, { action: "confirm", code: codeTo("ben-new@example.org") }), "ok");
  is("the day is called off", (await twoStepStatus(BEN)).reset, 0);
  is("on the old day two-step login does not turn off", [await resetIfDue(BEN, later), await twoStepOn(BEN)], [false, true]);

  part("A locked session cannot take it away to call its own day off");
  const CY = "cy-locked@example.com";
  const cy = await attacked(CY, "cy-backup@example.org");
  is("refused as locked", await recovery(cy.locked, { action: "remove" }), "locked");
  is("the day stays", (await twoStepStatus(CY)).reset > 0, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
