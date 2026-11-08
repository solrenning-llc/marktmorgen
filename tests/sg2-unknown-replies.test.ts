/**
 * Audit SG2, findings 4, 5, 6, 19, 22 and 23 (inbox CX-123, rules 24, 27, 28
 * and 30): a reply from Redis that is missing, cut short or of another shape
 * is never read as none, zero or done.
 *
 *   4  lib/erasure-index.ts forgetNoted: the note of an address's records is
 *      kept, nothing is deleted, and the erasure step fails.
 *   5  lib/two-step.ts endLocked: the locked sessions' set is kept, and the
 *      email says they could not be logged out, never that they were.
 *   6  lib/auth.ts dropSecondStep (and endAllSessions, rule 30): the sessions
 *      stay listed, the call fails, and what follows says so.
 *   19 lib/webhooks.ts forgetStoreWebhooks: the delivery log, the only way to
 *      the bodies sent, is kept and the call fails.
 *   22 lib/auth.ts isMoving / moveRunning: unknown counts as moving, so what
 *      a move forbids stays forbidden.
 *   23 lib/api-keys.ts listKeys: unknown is "could not read your keys",
 *      never "no keys"; makeKey and revokeAllKeys never act on an unknown count.
 *
 * Synthetic only: the Redis stand-in, with one reply at a time made
 * malformed, and a fetch stub for the email provider.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { forgetNoted, noteForErasure } from "@/lib/erasure-index";
import { ERASERS } from "@/lib/person-erasure";
import { SessionsUnknownError, dropSecondStep, emailForSession, endAllSessions, isMoving, moveRunning, openSession, sendMoveLink } from "@/lib/auth";
import { hasSecondStep, liveSecondStep, mayAddSecondStep } from "@/lib/second-step-gate";
import { RESET_DAYS, STILL_LOCKED, endRecoveryAccess, finishSetup, keptStarLine, keptStarMonth, lockedUntil, moveTwoStep, openLockedSession, startSetup, twoStepOn, twoStepStatus } from "@/lib/two-step";
import { LOCKED_UNTIL_STAR_COMMANDS } from "./plan-cost-registry";
import { alignRecoveryLock } from "@/lib/recovery-address";
import { PASSKEY_SESSIONS_OPEN, cancelRemoval, listPasskeys, pendingNow, removePasskey, scheduleRemovalSaid } from "@/lib/passkeys";
import { LOG_SIZE, forgetStoreWebhooks } from "@/lib/webhooks";
import { MAX_KEYS, keyRecords, listKeys, makeKey, resolveKey, revokeAllKeys } from "@/lib/api-keys";
import { FORGET_TRIES, FORGET_TRY_COMMANDS, type ForgetWork, queueStoreForget, retryStoreForgets, storeForgetLine, storeForgetMonth } from "@/lib/store-forget-retry";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { ApiKeyEditor, KEYS_UNREAD } from "@/components/api-key-editor";
import { POST as signOutAll } from "@/app/api/auth/signout-all/route";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { POST as twoStepRoute } from "@/app/api/auth/two-step/route";
import { POST as passkeyRoute } from "@/app/api/auth/passkey/route";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { CANCEL_NOT_LOGGED_OUT } from "@/components/two-step-manager";
import { claimHandle, storeForEmail } from "@/lib/store";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { makePasskey } from "./passkey-world";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
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

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** From now on, the reply to every command `match` picks is `bad`; the command itself still runs. */
function malform(match: (command: Command) => boolean, bad: unknown): void {
  redis.pipeline = async (commands: Command[]) => (await real(commands)).map((reply, i) => (match(commands[i]) ? bad : reply));
}
/** From now on, a pipeline whose commands all match answers `bad` instead of its list of replies. */
function malformAll(match: (command: Command) => boolean, bad: unknown[]): void {
  redis.pipeline = async (commands: Command[]) => (commands.length && commands.every(match) ? (await real(commands), bad) : real(commands));
}
const restore = () => {
  redis.pipeline = real;
};
const on = (verb: string, prefix: string) => (command: Command) => command[0] === verb && String(command[1]).startsWith(prefix);
const exists = async (key: string) => Number((await real([["EXISTS", key]]))[0]) === 1;
const rejects = (work: () => Promise<unknown>) =>
  work().then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );

