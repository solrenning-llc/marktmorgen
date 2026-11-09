/**
 * The app's code in two-step login has a ceiling of wrong codes in a row for
 * one account (Claude 5's authentication audit, M2).
 *
 * Ten codes an hour renews every hour: somebody who already reads the inbox
 * (the very case the second step is for) could guess 240 codes a day, for
 * ever, in silence. Checked against lib/two-step.ts with the in-memory Redis
 * and a stand-in for the email provider:
 *
 *   - past APP_CODE_FAILS_IN_A_ROW wrong codes, the app's codes are off for
 *     the account, the right one included, whatever the hours: answered
 *     "stopped", not "wrong";
 *   - the account's address and its recovery address are told once each;
 *   - the ways back stay open, with no test of any kind (AX274 3.3.9): a
 *     recovery code still opens, and a login with one (or with a passkey)
 *     lets the app's codes in again;
 *   - wrong codes typed in the studio (turning it off) count the same.
 */
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import * as twoStep from "@/lib/two-step";
import { store as redis, advance } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const mail = installSesMailFixture();
mail.configure();
const { cancelReset, finishSetup, finishSignIn, holdSignIn, startSetup, turnOff, twoStepOn } = twoStep;
// Read through the module so this file builds against a lib/two-step.ts without the ceiling (its red commit): 50 there.
const APP_CODE_FAILS_IN_A_ROW = ((twoStep as Record<string, unknown>).APP_CODE_FAILS_IN_A_ROW as number | undefined) ?? 50;
const HOUR = 60 * 60 * 1000;
/** The test's clock: the in-memory Redis and the app's codes move together (the codes are checked at `now`). */
let clock = Date.now();
const tick = (ms: number) => {
  advance(ms);
  clock += ms;
};
const stepNow = () => Math.floor(clock / 1000 / STEP_SECONDS);

async function account(owner: string, backup: string): Promise<{ secret: Buffer; codes: string[] }> {
  const session = "b".repeat(64);
  const started = await startSetup(owner, session, backup);
  if (typeof started === "string") throw new Error(started);
  const backupCode = /Your code: (\d{6})/.exec([...mail.sent].reverse().find((m) => m.to[0] === backup)?.text ?? "")?.[1] ?? "";
  const secret = base32Decode(started.secret)!;
  const finished = await finishSetup(owner, session, codeAt(secret, stepNow()), backupCode, clock);
  if (typeof finished !== "object") throw new Error(finished);
  return { secret, codes: finished.codes };
}
const nowCode = (secret: Buffer) => codeAt(secret, stepNow());

/** Wrong app codes typed at the login's code page: two waiting logins an hour, five tries each, for `hours` hours. */
async function guess(owner: string, secret: Buffer, hours: number): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  let n = 0;
  for (let hour = 0; hour < hours; hour += 1) {
    for (let hold = 0; hold < 2; hold += 1) {
      const token = await holdSignIn(owner);
      for (let t = 0; t < 5; t += 1) {
        const near = new Set([-1, 0, 1].map((d) => codeAt(secret, stepNow() + d)));
        let code = "";
        do code = String(n++).padStart(6, "0");
        while (near.has(code));
        const answer = await finishSignIn(token, code, clock);
        const reason = answer.ok ? "ok" : answer.reason;
        seen[reason] = (seen[reason] ?? 0) + 1;
      }
    }
    tick(HOUR + 1000);
  }
  return seen;
}
const told = (to: string, since: number) => mail.sent.slice(since).filter((m) => m.to[0] === to && /wrong code/i.test(m.text) && /app/i.test(m.text));

async function main(): Promise<void> {
  redis.clear();

  part(`Past ${APP_CODE_FAILS_IN_A_ROW} wrong codes in a row, the app's codes are off`);
  const owner = "owner@totp-cap.example";
  const backup = "backup@totp-cap.example";
  const { secret, codes } = await account(owner, backup);
  is("two-step login is on (setup)", await twoStepOn(owner), true);
  const since = mail.sent.length;
  const seen = await guess(owner, secret, 11);
  is(`exactly ${APP_CODE_FAILS_IN_A_ROW} wrong codes were judged in eleven hours, the rest answered "stopped"`, [seen.wrong ?? 0, seen.stopped ?? 0], [APP_CODE_FAILS_IN_A_ROW, 110 - APP_CODE_FAILS_IN_A_ROW]);
  const token = await holdSignIn(owner);
  const right = await finishSignIn(token, nowCode(secret), clock);
  is("the app's right code after them: still refused, as stopped", [right.ok, right.ok ? "" : right.reason], [false, "stopped"]);
  tick(30 * 24 * HOUR);
  const later = await finishSignIn(await holdSignIn(owner), nowCode(secret), clock);
  is("thirty days later, still refused: waiting does not start it again", later.ok ? "" : later.reason, "stopped");

  part("The account and its recovery address are told once each");
  is("one notice to the sign-in address, one to the recovery address", [told(owner, since).length, told(backup, since).length], [1, 1]);
  is("the notice names the ways back in: a recovery code, a passkey, the recovery address", [/recovery code/i.test(told(owner, since)[0]?.text ?? ""), /passkey/i.test(told(owner, since)[0]?.text ?? ""), /recovery address/i.test(told(owner, since)[0]?.text ?? "")], [true, true, true]);

  part("A recovery code still opens, and lets the app's codes in again");
  const rescue = await finishSignIn(await holdSignIn(owner), codes[0], clock);
  is("a recovery code opens", [rescue.ok, rescue.ok ? rescue.how : ""], [true, "recovery"]);
  tick(HOUR + 1000);
  const back = await finishSignIn(await holdSignIn(owner), nowCode(secret), clock);
  is("after it, the app's right code opens again", back.ok, true);
  is("and nobody was told twice", [told(owner, since).length, told(backup, since).length], [1, 1]);

  part("Wrong codes typed in the studio count the same; a passkey login starts the count again");
  const studio = "studio@totp-cap.example";
  const kept = await account(studio, "studio.backup@totp-cap.example");
  let judged = 0;
  let stopped = 0;
  for (let hour = 0; hour < 6; hour += 1) {
    for (let t = 0; t < 10; t += 1) {
      const answer = await turnOff(studio, String(900_000 + hour * 10 + t));
      if (answer === "wrong") judged += 1;
      if ((answer as string) === "stopped") stopped += 1;
    }
    tick(HOUR + 1000);
  }
  is(`turning it off with wrong codes: ${APP_CODE_FAILS_IN_A_ROW} judged, then stopped`, [judged, stopped], [APP_CODE_FAILS_IN_A_ROW, 60 - APP_CODE_FAILS_IN_A_ROW]);
  is("two-step login is still on", await twoStepOn(studio), true);
  await cancelReset(studio, "login");
  const passkeyAfter = await finishSignIn(await holdSignIn(studio), nowCode(kept.secret), clock);
  is("after a login with a passkey (cancelReset, \"login\"), the app's right code opens again", passkeyAfter.ok, true);

  part("Fewer wrong codes than the ceiling, then the right one: the count starts again");
  const third = "third@totp-cap.example";
  const t = await account(third, "third.backup@totp-cap.example");
  const first = await guess(third, t.secret, 4);
  is("forty wrong codes judged", first.wrong ?? 0, 40);
  is("the right code opens", (await finishSignIn(await holdSignIn(third), nowCode(t.secret), clock)).ok, true);
  tick(HOUR + 1000);
  const more = await guess(third, t.secret, 4);
  is("forty more are judged: the ceiling counts wrong codes in a row, not in all", [more.wrong ?? 0, more.stopped ?? 0], [40, 0]);
  done();
}

void main();
