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
 *   - wrong codes typed in the studio (turning it off) count the same;
 *   - Cancel in the studio (cancelReset, "studio") does not let them in
 *     again: any session may press it, one let in without the second step
 *     included, so only a recovery code or a passkey does (pre-review A);
 *   - the notice and the code page say what each way back does: a recovery
 *     code or a passkey turns the app's codes back on, the link to the
 *     recovery address turns two-step login off (pre-review B, VR 2);
 *   - the cost line names every write the count makes, and that Cancel
 *     makes none (pre-review G).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_A_COST } from "./plan-cost-registry";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import * as twoStep from "@/lib/two-step";
import { store as redis, advance } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const mail = installSesMailFixture();
mail.configure();
const { cancelReset, finishSetup, finishSignIn, holdSignIn, sendRescue, spendRescue, startSetup, turnOff, twoStepOn } = twoStep;
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

  part("Cancel in the studio does not let the app's codes in again (any session may press it)");
  const canceling = "cancel@totp-cap.example";
  const c = await account(canceling, "cancel.backup@totp-cap.example");
  await guess(canceling, c.secret, 5);
  is("(the app's codes are off)", ((await finishSignIn(await holdSignIn(canceling), nowCode(c.secret), clock)) as { reason?: string }).reason, "stopped");
  tick(HOUR + 1000);
  await cancelReset(canceling, "studio");
  const afterCancel = await finishSignIn(await holdSignIn(canceling), nowCode(c.secret), clock);
  is("after Cancel, the app's right code is still refused, as stopped", afterCancel.ok ? "opened" : afterCancel.reason, "stopped");
  is("turning it off with the app's right code from the studio: stopped too", await turnOff(canceling, nowCode(c.secret)), "stopped");
  is("a recovery code still opens", (await finishSignIn(await holdSignIn(canceling), c.codes[1], clock)).ok, true);

  part("The notice and the code page say what each way back does");
  const rescued = "rescued@totp-cap.example";
  const r = await account(rescued, "rescued.backup@totp-cap.example");
  const sinceRescue = mail.sent.length;
  await guess(rescued, r.secret, 5);
  const notice = told(rescued, sinceRescue)[0]?.text ?? "";
  const page = /stopped:\s*"([^"]+)"/.exec(readFileSync(join(process.cwd(), "app/signin/code/page.tsx"), "utf8"))?.[1] ?? "";
  for (const [where, words] of [["the notice", notice], ["the code page", page]] as const) {
    is(`${where} never says the app's codes work again after the recovery-address link`, /recovery address[^.]*\. After that,? (the|your) app's codes work again/i.test(words), false);
    is(`${where} says a recovery code or a passkey turns them back on, and the link turns two-step login off`, [/recovery codes? or a passkey[^.]*(turns|work)/i.test(words), /recovery address[^.]*turns two-step login off/i.test(words)], [true, true]);
  }
  const hold = await holdSignIn(rescued);
  const beforeLink = mail.sent.length;
  is("(a link to the recovery address)", await sendRescue(hold, "https://marktmorgen.com"), "sent");
  const linkToken = /([0-9a-f]{64})/.exec(mail.sent.slice(beforeLink).map((m) => m.text).join("\n"))?.[1] ?? "";
  is("(the link logs in)", await spendRescue(linkToken), rescued);
  is("as the notice now says, the link turned two-step login off", await twoStepOn(rescued), false);

  part("The cost line names each write of the count, and that Cancel makes none");
  const line = (NOT_A_COST as Record<string, string>).APP_CODE_FAILS_IN_A_ROW ?? "";
  is("it names the login with a recovery code or a passkey, and Cancel in the studio", [/recovery code/i.test(line), /passkey/i.test(line), /Cancel[^.]*(writes nothing|no write)/i.test(line)], [true, true, true]);
  done();
}

void main();