/** Malformed shapes of a list of strings: none is "an empty list". */
const BAD_LISTS: unknown[] = [undefined, null, "nl:x", 0, {}, { 0: "nl:x" }, ["nl:x", 7], [null]];
/** Malformed shapes of a count: none is zero. */
const BAD_COUNTS: unknown[] = [undefined, null, "1", -1, 1.5, Number.NaN, [1], {}];

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const SESSION = "c".repeat(64);
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const post = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";
async function linkFor(email: string): Promise<string> {
  const token = sha(String(Math.random()));
  await real([["SET", `nl:auth:link:${sha(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  return token;
}
const lastTo = (to: string) => [...mails].reverse().find((m) => m.to === to);
const json = (url: string, body: Record<string, unknown>, session: string) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie: `nl_session=${session}` }, body: JSON.stringify(body) });

async function main(): Promise<void> {
  redis.clear();
  // The failures each case provokes are logged on purpose; only what they leave behind is checked.
  const shown = console.error;
  console.error = (...args: unknown[]) => {
    if (args.some((arg) => arg instanceof Error && /unknown shape|still failing/.test(arg.message))) return;
    shown(...args);
  };

  part("4: forgetNoted never deletes the note without the records it leads to");
  const STATS = "st_sg2_erase";
  const PERSON = "ada@example.com";
  const record = "nl:test:sg2:link-1";
  const note = async () => {
    await real([["SET", record, "{}"], ...noteForErasure(STATS, PERSON, record)]);
  };
  const notesKey = `nl:erase:ix:${STATS}:${sha(`nimbus-erase-ix:${STATS}:${PERSON}`).slice(0, 32)}:z`;
  await note();
  for (const bad of BAD_LISTS) {
    malform(on("ZRANGEBYSCORE", "nl:erase:ix:"), bad);
    const answer = await rejects(() => forgetNoted(STATS, PERSON));
    restore();
    is(`a note read as ${JSON.stringify(bad) ?? "nothing"}: fails, the note and its record kept`, [answer, await exists(notesKey), await exists(record)], ["UnknownReplyError", true, true]);
  }
  malform(on("SMEMBERS", "nl:erase:ix:"), { 0: "nl:x" });
  is("an old-kind note read in another shape: the same", [await rejects(() => forgetNoted(STATS, PERSON)), await exists(notesKey), await exists(record)], ["UnknownReplyError", true, true]);
  restore();
  malformAll(() => true, [[]]);
  is("a pipeline answering one reply for two commands: the same", [await rejects(() => forgetNoted(STATS, PERSON)), await exists(notesKey), await exists(record)], ["UnknownReplyError", true, true]);
  restore();
  for (const bad of BAD_COUNTS) {
    await note();
    malform((command) => command[0] === "DEL" && String(command[1]).startsWith("nl:erase:ix:"), bad);
    const answer = await rejects(() => forgetNoted(STATS, PERSON));
    restore();
    is(`a deletion answered ${JSON.stringify(bad) ?? "nothing"}: not a receipt of none, the step fails`, answer, "UnknownReplyError");
  }
  await note();
  malform(on("ZRANGEBYSCORE", "nl:erase:ix:"), null);
  const eraser = ERASERS.find((e) => e.module === "lib/erasure-index.ts");
  const stepAnswer = await rejects(() => eraser!.run({ statsId: STATS, email: PERSON } as never, [], new Set()));
  restore();
  is("through the erasure's own step: it fails (said as an unfinished step), the note kept", [stepAnswer, await exists(notesKey)], ["UnknownReplyError", true]);
  // (The stand-in counts every key named to DEL, there or not; only that a count comes back is held here.)
  is("read in its shape: the record and the note go, with a count", [typeof (await forgetNoted(STATS, PERSON)), await exists(record), await exists(notesKey)], ["number", false, false]);

  part("5: endLocked keeps the locked sessions it could not read, and says so");
  const LOST = "lost@example.com";
  const started = await startSetup(LOST, SESSION, "backup-lost@example.org");
  if (typeof started === "string") throw new Error(started);
  const finished = await finishSetup(LOST, SESSION, nowCode(started.secret), codeTo("backup-lost@example.org"));
  if (typeof finished === "string") throw new Error(finished);
  const hold = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(LOST) })), "nl_2fa");
  const locked = cookieOf(await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${hold}`)), "nl_session");
  const lockedSet = `nl:2fa:lockedset:${sha(`nimbus-2fa-lockedset:${LOST}`).slice(0, 40)}`;
  is("a session let in without the second step, locked", [await emailForSession(locked), (await lockedUntil(locked)) > 0, await exists(lockedSet)], [LOST, true, true]);
  // The owner's own browser, opened with the app's code, presses Cancel in the studio (the real route).
  const ownerBrowser = await openSession(LOST, "app");
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), { 0: locked });
  const canceledAnswer = (await (await twoStepRoute(json("https://marktmorgen.com/api/auth/two-step", { action: "cancel" }, ownerBrowser))).json()) as { ok?: boolean; loggedOut?: boolean };
  restore();
  const canceledMail = lastTo(LOST);
  is(
    "Cancel with the set read in another shape: canceled, said as not logged out; the session still listed and still locked",
    [canceledAnswer, (await twoStepStatus(LOST)).reset, await emailForSession(locked), (await lockedUntil(locked)) > 0, await exists(lockedSet)],
    [{ ok: true, loggedOut: false }, 0, LOST, true, true],
  );
  is(
    "and still locked once the day it would have lifted is past (a week, and nearly the session's thirty days)",
    [(await lockedUntil(locked, Date.now() + (RESET_DAYS + 1) * 86_400_000)) > 0, (await lockedUntil(locked, Date.now() + 29 * 86_400_000)) > 0],
    [true, true],
  );
  is(
    "and the email says they could not be logged out, never that they were",
    [canceledMail?.subject, canceledMail?.text.includes("could not be logged out just now"), canceledMail?.text.includes(STILL_LOCKED), canceledMail?.text.includes("were logged out")],
    ["Two-step login stays on for your Marktmorgen account", true, true, false],
  );
  is("what it says stays locked is the one list of what a locked session cannot do", STILL_LOCKED.includes("passkeys and two-step login stay locked"), true);
  const twoStepManager = readFileSync("components/two-step-manager.tsx", "utf8");
  is(
    "the studio says it inline, never in a passing toast, and no longer promises they are logged out at once",
    [twoStepManager.includes("if (answer.loggedOut === false) setError(CANCEL_NOT_LOGGED_OUT);"), CANCEL_NOT_LOGGED_OUT.includes("could not be logged out just now"), readFileSync("app/studio/page.tsx", "utf8").includes("they are logged out at once")],
    [true, true, false],
  );

  // That locked session asks for the owner's passkey to go (the real route): the removal is kept, and the
  // browsers it opened, unread, are said as not logged out, in the answer and in the email.
  await makePasskey(LOST, "pk-lost").keep();
  const byLostKey = await openSession(LOST, "passkey", "pk-lost");
  malform(on("SMEMBERS", "nl:auth:sessions:"), [7]);
  const asked = (await (await passkeyRoute(json("https://marktmorgen.com/api/auth/passkey", { action: "remove", id: "pk-lost" }, locked))).json()) as { ok?: boolean; removeOn?: number; loggedOut?: boolean };
  restore();
  const askedMail = mails.filter((m) => m.to === LOST && m.subject === "A passkey is set to be removed from your Marktmorgen account").pop();
  is(
    "a removal set with the sessions unread: kept, its browser still open, said as not logged out",
    [asked.ok, typeof asked.removeOn, asked.loggedOut, (await pendingNow(LOST))?.ids.includes("pk-lost"), await emailForSession(byLostKey)],
    [true, "number", false, true, LOST],
  );
  is("and the email says so, never that they were", [askedMail?.text.includes(PASSKEY_SESSIONS_OPEN), askedMail?.text.includes("Every browser that logged in with it was logged out")], [true, false]);
  const again = await scheduleRemovalSaid(LOST, "pk-lost", locked, true, Date.now() + 2 * 3_600_000);
  is("asked again later: still said as not logged out", again?.loggedOut, false);
  await cancelRemoval(LOST, "pk-lost", byLostKey).catch(() => null);

  await alignRecoveryLock(LOST, Date.now() + 86_400_000);
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  await endRecoveryAccess(LOST);
  restore();
  const recoveryMail = lastTo(LOST);
  is(
    "a full login with the set unread: the session kept and locked, the set kept",
    [await emailForSession(locked), (await lockedUntil(locked)) > 0, await exists(lockedSet)],
    [LOST, true, true],
  );
  is(
    "and the email asks for Log out of all devices, never says they were logged out",
    [recoveryMail?.subject, recoveryMail?.text.includes(STILL_LOCKED), recoveryMail?.text.includes("were logged out")],
    ["Log out of all devices to close what your recovery address opened", true, false],
  );
  await alignRecoveryLock(LOST, Date.now() + 86_400_000);
  await endRecoveryAccess(LOST);
  is(
    "read in its shape: logged out, the set gone, and the email says so",
    [await emailForSession(locked), await exists(lockedSet), lastTo(LOST)?.subject, lastTo(LOST)?.text.includes("were logged out")],
    [null, false, "What your recovery address opened was closed", true],
  );
  const extra = await openLockedSession(LOST, Date.now() + 86_400_000);
  is("(a locked session opened directly is listed too)", await exists(lockedSet), true);
  await alignRecoveryLock(LOST, Date.now() + 86_400_000);
  await endRecoveryAccess(LOST);
  is("(and logged out by the next full login)", await emailForSession(extra), null);

  part("6: dropSecondStep and endAllSessions never read unknown as no sessions");
  const OWNER = "keys@example.com";
  const sessionsKey = `nl:auth:sessions:${sha(`nimbus-auth-sessions:${OWNER}`).slice(0, 40)}`;
  const byKey = await openSession(OWNER, "passkey", "pk-gone");
  const byOther = await openSession(OWNER, "passkey", "pk-gone");
  const gone = (mark: string) => mark === "passkey:pk-gone";
  for (const bad of BAD_LISTS) {
    malform(on("SMEMBERS", "nl:auth:sessions:"), bad);
    const answer = await rejects(() => dropSecondStep(OWNER, gone, byKey));
    restore();
    is(`sessions read as ${JSON.stringify(bad) ?? "nothing"}: fails, nobody logged out, the set kept`, [answer, await emailForSession(byOther), await exists(sessionsKey)], ["SessionsUnknownError", OWNER, true]);
  }
  malformAll(on("GET", "nl:auth:second:"), []);
  is("marks answered short: fails, nobody logged out", [await rejects(() => dropSecondStep(OWNER, gone, byKey)), await emailForSession(byOther)], ["SessionsUnknownError", OWNER]);
  restore();
  malform(on("GET", "nl:auth:second:"), 7);
  is("a mark of another shape: fails, nobody logged out", [await rejects(() => dropSecondStep(OWNER, gone, byKey)), await emailForSession(byOther)], ["SessionsUnknownError", OWNER]);
  restore();
  is("the error is the one callers tell apart", new SessionsUnknownError("x") instanceof Error, true);
  is("read in their shape: the other is logged out, the one asking keeps its session", [await dropSecondStep(OWNER, gone, byKey), await emailForSession(byOther), await emailForSession(byKey)], [1, null, OWNER]);

  const PK = "passkeys@example.com";
  const phone = makePasskey(PK, "pk-phone");
  await phone.keep();
  const opened = await openSession(PK, "passkey", "pk-phone");
  malform(on("SMEMBERS", "nl:auth:sessions:"), "x");
  const removed = await removePasskey(PK, "pk-phone");
  restore();
  const removedMail = mails.filter((m) => m.to === PK).pop();
  is(
    "a passkey removed with its sessions unread: gone, its session not said as logged out",
    [removed, (await listPasskeys(PK)).length, await emailForSession(opened)],
    ["removed-sessions-open", 0, PK],
  );
  is("and its email says to log them out", [removedMail?.subject, removedMail?.text.includes(PASSKEY_SESSIONS_OPEN)], ["A passkey was removed from your Marktmorgen account", true]);

  const ALL = "everywhere@example.com";
  const one = await openSession(ALL);
  const two = await openSession(ALL);
  const allKey = `nl:auth:sessions:${sha(`nimbus-auth-sessions:${ALL}`).slice(0, 40)}`;
  const quiet = console.error;
  console.error = () => {};
  malform(on("SMEMBERS", "nl:auth:sessions:"), { 0: "x" });
  const unknown = await endAllSessions(ALL);
  const out = await signOutAll(new NextRequest("https://marktmorgen.com/api/auth/signout-all", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie: `nl_session=${one}` } }));
  restore();
  console.error = quiet;
  is(
    "Log out of all devices with the set unread: unknown, not none; the set kept; the page says the others may still be in",
    [unknown, await exists(allKey), await emailForSession(two), out.headers.get("location")],
    [null, true, ALL, "https://marktmorgen.com/signin?status=out-everywhere-unknown"],
  );
  const page = readFileSync("app/signin/page.tsx", "utf8");
  is(
    "the sign-in page has words for it, said as not done",
    [page.includes('"out-everywhere-unknown": {'), page.includes("Your other devices may still be logged in"), page.includes("we could not log out your other devices just now")],
    [true, true, true],
  );
  const doneOut = await signOutAll(new NextRequest("https://marktmorgen.com/api/auth/signout-all", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie: `nl_session=${two}` } }));
  is("read in its shape: done, and said as done", [doneOut.headers.get("location"), await emailForSession(two), await exists(allKey)], ["https://marktmorgen.com/signin?status=out-everywhere", null, false]);

  // The app turned off from the studio (the real route), with a recovery code, while the sessions cannot be read.
  const offBrowser = await openSession(LOST);
  const appBrowser = await openSession(LOST, "app");
  malform(on("SMEMBERS", "nl:auth:sessions:"), null);
  const offAnswer = (await (await twoStepRoute(json("https://marktmorgen.com/api/auth/two-step", { action: "off", code: finished.codes[5] }, offBrowser))).json()) as { ok?: boolean; loggedOut?: boolean };
  restore();
  is("the app turned off with its sessions unread: off, said as not logged out", [offAnswer, await twoStepOn(LOST), await emailForSession(appBrowser)], [{ ok: true, loggedOut: false }, false, LOST]);
  const passkeyManager = readFileSync("components/passkey-manager.tsx", "utf8");
  is(
    "the studio says each inline, never in a passing toast",
    [
      readFileSync("components/two-step-manager.tsx", "utf8").includes("if (answer.loggedOut === false) setError(OFF_NOT_LOGGED_OUT);"),
      passkeyManager.includes("if (done.loggedOut === false) setError(REMOVED_NOT_LOGGED_OUT);"),
      passkeyManager.includes("if (done.loggedOut === false) setError(`“${row.name}” will be removed on ${onDay(at)}. ${SET_NOT_LOGGED_OUT}`);"),
    ],
    [true, true, true],
  );
  // A new app turned on takes what the old one left first: its mark never holds again (review of #2556, C).
  const again2 = await startSetup(LOST, offBrowser, "backup-lost@example.org");
  if (typeof again2 === "string") throw new Error(again2);
  malform(on("SMEMBERS", "nl:auth:sessions:"), "x");
  const refused = await finishSetup(LOST, offBrowser, nowCode(again2.secret), "");
  restore();
  is("unread, the new app is not turned on", [refused, await twoStepOn(LOST), await emailForSession(appBrowser)], ["sessions", false, LOST]);
  const turnedOn = await finishSetup(LOST, offBrowser, nowCode(again2.secret), "");
  is("read in their shape: on, and the old app's browser is logged out", [typeof turnedOn === "object", await emailForSession(appBrowser), await liveSecondStep(LOST, appBrowser)], [true, null, null]);

  // A move whose sessions could not be read (the real route): it stands, and is never said as every session closed.
  const FROM = "move-from@example.com";
  const TO = "move-to@example.com";
  await claimHandle(FROM, "sg2-move-from", "Sg2", "");
  const asker = await openSession(FROM);
  const stray = await openSession(FROM);
  mails.length = 0;
  await sendMoveLink(FROM, TO, "https://marktmorgen.com", asker);
  const moveToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === TO)?.text ?? "")?.[1] ?? "";
  malform(on("SMEMBERS", "nl:auth:sessions:"), { 0: "x" });
  const moved = (await moveRoute(post("https://marktmorgen.com/api/auth/move", { token: moveToken }))).headers.get("location");
  restore();
  is("a move with the sessions unread: it stands, and says other sessions may still be open", [Boolean(await storeForEmail(TO)), moved, await emailForSession(stray)], [true, "https://marktmorgen.com/studio?address=moved-sessions-open", FROM]);
  const studioPage = readFileSync("app/studio/page.tsx", "utf8");
  is("the studio has words for it", [studioPage.includes('"moved-sessions-open": {'), studioPage.includes("We could not close every session that was open before the move.")], [true, true]);
  is("an undone move whose sessions could not be read is left marked to repair", readFileSync("app/api/auth/move/route.ts", "utf8").includes('if ((await endAllSessions(from)) === null) throw new Error("the sessions could not be read");'), true);

  part("22: unknown counts as moving");
  const MOVER = "mover@example.com";
  is("nothing moving, read in its shape: not moving", [await isMoving(MOVER), await moveRunning(MOVER)], [false, false]);
  for (const bad of BAD_COUNTS) {
    malform((command) => command[0] === "EXISTS" && String(command[1]).startsWith("nl:auth:"), bad);
    const answer = [await isMoving(MOVER), await moveRunning(MOVER), await hasSecondStep(MOVER), await mayAddSecondStep(MOVER, undefined)];
    restore();
    is(`a mark read as ${JSON.stringify(bad) ?? "nothing"}: moving, so nothing a move forbids is let through`, answer, [true, true, true, false]);
  }
  malformAll((command) => command[0] === "EXISTS", [0]);
  is("one reply for two marks: moving", await isMoving(MOVER), true);
  restore();

  part("19: forgetStoreWebhooks never deletes the log without the deliveries in it");
  const HOOKS = "st_sg2_hooks";
  const delivery = `dlv_${"b".repeat(24)}`;
  const logKey = `nl:hooks:log:${HOOKS}`;
  const bodyKey = `nl:hooks:d:${delivery}`;
  await real([["SET", bodyKey, JSON.stringify({ id: delivery, statsId: HOOKS, body: '{"email":"buyer@example.com"}' })], ["LPUSH", logKey, delivery]]);
  for (const bad of BAD_LISTS) {
    malform(on("LRANGE", "nl:hooks:log:"), bad);
    const answer = await rejects(() => forgetStoreWebhooks(HOOKS));
    restore();
    is(`a log read as ${JSON.stringify(bad) ?? "nothing"}: fails, the log and the body kept`, [answer, await exists(logKey), await exists(bodyKey)], ["UnknownReplyError", true, true]);
  }
  malform(on("SMEMBERS", "nl:hooks:wait:"), 3);
  is("the endpoints told read in another shape: the same", [await rejects(() => forgetStoreWebhooks(HOOKS)), await exists(logKey), await exists(bodyKey)], ["UnknownReplyError", true, true]);
  restore();
  malform(on("GET", "nl:hooks:cfg:"), 5);
  is("the endpoints read in another shape: the same", [await rejects(() => forgetStoreWebhooks(HOOKS)), await exists(logKey)], ["UnknownReplyError", true]);
  restore();
  malformAll(() => true, [[delivery]]);
  is("one reply for five commands: the same", [await rejects(() => forgetStoreWebhooks(HOOKS)), await exists(logKey)], ["UnknownReplyError", true]);
  restore();
  await forgetStoreWebhooks(HOOKS);
  is("read in its shape: the log and the body go", [await exists(logKey), await exists(bodyKey)], [false, false]);

  part("23: the keys are said as unread, never as none");
  const SID = "a".repeat(32);
  const made = await makeKey(SID, "Zapier");
  if (!made.ok) throw new Error("no key");
  for (const bad of [...BAD_LISTS, ["only-a-field"]]) {
    malform(on("HGETALL", "nl:api:keys:"), bad);
    const answer = await rejects(() => listKeys(SID));
    restore();
    is(`the list read as ${JSON.stringify(bad) ?? "nothing"}: unread, not empty`, answer, "UnknownReplyError");
  }
  malform(on("HGETALL", "nl:api:keys:"), { 0: "x" });
  const strictRecords = [await rejects(() => keyRecords(SID, true)), await rejects(() => keyRecords(SID))];
  restore();
  // The pause code's read fails too (CX-123 rule 24, tests/r24-api-key-states.test.ts): read as no keys, a teammate leaving passed over their keys.
  is("the studio's read of the keys (shownKeys) and the pause code's read both fail, never no keys", strictRecords, ["UnknownReplyError", "UnknownReplyError"]);
  malform(on("HGETALL", "nl:api:keys:"), null);
  const revoked = await rejects(() => revokeAllKeys(SID));
  restore();
  is("a deleted store's keys with the list unread: fails, and the key still in the list it is checked against", [revoked, (await listKeys(SID)).length, (await resolveKey(made.key))?.sid], ["UnknownReplyError", 1, SID]);
  for (const bad of BAD_COUNTS) {
    malform((command) => command[0] === "HLEN" && String(command[1]).startsWith("nl:api:keys:"), bad);
    const answer = await makeKey(SID, "Another");
    restore();
    is(`a count read as ${JSON.stringify(bad) ?? "nothing"}: no key made, said as unavailable`, [answer.ok ? "made" : answer.reason, (await listKeys(SID)).length], ["unavailable", 1]);
  }
  const unread = renderToStaticMarkup(createElement(ApiKeyEditor, { keys: "unread" }));
  const none = renderToStaticMarkup(createElement(ApiKeyEditor, { keys: [] }));
  is(
    "the studio says it could not read the keys, never 0 keys",
    [unread.includes(KEYS_UNREAD), unread.includes(` of ${MAX_KEYS}`), none.includes(`0 of ${MAX_KEYS}`), none.includes(KEYS_UNREAD)],
    [true, false, true, false],
  );
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  const keysRoute = readFileSync("app/api/store/api-keys/route.ts", "utf8");
  is(
    "the studio passes an unread list as such, and the route sends it as null after a change that was made",
    [studio.includes('shownKeys(current, email, role).catch(() => "unread" as const)'), studio.includes("shownKeys(current, email, role).catch(() => [])"), keysRoute.includes("shownKeys(store, email, role).catch((error: unknown) => {"), keysRoute.includes("return null;")],
    [true, false, true, true],
  );
  is("(the words)", KEYS_UNREAD, "We could not read your keys just now, so they are not listed here. Reload the page to try again.");
  is("(read in its shape, the key is listed)", (await listKeys(SID)).map((k) => k.name), ["Zapier"]);
  is("(and a deleted store's keys go)", [await revokeAllKeys(SID), await resolveKey(made.key)], [1, null]);

  part("C (review of #2556): two-step login moved onto an address takes the marks an earlier app of it left");
  const HOME = "home@example.com";
  const AWAY = "away@example.com";
  const homeSetup = await startSetup(AWAY, "d".repeat(64), "backup-away@example.org");
  if (typeof homeSetup === "string") throw new Error(homeSetup);
  if (typeof (await finishSetup(AWAY, "d".repeat(64), nowCode(homeSetup.secret), codeTo("backup-away@example.org"))) === "string") throw new Error("not on");
  // A browser of HOME still marked by an app HOME once had, its logout unread when that app was turned off.
  const oldMark = await openSession(HOME, "app");
  malform(on("SMEMBERS", "nl:auth:sessions:"), null);
  const refusedMove = await rejects(() => moveTwoStep(AWAY, HOME));
  restore();
  is("unread, nothing moves", [refusedMove, await twoStepOn(AWAY), await twoStepOn(HOME), await emailForSession(oldMark)], ["SessionsUnknownError", true, false, HOME]);
  await moveTwoStep(AWAY, HOME);
  is("read in their shape: it moves, and the old mark's browser is logged out", [await twoStepOn(HOME), await emailForSession(oldMark), await liveSecondStep(HOME, oldMark)], [true, null, null]);

  part("Review of #2556 at df8030300: lockedUntil costs one command for every other account");
  let sent = 0;
  const counting = async (commands: Command[]) => {
    sent += commands.length;
    return real(commands);
  };
  const KEPT = "kept@example.com";
  const keptUntil = Date.now() + RESET_DAYS * 86_400_000;
  const keptLocked = await openLockedSession(KEPT, keptUntil);
  await alignRecoveryLock(KEPT, keptUntil);
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  await endRecoveryAccess(KEPT);
  restore();
  const elsewhere = await openSession("elsewhere@example.com");
  const keptPlain = await openSession(KEPT);
  redis.pipeline = counting;
  const answers = [await lockedUntil(elsewhere)];
  const forOther = sent;
  sent = 0;
  answers.push(await lockedUntil(keptPlain));
  const forKept = sent;
  sent = 0;
  answers.push((await lockedUntil(keptLocked)) > 0 ? 1 : 0);
  const forLocked = sent;
  restore();
  is("another account's session: one command; the kept account's own: four at most; the locked one: still locked", [forOther, forKept, forLocked, answers], [1, 4, 1, [0, 0, 1]]);

  part("Review of #2556 at c6267d1e: the list of kept accounts never grows past its ceiling, nor twice for one account");
  const KEPT_LIST = `nl:2fa:lockedset:${sha("nimbus-2fa-lockedset:any account").slice(0, 40)}:kept`;
  const keptFail = async (email: string) => {
    await alignRecoveryLock(email, Date.now() + 86_400_000);
    malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
    await endRecoveryAccess(email);
    restore();
  };
  const lengthOf = async () => Number((await real([["STRLEN", KEPT_LIST]]))[0]);
  const once = await lengthOf();
  await keptFail(KEPT);
  await keptFail(KEPT);
  is("the same account failing again adds nothing", await lengthOf(), once);
  for (let n = 0; n < 101; n += 1) await keptFail(`many-${n}@example.com`);
  const full = await lengthOf();
  is("past 100 accounts it never grows: at most 100 tags of 41 bytes", full <= 100 * 41, true);
  await keptFail("one-more@example.com");
  is("and one more adds nothing", await lengthOf(), full);
  sent = 0;
  redis.pipeline = counting;
  const overflowAnswers = [(await lockedUntil(keptLocked)) > 0, await lockedUntil(elsewhere)];
  restore();
  is("over the ceiling: a kept locked session stays locked, a session never locked is not, at four commands", [overflowAnswers, sent <= 1 + 3 + 1 + 3], [[true, 0], true]);
  sent = 0;
  redis.pipeline = counting;
  await lockedUntil(elsewhere);
  restore();
  const starMonth = new Date().toISOString().slice(0, 7);
  const stars = await keptStarMonth(starMonth);
  const starLine = keptStarLine(starMonth, stars);
  is(
    "and it is said: counted for the month, the owner's line with numbers only, the extra within its cost line",
    [typeof stars === "number" && stars >= 2, starLine.includes("passou do teto de 100"), /@|nl:/.test(starLine), sent - 1 <= LOCKED_UNTIL_STAR_COMMANDS, keptStarLine(starMonth, 0), keptStarLine(starMonth, null).includes("desconhecido")],
    [true, true, false, true, "", true],
  );
  await real([["DEL", KEPT_LIST]]);

  part("Review of #2556 at df8030300: a move refused because the new address's sessions are unread says so");
  const FROM2 = "move2-from@example.com";
  const TO2 = "move2-to@example.com";
  await claimHandle(FROM2, "sg2-move2-from", "Sg2", "");
  const asker2 = await openSession(FROM2);
  mails.length = 0;
  await sendMoveLink(FROM2, TO2, "https://marktmorgen.com", asker2);
  const token2 = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === TO2)?.text ?? "")?.[1] ?? "";
  // An app of the account, so moving it reads the new address's sessions.
  const app2 = await startSetup(FROM2, asker2, "backup-move2@example.org");
  if (typeof app2 === "string") throw new Error(app2);
  if (typeof (await finishSetup(FROM2, asker2, nowCode(app2.secret), codeTo("backup-move2@example.org"))) === "string") throw new Error("not on");
  // Only the new address's sessions unread: the account's own are put back and logged out as before.
  malform(on("SMEMBERS", `nl:auth:sessions:${sha(`nimbus-auth-sessions:${TO2}`).slice(0, 40)}`), { 0: "x" });
  const refusedAt = (await moveRoute(post("https://marktmorgen.com/api/auth/move", { token: token2 }))).headers.get("location");
  restore();
  const signinPage = readFileSync("app/signin/page.tsx", "utf8");
  is(
    "not moved, and said as a move that could not finish, never as the address having its own login",
    [refusedAt, Boolean(await storeForEmail(FROM2)), await twoStepOn(FROM2), signinPage.includes('"move-unread": {'), signinPage.includes("Your account was not moved, and it stays at its old address.")],
    ["https://marktmorgen.com/signin?status=move-unread", true, true, true, true],
  );

  part("Review of #2556, LEVE 3: a deleted store's webhooks and keys that could not be forgotten are tried again, counted, never only logged");
  const GONE_STATS = "c".repeat(32);
  const GONE_SID = "d".repeat(32);
  const goneKey = await makeKey(GONE_SID, "Zapier");
  if (!goneKey.ok) throw new Error("no key");
  const goneLog = `nl:hooks:log:${GONE_STATS}`;
  const goneBodies: Command[] = [];
  for (let i = 0; i < LOG_SIZE; i += 1) {
    const id = `dlv_${i.toString(16).padStart(24, "0")}`;
    goneBodies.push(["SET", `nl:hooks:d:${id}`, "{}"], ["LPUSH", goneLog, id]);
  }
  await real([...goneBodies, ["SET", `nl:hooks:cfg:${GONE_STATS}`, JSON.stringify({ handle: "gone", endpoints: Array.from({ length: MAX_ENDPOINTS }, (_, i) => ({ id: `ep${i}`, url: `https://hooks.example.com/${i}`, events: ["sale.completed"], secret: "s" })) })]]);
  for (let k = 1; k < MAX_KEYS; k += 1) await makeKey(GONE_SID, `Tool ${k}`);
  const monthNow = new Date().toISOString().slice(0, 7);
  await queueStoreForget(GONE_STATS, GONE_SID);
  await queueStoreForget(GONE_STATS, GONE_SID);
  let tries = 0;
  const failing: ForgetWork = async () => {
    tries += 1;
    throw new Error("still failing");
  };
  const runs: unknown[] = [];
  for (let day = 0; day < FORGET_TRIES - 2; day += 1) runs.push(await retryStoreForgets(Date.now() + 10_000, Date.now(), failing));
  const waiting = await storeForgetMonth(monthNow);
  is("queued once; failed again each day, not given up before the last try", [waiting?.queued, waiting?.waitingNow, waiting?.keptNow, tries, runs.at(-1)], [1, 1, 0, FORGET_TRIES - 2, { done: 0, failed: 1, gaveUp: 0, left: 0 }]);
  const last = await retryStoreForgets(Date.now() + 10_000, Date.now(), failing);
  const afterLast = await retryStoreForgets(Date.now() + 10_000, Date.now(), failing);
  const given = await storeForgetMonth(monthNow);
  const line = storeForgetLine(given);
  is(
    "given up, it leaves the daily line for the kept ones, never read by the daily run",
    [Number((await real([["HLEN", "nl:forget:q"]]))[0]), Number((await real([["HLEN", "nl:forget:kept"]]))[0])],
    [0, 1],
  );
  is("the last try gives it up, it is kept, and is never tried again", [last, afterLast, tries, given?.gaveUp, given?.keptNow, given?.waitingNow], [{ done: 0, failed: 0, gaveUp: 1, left: 0 }, { done: 0, failed: 0, gaveUp: 0, left: 0 }, FORGET_TRIES - 1, 1, 1, 0]);
  is(
    "the owner's report says what is still kept, with numbers only: no store, no key, no person",
    [line.includes("1 com dados ainda guardados depois de todas as tentativas"), line.includes("que podem conter dados de compradores"), line.includes(GONE_STATS), line.includes(GONE_SID), /@|nl:/.test(line)],
    [true, true, false, false, false],
  );
  is("unread, the report says it is unknown, never nothing", storeForgetLine(null).includes("o estado é desconhecido"), true);
  // A second store, the real forgets this time: one try, every command counted.
  const OK_STATS = "e".repeat(32);
  const [goneIds, goneCfg] = await real([["LRANGE", goneLog, 0, -1], ["GET", `nl:hooks:cfg:${GONE_STATS}`]]);
  await real([["RPUSH", `nl:hooks:log:${OK_STATS}`, ...(goneIds as string[])], ["SET", `nl:hooks:cfg:${OK_STATS}`, String(goneCfg)]]);
  await queueStoreForget(OK_STATS, GONE_SID);
  sent = 0;
  redis.pipeline = counting;
  const real1 = await retryStoreForgets(Date.now() + 10_000);
  restore();
  is(
    "tried with the real forgets: done, out of the line, the log, the bodies and the keys gone, within FORGET_TRY_COMMANDS",
    [real1, await exists(`nl:hooks:log:${OK_STATS}`), await exists("nl:hooks:d:dlv_000000000000000000000000"), await resolveKey(goneKey.key), sent - 1 <= FORGET_TRY_COMMANDS, (await storeForgetMonth(monthNow))?.done],
    [{ done: 1, failed: 0, gaveUp: 0, left: 0 }, false, false, null, true, 1],
  );
  malform(on("HGETALL", "nl:forget:q"), { 0: "x" });
  is("a line read in another shape: the run fails, it never reads as an empty line", await rejects(() => retryStoreForgets(Date.now() + 10_000)), "Error");
  restore();
  const storesRoute = readFileSync("app/api/store/stores/route.ts", "utf8");
  const closingCron = readFileSync("app/api/cron/closing/route.ts", "utf8");
  is(
    "a delete whose first try failed puts it in line; the daily closing job tries the line again",
    [storesRoute.includes("await queueStoreForget(result.store.statsId ?? null, result.store.sid)"), storesRoute.includes("forgetStoreWebhooks(result.store.statsId), revokeAllKeys(result.store.sid)"), closingCron.includes("await retryStoreForgets(start + 32_000)")],
    [true, false, true],
  );

  // Last, as it moves the stand-in's clock past every session above.
  part("5 (review of #2556): a lock that could not be lifted by logging out outlasts its day, never the session");
  const LATE = "late@example.com";
  const DAY = 86_400_000;
  const lateUntil = Date.now() + RESET_DAYS * DAY;
  const before = await openLockedSession(LATE, lateUntil);
  await alignRecoveryLock(LATE, lateUntil);
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  await endRecoveryAccess(LATE);
  restore();
  // Opened after its account's locked sessions could not be logged out: its own day sets it free as before.
  const after = await openLockedSession(LATE, Date.now() + 60_000, Date.now() + 1_000);
  advance((RESET_DAYS + 1) * DAY);
  const pastDay = Date.now() + (RESET_DAYS + 1) * DAY;
  is(
    "RESET_DAYS + 1 later: the session it could not log out is still locked; one opened after it is not",
    [(await lockedUntil(before, pastDay)) > pastDay, await emailForSession(before), await lockedUntil(after, pastDay)],
    [true, LATE, 0],
  );
  // A lock written before 5 November 2026 ("<until>" alone, lapsing on its day): still listed, so still locked.
  const OLDER = "older@example.com";
  const olderUntil = Date.now() + RESET_DAYS * DAY;
  const legacy = await openLockedSession(OLDER, olderUntil);
  await redis.pipeline([["SET", `nl:2fa:locked:${sha(`nimbus-2fa-locked:${legacy}`).slice(0, 40)}`, String(olderUntil), "EX", RESET_DAYS * 86_400]]);
  const unlisted = await openSession(OLDER);
  await alignRecoveryLock(OLDER, olderUntil);
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  await endRecoveryAccess(OLDER);
  restore();
  advance((RESET_DAYS + 1) * DAY);
  const pastOlder = Date.now() + (RESET_DAYS + 1) * DAY;
  is(
    "a lock in the old format, its key lapsed: still locked while listed; a session never locked is not",
    [(await lockedUntil(legacy, pastOlder)) > pastOlder, await lockedUntil(unlisted, pastOlder)],
    [true, 0],
  );
  malform((command) => command[0] === "SISMEMBER" && String(command[1]).startsWith("nl:2fa:lockedset:"), "1");
  is("(whether it is listed answered in another shape: locked)", (await lockedUntil(legacy, pastOlder)) > 0, true);
  restore();
  advance((30 - RESET_DAYS - 1) * DAY + 60_000);
  is("thirty days on: the session itself is over, so there is nothing left to lock", [await emailForSession(before), await lockedUntil(before, Date.now() + 31 * DAY)], [null, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
