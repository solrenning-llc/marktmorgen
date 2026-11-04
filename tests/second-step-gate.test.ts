/**
 * A new way in needs the old one (lib/second-step-gate.ts, owner C3-81): on
 * an account that already has a passkey or an authenticator app, a session
 * opened only by the emailed link, however fresh, adds no passkey and turns
 * on no app; a session opened with the passkey or the app's code does. An
 * account with neither still adds its first from the link. A passkey removed
 * from a link session waits REMOVAL_DAYS with an email (the way back for a
 * lost passkey); no login calls it off, only "Keep it" from a session with a
 * valid second step (security review of 3467adf6d); once it
 * has gone, the link adds a new one. Synthetic records; no email leaves.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession, openSession, sessionSecondStep } from "@/lib/auth";
import { PASSKEY_COOKIE, REMOVAL_DAYS, cancelRemoval, listPasskeys, movePasskeys, pendingRemoval, removePasskey, scheduleRemoval, unlessSetToGo } from "@/lib/passkeys";
import { keepRecoveryAddress, sendLostEmailLink } from "@/lib/recovery-address";
import { POST as lostConfirm } from "@/app/api/auth/lost/confirm/route";
import { RESET_DAYS, cancelReset, checkCode, finishSetup, lockedUntil, moveTwoStep, replaceCodes, resetIfDue, spendRescue, startSetup, turnOff, twoStepStatus } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { releaseLock, takeLock } from "@/lib/redis-lock";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { hasSecondStep, liveSecondStep, mayAddNow, mayAddSecondStep, mayKeepPasskey } from "@/lib/second-step-gate";
import { secondStepWay } from "@/lib/team";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as passkeyRoute } from "@/app/api/auth/passkey/route";
import { POST as passkeySignIn } from "@/app/api/auth/passkey/signin/route";
import { POST as twoStepRoute } from "@/app/api/auth/two-step/route";
import { makePasskey } from "./passkey-world";
import { POST as addressRoute } from "@/app/api/store/address/route";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { claimHandle, storeForEmail } from "@/lib/store";
import { POST as recoveryRoute } from "@/app/api/auth/recovery-address/route";
import { endMoving, isMoving, markBrokenMove, markMoving, readBrokenMove, sendMoveLink } from "@/lib/auth";
import { clearBrokenMoveByHand, describeMove } from "@/lib/move-repair";
import { existsSync } from "node:fs";
import { removalWhen } from "@/lib/removal-time";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_second_step_gate_only";
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const KAI = "kai-passkey@example.com";
const NOA = "noa-nothing@example.com";

async function linkSession(email: string): Promise<string> {
  const token = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  const response = await callback(new NextRequest(`${ORIGIN}/api/auth/callback`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }));
  return (response.headers.get("set-cookie") ?? "").match(/nl_session=([^;]*)/)?.[1] ?? "";
}
// Each test browser its own address, so the sign-in's tries per address (app/api/auth/passkey/signin) never run out here.
let browsers = 0;
const asJson = (url: string, body: unknown, cookie: string) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", cookie, "x-forwarded-for": `198.51.100.${Math.floor(browsers++ / 2) % 250}` }, body: JSON.stringify(body) });
const passkeys = async (session: string, body: Record<string, unknown>) => {
  const r = await passkeyRoute(asJson(`${ORIGIN}/api/auth/passkey`, body, `nl_session=${session}`));
  return { status: r.status, ...((await r.json()) as { ok: boolean; error?: string; removeOn?: number }) };
};
const twoStep = async (session: string) => {
  const r = await twoStepRoute(asJson(`${ORIGIN}/api/auth/two-step`, { action: "start", backup: "noa-backup@example.org" }, `nl_session=${session}`));
  return { status: r.status, ...((await r.json()) as { ok: boolean; error?: string }) };
};
const form = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";
/** A removal record with every passkey's moment already past, as if its days were over. */
const overdue = (raw: unknown) => {
  const record = JSON.parse(String(raw)) as { atOf?: Record<string, number>; ids?: string[]; told: number };
  if (!record.atOf) return JSON.stringify({ ...record, at: Date.now() - 1_000 });
  return JSON.stringify({ ...record, atOf: Object.fromEntries(Object.keys(record.atOf).map((id) => [id, Date.now() - 1_000])) });
};
const lockOf = (email: string) => `nl:pk:lock:${hex(`nimbus-passkey-lock:${email}`).slice(0, 40)}`;

/** Turns the app on for an account, as the studio does; answers its secret and recovery codes. */
async function turnOnApp(email: string, backup: string): Promise<{ secret: Buffer; codes: string[] }> {
  const setup = await startSetup(email, "d".repeat(64), backup);
  if (typeof setup === "string") throw new Error(setup);
  const sent = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === backup)?.text ?? "")?.[1] ?? "";
  const secret = base32Decode(setup.secret)!;
  const finished = await finishSetup(email, "d".repeat(64), codeAt(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)), sent);
  if (typeof finished === "string") throw new Error(finished);
  return { secret, codes: finished.codes };
}

async function signInWithPasskey(key: ReturnType<typeof makePasskey>): Promise<string> {
  const options = await passkeySignIn(asJson(`${ORIGIN}/api/auth/passkey/signin`, { action: "options" }, ""));
  const nonce = (options.headers.get("set-cookie") ?? "").match(new RegExp(`${PASSKEY_COOKIE}=([^;]*)`))?.[1] ?? "";
  const { options: asked } = (await options.json()) as { options: { challenge: string } };
  const verified = await passkeySignIn(asJson(`${ORIGIN}/api/auth/passkey/signin`, { action: "verify", response: key.answer(asked.challenge) }, `${PASSKEY_COOKIE}=${nonce}`));
  return (verified.headers.get("set-cookie") ?? "").match(/nl_session=([^;]*)/)?.[1] ?? "";
}

async function main(): Promise<void> {
  redis.clear();
  is("the passkey wait is the app's wait", REMOVAL_DAYS, RESET_DAYS);

  part("An account with a passkey: the emailed link adds nothing");
  const kai = makePasskey(KAI, "cred-kai-1");
  await kai.keep();
  const byLink = await linkSession(KAI);
  is("the link opened a fresh session", byLink.length, 64);
  is("the account has a second step", await hasSecondStep(KAI), true);
  is("no new passkey from it", await passkeys(byLink, { action: "options" }), { status: 403, ok: false, error: "second_step" });
  is("nor an answer slipped past the options", (await passkeys(byLink, { action: "add", response: { id: "x" }, name: "Mine" })).error, "second_step");
  is("no authenticator app from it", await twoStep(byLink), { status: 403, ok: false, error: "second_step" });
  const old = await openSession(KAI);
  is("nor from a session older than the mark", (await passkeys(old, { action: "options" })).error, "second_step");

  part("The same account, logged in with its passkey");
  const byPasskey = await signInWithPasskey(kai);
  is("adds a passkey", [(await passkeys(byPasskey, { action: "options" })).ok, await mayAddSecondStep(KAI, byPasskey)], [true, true]);

  part("An account with neither still adds its first from the link");
  const first = await linkSession(NOA);
  is("a passkey", (await passkeys(first, { action: "options" })).ok, true);
  is("or an app", (await twoStep(first)).ok, true);

  part("A lost passkey: removing it from the link waits, with an email");
  mails.length = 0;
  const now = Date.now();
  const removed = await passkeys(byLink, { action: "remove", id: "cred-kai-1" });
  is("answered with the day, not removed", [removed.ok, typeof removed.removeOn === "number" && Math.abs(removed.removeOn - (now + REMOVAL_DAYS * 86_400_000)) < 60_000, (await listPasskeys(KAI)).length], [true, true, 1]);
  is("the account is told at once", mails.some((m) => m.to === KAI && m.subject === "A passkey is set to be removed from your Marktmorgen account"), true);
  is("asking again does not move the day", (await passkeys(byLink, { action: "remove", id: "cred-kai-1" })).removeOn, removed.removeOn);
  is("still no passkey from the link meanwhile", (await passkeys(byLink, { action: "options" })).error, "second_step");
  const stillIn = await signInWithPasskey(kai);
  is("logging in with that very passkey within the days works", stillIn.length, 64);
  is("but does not keep it: the removal still waits", [(await pendingRemoval(KAI))?.ids, (await listPasskeys(KAI)).length], [["cred-kai-1"], 1]);
  is("and nothing says it stays", mails.some((m) => m.to === KAI && m.subject === "Your passkeys stay on your Marktmorgen account"), false);
  const kaiB = makePasskey(KAI, "cred-kai-b");
  await kaiB.keep();
  const byOther = await signInWithPasskey(kaiB);
  is("logging in with another passkey does not call it off either", [byOther.length, (await pendingRemoval(KAI))?.ids, (await listPasskeys(KAI)).length], [64, ["cred-kai-1"], 2]);
  is("“Keep it” from that session does", [(await passkeys(byOther, { action: "keep", id: "cred-kai-1" })).ok, await pendingRemoval(KAI)], [true, null]);
  is("and says so", mails.some((m) => m.to === KAI && m.subject === "Your passkey stays on your Marktmorgen account"), true);
  await passkeys(byOther, { action: "remove", id: "cred-kai-b" });
  await passkeys(byLink, { action: "remove", id: "cred-kai-1" });
  const dropKai = `nl:pk:drop:${hex(`nimbus-passkey-drop:${KAI}`).slice(0, 40)}`;
  const [rawDrop] = await redis.pipeline([["GET", dropKai]]);
  await redis.pipeline([["SET", dropKai, overdue(rawDrop)]]);
  is("once its days are over, it does not log in", await signInWithPasskey(kai), "");
  const after = Date.now() + 60_000;
  is("it is gone", [await pendingRemoval(KAI, after), (await listPasskeys(KAI)).length, await hasSecondStep(KAI, after)], [null, 0, false]);
  const back = await linkSession(KAI);
  is("then the link adds a new one", (await passkeys(back, { action: "options" })).ok, true);

  part("From a session with the step, removing is at once");
  const kai2 = makePasskey(KAI, "cred-kai-2");
  await kai2.keep();
  const withKey = await signInWithPasskey(kai2);
  is("removed now", [(await passkeys(withKey, { action: "remove", id: "cred-kai-2" })).removeOn, (await listPasskeys(KAI)).length], [undefined, 0]);
  is("the session that removed it stays, without its mark", [await emailForSession(withKey), await sessionSecondStep(withKey, KAI)], [KAI, null]);

  part("A team member is never offered a passkey whose days are over");
  const ADA = "ada-overdue@example.com";
  const ada = makePasskey(ADA, "cred-ada-1");
  await ada.keep();
  await scheduleRemoval(ADA, "cred-ada-1", "f".repeat(64), false, Date.now() - (REMOVAL_DAYS * 86_400_000) - 60_000);
  is("the way offered is to set one up, and the passkey is gone", [await secondStepWay(ADA), (await listPasskeys(ADA)).length], ["set_up", 0]);

  part("A session opened with a passkey set to be removed has no second step");
  const BO = "bo-doomed@example.com";
  const boP = makePasskey(BO, "cred-bo-p");
  const boQ = makePasskey(BO, "cred-bo-q");
  await boP.keep();
  await boQ.keep();
  await turnOnApp(BO, "bo-backup@example.org");
  const boOld = await openSession(BO);
  is("P is asked to go", typeof (await passkeys(boOld, { action: "remove", id: "cred-bo-p" })).removeOn, "number");
  const byP = await signInWithPasskey(boP);
  is("P still logs in within its days", byP.length, 64);
  is("but its session has no second step", [await sessionSecondStep(byP, BO), await liveSecondStep(BO, byP)], ["passkey", null]);
  is("(b) it adds no passkey", (await passkeys(byP, { action: "options" })).error, "second_step");
  is("(b) it turns on no app either", (await twoStep(byP)).error, "second_step");
  const qFromP = await passkeys(byP, { action: "remove", id: "cred-bo-q" });
  is("(c) removing Q from it only waits, Q is not removed at once", [typeof qFromP.removeOn, (await listPasskeys(BO)).length], ["number", 2]);
  is("(a) it cannot keep P", (await passkeys(byP, { action: "keep", id: "cred-bo-p" })).error, "second_step");
  const boCancel = await twoStepRoute(asJson(`${ORIGIN}/api/auth/two-step`, { action: "cancel" }, `nl_session=${byP}`));
  is("nor press Cancel under Two-step login", [boCancel.status, ((await boCancel.json()) as { error?: string }).error], [403, "second_step"]);
  is("both still wait", (await pendingRemoval(BO))?.ids.sort(), ["cred-bo-p", "cred-bo-q"]);

  part("Two passkeys set to be removed never keep each other");
  mails.length = 0;
  const byQ = await signInWithPasskey(boQ);
  is("Q logs in, with no second step", [byQ.length, await liveSecondStep(BO, byQ)], [64, null]);
  is("and calls nothing off: P and Q both still wait", (await pendingRemoval(BO))?.ids.sort(), ["cred-bo-p", "cred-bo-q"]);
  is("nor says another passkey kept them", mails.some((m) => m.to === BO && m.subject === "Your passkeys stay on your Marktmorgen account"), false);

  part("Once the days are over: nothing is called off, and the old session does nothing");
  const dropBo = `nl:pk:drop:${hex(`nimbus-passkey-drop:${BO}`).slice(0, 40)}`;
  const [rawBo] = await redis.pipeline([["GET", dropBo]]);
  await redis.pipeline([["SET", dropBo, overdue(rawBo)]]);
  is("a removal whose days are over cannot be kept", [await cancelRemoval(BO, "cred-bo-p", await openSession(BO, "app")), (await listPasskeys(BO)).length], ["unknown", 0]);
  is("the session P opened before is logged out with it", await emailForSession(byP), null);
  is("and used by the API it removes nothing and adds nothing", [(await passkeys(byP, { action: "remove", id: "cred-bo-q" })).error, (await passkeys(byP, { action: "options" })).error], ["signed_out", "signed_out"]);

  part("Keep it: the owner's rule (C3-95)");
  is("no second step, no Keep it; another passkey or the app's code may", [mayKeepPasskey(null), mayKeepPasskey("passkey"), mayKeepPasskey("app")], [false, true, true]);

  part("The app's code does not call a removal off");
  const ZOE = "zoe-code@example.com";
  const zoe = makePasskey(ZOE, "cred-zoe-1");
  await zoe.keep();
  const zoeApp = await turnOnApp(ZOE, "zoe-backup@example.org");
  is("asked from a session without the step", typeof (await passkeys(await openSession(ZOE), { action: "remove", id: "cred-zoe-1" })).removeOn, "number");
  const tokenZoe = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenZoe}`).slice(0, 40)}`, ZOE, "EX", 900]]);
  const heldZoe = await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenZoe }));
  await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: zoeApp.codes[0] }, `nl_2fa=${cookieOf(heldZoe, "nl_2fa")}`));
  is("logging in with a recovery code leaves the removal waiting", [(await pendingRemoval(ZOE))?.ids, (await listPasskeys(ZOE)).length], [["cred-zoe-1"], 1]);

  part("What a removed passkey or a turned-off app opened goes with it");
  const LEA = "lea-two-keys@example.com";
  const one = makePasskey(LEA, "cred-lea-1");
  const two = makePasskey(LEA, "cred-lea-2");
  await one.keep();
  await two.keep();
  const byOne = await signInWithPasskey(one);
  const byOneElsewhere = await signInWithPasskey(one);
  const byTwo = await signInWithPasskey(two);
  is("three sessions, each marked with its passkey", [await sessionSecondStep(byOne, LEA), await sessionSecondStep(byTwo, LEA)], ["passkey", "passkey"]);
  await passkeys(byTwo, { action: "remove", id: "cred-lea-1" });
  is("removing the first logs out what it opened", [await emailForSession(byOne), await emailForSession(byOneElsewhere)], [null, null]);
  is("and leaves the other passkey's session as it was", [await emailForSession(byTwo), await sessionSecondStep(byTwo, LEA)], [LEA, "passkey"]);
  const app = await turnOnApp(LEA, "lea-backup@example.org");
  const heldLea = await callback(form(`${ORIGIN}/api/auth/callback`, { token: await (async () => { const t = hex(String(Math.random())); await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${t}`).slice(0, 40)}`, LEA, "EX", 900]]); return t; })() }));
  const byCode = cookieOf(await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: app.codes[0] }, `nl_2fa=${cookieOf(heldLea, "nl_2fa")}`)), "nl_session");
  const byCode2 = await openSession(LEA, "app");
  is("two sessions opened with the app", [await sessionSecondStep(byCode, LEA), await sessionSecondStep(byCode2, LEA)], ["recovery", "app"]);
  const off = await twoStepRoute(asJson(`${ORIGIN}/api/auth/two-step`, { action: "off", code: app.codes[1] }, `nl_session=${byCode}`));
  is("turning the app off", off.status, 200);
  is("logs out the other session it opened, and leaves this one logged in without its mark", [await emailForSession(byCode2), await emailForSession(byCode), await sessionSecondStep(byCode, LEA)], [null, LEA, null]);
  is("a passkey's session is not touched", await sessionSecondStep(byTwo, LEA), "passkey");

  part("Lost the app and the passkey, with no recovery inbox: the two waits run together");
  const MIA = "mia-lost-all@example.com";
  const mia = makePasskey(MIA, "cred-mia-1");
  await mia.keep();
  await turnOnApp(MIA, "mia-backup@example.org");
  const tokenMia = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenMia}`).slice(0, 40)}`, MIA, "EX", 900]]);
  const heldMia = await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenMia }));
  const lockedMia = cookieOf(await codeRoute(form(`${ORIGIN}/api/auth/code`, { action: "reset" }, `nl_2fa=${cookieOf(heldMia, "nl_2fa")}`)), "nl_session");
  const until = await lockedUntil(lockedMia);
  is("let in without the second step, locked", until > Date.now(), true);
  is("it still adds nothing", (await passkeys(lockedMia, { action: "options" })).error, "locked");
  const asked = await passkeys(lockedMia, { action: "remove", id: "cred-mia-1" });
  is("but it may ask for the passkey's removal, which waits as long as the lock", [asked.ok, typeof asked.removeOn === "number" && Math.abs(asked.removeOn - until) < 60_000, (await listPasskeys(MIA)).length], [true, true, 1]);
  is("and the account is told", mails.some((m) => m.to === MIA && m.subject === "A passkey is set to be removed from your Marktmorgen account" && m.text.includes("Coordinated Universal Time (UTC)")), true);
  const later = until + 120_000;
  is("on that day both are gone", [await resetIfDue(MIA, later), (await twoStepStatus(MIA)).on, await pendingRemoval(MIA, later), (await listPasskeys(MIA)).length, await hasSecondStep(MIA, later)], [true, false, null, 0, false]);

  part("The account's lock: a removal and a sign-in never write over each other");
  const NIA = "nia-race@example.com";
  const nia = makePasskey(NIA, "cred-nia-1");
  await nia.keep();
  const viaLink = await linkSession(NIA);
  const held = await takeLock(lockOf(NIA), 5, 1_000);
  const scheduling = passkeys(viaLink, { action: "remove", id: "cred-nia-1" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  is("a removal asked while the lock is held waits for it", await pendingRemoval(NIA), null);
  await releaseLock(held);
  is("and is written once it is let go", typeof (await scheduling).removeOn, "number");
  const heldAgain = await takeLock(lockOf(NIA), 5, 1_000);
  const cancelling = signInWithPasskey(nia);
  await new Promise((resolve) => setTimeout(resolve, 80));
  is("the sign-in's cancellation waits too: the removal is still asked", (await pendingRemoval(NIA)) !== null, true);
  // Meanwhile the passkey goes, as a removal whose wait ran out would take it.
  await redis.pipeline([["DEL", `nl:pk:${hex(`nimbus-passkeys:${NIA}`).slice(0, 40)}`]]);
  await releaseLock(heldAgain);
  is("a passkey removed while its sign-in was checked opens nothing", await cancelling, "");
  is("and is not written back", (await listPasskeys(NIA)).length, 0);

  part("A removal asked through the recovery address stays when the owner's full login closes that session");
  const SAM = "sam-recovery@example.com";
  const sam = makePasskey(SAM, "cred-sam-1");
  await sam.keep();
  await keepRecoveryAddress(SAM, "sam-rec@example.org");
  await sendLostEmailLink(SAM, "203.0.113.9", ORIGIN);
  const lostToken = /token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === "sam-rec@example.org")?.text ?? "")?.[1] ?? "";
  const viaRecovery = cookieOf(await lostConfirm(form(`${ORIGIN}/api/auth/lost/confirm`, { token: lostToken })), "nl_session");
  is("the recovery address opened a locked session", [viaRecovery.length, (await lockedUntil(viaRecovery)) > Date.now()], [64, true]);
  is("which asks for the passkey's removal", typeof (await passkeys(viaRecovery, { action: "remove", id: "cred-sam-1" })).removeOn, "number");
  mails.length = 0;
  await linkSession(SAM);
  is("the owner's login with the sign-in inbox logs it out", await emailForSession(viaRecovery), null);
  is("but its removal stays: no login calls one off", [(await pendingRemoval(SAM))?.ids, (await listPasskeys(SAM)).length], [["cred-sam-1"], 1]);
  is("the notice that what the recovery address opened was closed, and none that the passkey stays", [mails.some((m) => m.to === SAM && m.subject === "What your recovery address opened was closed"), mails.some((m) => m.to === SAM && m.subject.startsWith("Your passkey"))], [true, false]);
  await cancelRemoval(SAM, "cred-sam-1", await openSession(SAM, "app"));
  const sam2 = makePasskey(SAM, "cred-sam-2");
  await sam2.keep();
  const samKey = await signInWithPasskey(sam2);
  const samLink = await linkSession(SAM);
  await passkeys(samLink, { action: "remove", id: "cred-sam-1" });
  await linkSession(SAM);
  is("a removal asked by a session that stays open is not called off by another login", (await pendingRemoval(SAM)) !== null, true);
  is("“Keep it” from a session without a second step is refused (owner C3-95)", await passkeys(samLink, { action: "keep", id: "cred-sam-1" }), { status: 403, ok: false, error: "second_step" });
  is("from a session opened with another passkey, “Keep it” calls it off", [(await passkeys(samKey, { action: "keep", id: "cred-sam-1" })).ok, await pendingRemoval(SAM)], [true, null]);

  part("Asking again within the hour is not emailed again");
  const TIA = "tia-again@example.com";
  const tia = makePasskey(TIA, "cred-tia-1");
  await tia.keep();
  const t0 = Date.now();
  const told = () => mails.filter((m) => m.to === TIA && m.subject === "A passkey is set to be removed from your Marktmorgen account").length;
  await scheduleRemoval(TIA, "cred-tia-1", "e".repeat(64), false, t0);
  await scheduleRemoval(TIA, "cred-tia-1", "e".repeat(64), false, t0 + 10 * 60_000);
  is("once in the first hour", told(), 1);
  await scheduleRemoval(TIA, "cred-tia-1", "e".repeat(64), false, t0 + 61 * 60_000);
  is("again an hour later", told(), 2);
  const tiaMail = [...mails].reverse().find((m) => m.to === TIA && m.subject === "A passkey is set to be removed from your Marktmorgen account")?.text ?? "";
  is("the email says when, with the time and the time zone spelled out", tiaMail.includes(`It will be removed on ${removalWhen(t0 + REMOVAL_DAYS * 86_400_000)}.`) && tiaMail.includes("Coordinated Universal Time (UTC)"), true);
  is(
    "its only passkey, no app: the email says the truth, nothing can stop it, and what to do on the day",
    [
      tiaMail.includes("every passkey on your account is set to be removed and you have no authenticator app, so nothing can stop it"),
      tiaMail.includes(`On ${removalWhen(t0 + REMOVAL_DAYS * 86_400_000)}, log in at`),
      tiaMail.includes("If this was you, there is nothing to do: each is removed on its day."),
      tiaMail.includes("anyone who can open this email inbox can do the same and add a passkey of their own"),
      tiaMail.includes("without a passkey or an app code"),
    ],
    [true, true, true, true, false],
  );
  const UNA = "una-two@example.com";
  const unaP = makePasskey(UNA, "cred-una-p");
  const unaQ = makePasskey(UNA, "cred-una-q");
  await unaP.keep();
  await unaQ.keep();
  await keepRecoveryAddress(UNA, "una-rec@example.org");
  const atUna = await scheduleRemoval(UNA, "cred-una-p", "e".repeat(64), true, t0);
  is("the confirmed recovery address is told too (MM-SA-19)", mails.some((m) => m.to === "una-rec@example.org" && m.subject === "A passkey is set to be removed from your Marktmorgen account" && m.text.includes(`It will be removed on ${removalWhen(atUna!)}.`)), true);
  const unaMail = [...mails].reverse().find((m) => m.to === UNA && m.subject === "A passkey is set to be removed from your Marktmorgen account")?.text ?? "";
  is(
    "with another passkey and the app: when, and what to do if it was not them; only Keep it stops it",
    [
      unaMail.includes(`It will be removed on ${removalWhen(atUna!)}.`),
      unaMail.includes(`If it was not you, stop it before ${removalWhen(atUna!)}:`),
      unaMail.includes("with a passkey that is not on that list, or the emailed link and the code from your authenticator app."),
      unaMail.includes("press “Keep it” next to each passkey you want to keep. Only “Keep it” stops a removal: logging in alone does not, and logging in with a passkey that is being removed cannot."),
    ],
    [true, true, true, true],
  );

  part("A stolen passkey stays set to go, whatever the owner logs in with (review of 3467adf6d)");
  const OW = "owner-lost@example.com";
  const owP = makePasskey(OW, "cred-ow-p");
  const owQ = makePasskey(OW, "cred-ow-q");
  await owP.keep();
  await owQ.keep();
  const owApp = await turnOnApp(OW, "ow-backup@example.org");
  const thief = await signInWithPasskey(owP);
  is("the thief's session with P had a second step", await liveSecondStep(OW, thief), "passkey");
  const hotel = await openSession(OW);
  is("the owner asks for P's removal from a session without the step", typeof (await passkeys(hotel, { action: "remove", id: "cred-ow-p" })).removeOn, "number");
  is("the thief's session is logged out at once", await emailForSession(thief), null);
  const ownerQ = await signInWithPasskey(owQ);
  is("the owner logs in with Q", ownerQ.length, 64);
  is("P is still set to go", (await pendingRemoval(OW))?.ids, ["cred-ow-p"]);
  const tokenOw = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenOw}`).slice(0, 40)}`, OW, "EX", 900]]);
  const heldOw = await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenOw }));
  const ownerCode = cookieOf(await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: owApp.codes[0] }, `nl_2fa=${cookieOf(heldOw, "nl_2fa")}`)), "nl_session");
  is("the owner logs in with the app's code", ownerCode.length, 64);
  is("P is still set to go", (await pendingRemoval(OW))?.ids, ["cred-ow-p"]);
  const thiefAgain = await signInWithPasskey(owP);
  is("a new session with P has no second step", [thiefAgain.length, await liveSecondStep(OW, thiefAgain)], [64, null]);
  is("and removes Q only after the wait, not at once", [typeof (await passkeys(thiefAgain, { action: "remove", id: "cred-ow-q" })).removeOn, (await listPasskeys(OW)).map((p) => p.id).sort()], ["number", ["cred-ow-p", "cred-ow-q"]]);
  is("Keep it from the owner's own session keeps Q", (await passkeys(ownerCode, { action: "keep", id: "cred-ow-q" })).ok, true);

  part("The record waits with no expiry until it is applied, and moves with the account");
  const dropOw = `nl:pk:drop:${hex(`nimbus-passkey-drop:${OW}`).slice(0, 40)}`;
  is("no expiry on the removal record", (await redis.pipeline([["TTL", dropOw]]))[0], -1);
  const OW2 = "owner-moved@example.com";
  await movePasskeys(OW, OW2);
  is("after a move, P is set to go at the new address, with the same moment", [(await pendingRemoval(OW2))?.ids, (await pendingRemoval(OW))], [["cred-ow-p"], null]);

  part("Checked again under the lock: a session whose passkey is set to go keeps and removes nothing");
  const VI = "vi-lock@example.com";
  const viP = makePasskey(VI, "cred-vi-p");
  const viQ = makePasskey(VI, "cred-vi-q");
  const viR = makePasskey(VI, "cred-vi-r");
  await viP.keep();
  await viQ.keep();
  await viR.keep();
  const viQSession = await signInWithPasskey(viQ);
  // P and then Q set to go, written straight in, as a request landing between the route's check and the lock would.
  await redis.pipeline([["SET", `nl:pk:drop:${hex(`nimbus-passkey-drop:${VI}`).slice(0, 40)}`, JSON.stringify({ ids: ["cred-vi-p", "cred-vi-q"], at: Date.now() + 86_400_000, told: Date.now() })]]);
  is("Keep it of P from Q's session is refused under the lock", await cancelRemoval(VI, "cred-vi-p", viQSession), "second_step");
  is("removing R at once from it is refused under the lock", [await removePasskey(VI, "cred-vi-r", viQSession), (await listPasskeys(VI)).length], ["second_step", 3]);

  part("The app's mark holds only while the app is on");
  const WIN = "win-noapp@example.com";
  is("a session marked by the app on an account without it has no second step", await liveSecondStep(WIN, await openSession(WIN, "app")), null);

  part("A code is used once, even at the same moment, and never brings back a record turned off");
  const XAN = "xan-code@example.com";
  const xan = await turnOnApp(XAN, "xan-backup@example.org");
  const nextStep = codeAt(xan.secret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);
  const both = await Promise.all([checkCode(XAN, nextStep), checkCode(XAN, nextStep)]);
  is("two logins with the same code at once: one passes", both.sort(), ["app", "wrong"]);
  const twice = await Promise.all([checkCode(XAN, xan.codes[0]), checkCode(XAN, xan.codes[0])]);
  is("two with the same recovery code at once: one passes", twice.sort(), ["recovery", "wrong"]);
  // As if a day had passed for these codes: their one-use marks are gone, so only the record decides.
  const forgetOnce = async (email: string, codes: string[]) => {
    const keys = codes.map((code) => `nl:2fa:once:${hex(`nimbus-2fa-once:${email}:code:${hex(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`)}`).slice(0, 40)}`);
    await redis.pipeline([["DEL", ...keys]]);
  };
  const YAS = "yas-race@example.com";
  const yas = await turnOnApp(YAS, "yas-backup@example.org");
  const yasStep = codeAt(yas.secret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);
  is("an app code and recovery code A at the same moment: both pass", (await Promise.all([checkCode(YAS, yas.codes[0]), checkCode(YAS, yasStep)])).sort(), ["app", "recovery"]);
  await forgetOnce(YAS, [yas.codes[0]]);
  is("and A never comes back, even once its one-use mark is gone", await checkCode(YAS, yas.codes[0]), "wrong");
  const ZED = "zed-race@example.com";
  const zed = await turnOnApp(ZED, "zed-backup@example.org");
  const zedStep = codeAt(zed.secret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);
  const [fresh] = await Promise.all([replaceCodes(ZED, zedStep), checkCode(ZED, zed.codes[1])]);
  await forgetOnce(ZED, [zed.codes[1]]);
  is("new recovery codes made while a leaked code is checked: the old code never works after", [typeof fresh === "object", await checkCode(ZED, zed.codes[2]), await checkCode(ZED, zed.codes[1])], [true, "wrong", "wrong"]);
  const AMY = "amy-race@example.com";
  const amy = await turnOnApp(AMY, "amy-backup@example.org");
  await Promise.all([turnOff(AMY, amy.codes[0]), checkCode(AMY, amy.codes[1]), cancelReset(AMY, "studio")]);
  is("turning it off while a code is checked and Cancel is pressed: it stays off", (await twoStepStatus(AMY)).on, false);

  part("A move never joins another address's ways in to the account (review of da5191515)");
  const VIC = "vic-move@example.com";
  await claimHandle(VIC, "vic-move", "Vic Move", "");
  const vicP = makePasskey(VIC, "cred-vic-p");
  await vicP.keep();
  const ATK = "atk-move@example.com";
  const atkQ = makePasskey(ATK, "cred-atk-q");
  await atkQ.keep();
  const atkSession = await signInWithPasskey(atkQ);
  const askMove = async (session: string, to: string) => {
    const r = await addressRoute(form(`${ORIGIN}/api/store/address`, { email: to }, `nl_session=${session}`));
    return (r.headers.get("location") ?? "").split("address=")[1] ?? r.headers.get("location");
  };
  is("asked by a session opened only by the emailed link, on an account with a passkey: refused", await askMove(await linkSession(VIC), ATK), "second-step");
  const vicByP = await signInWithPasskey(vicP);
  is("asked with the passkey, onto an address with its own passkey: refused", await askMove(vicByP, ATK), "has-login");
  const tapMove = async (to: string) => {
    mails.length = 0;
    await sendMoveLink(VIC, to, ORIGIN, vicByP);
    const token = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
    const r = await moveRoute(form(`${ORIGIN}/api/auth/move`, { token }));
    return r.headers.get("location") ?? "";
  };
  is("the tap itself refuses an address with its own passkey", await tapMove(ATK), `${ORIGIN}/signin?status=move-has-login`);
  is("nothing joined: the account keeps only its passkey, the attacker's session gets no second step on it", [(await listPasskeys(VIC)).map((p) => p.id), (await listPasskeys(ATK)).map((p) => p.id), await liveSecondStep(VIC, atkSession)], [["cred-vic-p"], ["cred-atk-q"], null]);
  const ATK2 = "atk-app@example.com";
  await turnOnApp(ATK2, "atk2-backup@example.org");
  is("an address with its own app and codes: refused", await tapMove(ATK2), `${ORIGIN}/signin?status=move-has-login`);
  const ATK3 = "atk-drop@example.com";
  await redis.pipeline([["SET", `nl:pk:drop:${hex(`nimbus-passkey-drop:${ATK3}`).slice(0, 40)}`, JSON.stringify({ ids: ["cred-gone"], at: Date.now() - 1_000, told: 0 })]]);
  is("an address with a passkey removal waiting, even one already due: refused", await tapMove(ATK3), `${ORIGIN}/signin?status=move-has-login`);
  is("and the account's passkey did not fall", (await listPasskeys(VIC)).map((p) => p.id), ["cred-vic-p"]);
  const CLEAN = "vic-new@example.com";
  const before = await openSession(CLEAN);
  const moveDone = await tapMove(CLEAN);
  is("onto an address with nothing of its own, it moves, with the passkey", [moveDone.includes("/studio"), (await listPasskeys(CLEAN)).map((p) => p.id), (await listPasskeys(VIC)).length], [true, ["cred-vic-p"], 0]);
  is("and whatever that address had open before is logged out", await emailForSession(before), null);

  part("Small checks from the same review");
  const KIM = "kim-small@example.com";
  const kimP = makePasskey(KIM, "cred-kim-p");
  await kimP.keep();
  await scheduleRemoval(KIM, "cred-kim-p", "c".repeat(64), false);
  is("a team member whose only passkey is set to go is not told to log in with it", await secondStepWay(KIM), "set_up");
  let ran = false;
  is("work tied to a passkey set to go does not run", [await unlessSetToGo(KIM, "cred-kim-p", async () => { ran = true; }), ran], [false, false]);
  const LIA = "lia-fence@example.com";
  const liaP = makePasskey(LIA, "cred-lia-p");
  const liaQ = makePasskey(LIA, "cred-lia-q");
  await liaP.keep();
  await liaQ.keep();
  const liaSession = await signInWithPasskey(liaQ);
  is("work tied to a passkey not set to go runs", await unlessSetToGo(LIA, "cred-lia-q", async () => {}), true);
  const listLia = `nl:pk:${hex(`nimbus-passkeys:${LIA}`).slice(0, 40)}`;
  const pipe = redis.pipeline.bind(redis);
  let expired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The lock runs out in the middle of the removal, as a request held up past its five seconds.
    if (!expired && commands.some((c) => c[0] === "GET" && c[1] === listLia) && (await pipe([["EXISTS", lockOf(LIA)]]))[0] === 1) {
      expired = true;
      await pipe([["DEL", lockOf(LIA)]]);
    }
    return pipe(commands);
  }) as typeof redis.pipeline;
  const lost = await removePasskey(LIA, "cred-lia-p", liaSession).catch((error: unknown) => (error instanceof Error ? error.name || error.message : "error"));
  redis.pipeline = pipe;
  is("a removal whose lock ran out writes nothing: both passkeys stay", [lost !== "removed", (await listPasskeys(LIA)).map((p) => p.id).sort()], [true, ["cred-lia-p", "cred-lia-q"]]);

  part("Each passkey waits its own days, and each new one is told (review of 693f44f0b)");
  const NED = "ned-own@example.com";
  const nedP1 = makePasskey(NED, "cred-ned-1");
  const nedP2 = makePasskey(NED, "cred-ned-2");
  const nedP3 = makePasskey(NED, "cred-ned-3");
  await nedP1.keep();
  await nedP2.keep();
  await nedP3.keep();
  const T0 = Date.now();
  mails.length = 0;
  await scheduleRemoval(NED, "cred-ned-1", "a".repeat(64), false, T0);
  const at2 = await scheduleRemoval(NED, "cred-ned-2", "a".repeat(64), false, T0 + REMOVAL_DAYS * 86_400_000 - 60_000);
  is("a passkey asked a minute before another's day waits its own full days", at2, T0 + 2 * REMOVAL_DAYS * 86_400_000 - 60_000);
  const nedMails = mails.filter((m) => m.to === NED && m.subject === "A passkey is set to be removed from your Marktmorgen account");
  is("each new passkey asked is emailed, even within the hour", nedMails.length, 2);
  is(
    "the second email lists both, each with its own day, and points to a passkey not on the list",
    [nedMails[1].text.includes(`“Phone”: ${removalWhen(T0 + REMOVAL_DAYS * 86_400_000)}`), nedMails[1].text.includes(`“Phone”: ${removalWhen(at2!)}`), nedMails[1].text.includes("a passkey that is not on that list")],
    [true, true, true],
  );
  const dayOne = T0 + REMOVAL_DAYS * 86_400_000 + 1_000;
  is("on the first one's day only it goes; the second stays set to go", [await pendingRemoval(NED, dayOne).then((p) => p?.ids), (await listPasskeys(NED)).map((p) => p.id).sort()], [["cred-ned-2"], ["cred-ned-2", "cred-ned-3"]]);
  is("the account still has a second step, so the emailed link adds nothing", await mayAddSecondStep(NED, await openSession(NED), dayOne), false);
  await scheduleRemoval(NED, "cred-ned-3", "a".repeat(64), false, T0 + 1_000);
  const lastMail = [...mails].reverse().find((m) => m.to === NED && m.subject === "A passkey is set to be removed from your Marktmorgen account")?.text ?? "";
  is("when every passkey left is set to go and there is no app, the email says nothing can stop it", lastMail.includes("so nothing can stop it"), true);

  const OLA = "ola-hour@example.com";
  await makePasskey(OLA, "cred-ola-1").keep();
  await makePasskey(OLA, "cred-ola-2").keep();
  await makePasskey(OLA, "cred-ola-3").keep();
  const olaAt = Date.now();
  await scheduleRemoval(OLA, "cred-ola-1", "a".repeat(64), false, olaAt);
  await scheduleRemoval(OLA, "cred-ola-2", "a".repeat(64), false, olaAt + 5 * 60_000);
  await scheduleRemoval(OLA, "cred-ola-2", "a".repeat(64), false, olaAt + 6 * 60_000);
  is("a second passkey asked five minutes later is emailed too; the same one asked again is not", mails.filter((m) => m.to === OLA && m.subject === "A passkey is set to be removed from your Marktmorgen account").length, 2);

  part("The recovery address needs the second step to change, and its old address is told");
  const REX = "rex-recovery@example.com";
  const rexP = makePasskey(REX, "cred-rex-1");
  await rexP.keep();
  await keepRecoveryAddress(REX, "rex-old@example.org");
  const recovery = async (session: string, body: Record<string, unknown>) => {
    const r = await recoveryRoute(asJson(`${ORIGIN}/api/auth/recovery-address`, body, `nl_session=${session}`));
    return ((await r.json()) as { ok?: boolean; error?: string }).error ?? "ok";
  };
  const rexLink = await linkSession(REX);
  is("an emailed link alone cannot change it", await recovery(rexLink, { action: "start", address: "rex-new@example.org" }), "second_step");
  is("nor take it away", await recovery(rexLink, { action: "remove" }), "second_step");
  const rexKey = await signInWithPasskey(rexP);
  is("with the passkey it starts", await recovery(rexKey, { action: "start", address: "rex-new@example.org" }), "ok");
  const rexCode = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === "rex-new@example.org")?.text ?? "")?.[1] ?? "";
  mails.length = 0;
  is("and is confirmed", await recovery(rexKey, { action: "confirm", code: rexCode }), "ok");
  is("the old address is told it was replaced", mails.some((m) => m.to === "rex-old@example.org" && m.subject === "This is no longer the recovery address of a Marktmorgen account"), true);
  mails.length = 0;
  await recovery(rexKey, { action: "remove" });
  is("and when it is taken away, the address it had is told", mails.some((m) => m.to === "rex-new@example.org" && m.subject === "This is no longer the recovery address of a Marktmorgen account"), true);

  part("A move refused halfway leaves everything where it was");
  const MOV = "mov-from@example.com";
  await claimHandle(MOV, "mov-from", "Mov From", "");
  const movP = makePasskey(MOV, "cred-mov-1");
  await movP.keep();
  const movKey = await signInWithPasskey(movP);
  const DEST = "mov-dest@example.com";
  const destList = `nl:pk:${hex(`nimbus-passkeys:${DEST}`).slice(0, 40)}`;
  let reads = 0;
  const movePipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // A passkey lands on the new address between the route's check and the passkeys' own.
    if (commands.some((c) => c[0] === "GET" && c[1] === destList) && ++reads === 2) {
      await movePipe([["SET", destList, JSON.stringify([{ id: "cred-late", publicKey: "pk", counter: 0, transports: [], name: "Late", createdAt: "", lastUsedAt: "", synced: false }])]]);
    }
    return movePipe(commands);
  }) as typeof redis.pipeline;
  mails.length = 0;
  await sendMoveLink(MOV, DEST, ORIGIN, movKey);
  const movToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === DEST)?.text ?? "")?.[1] ?? "";
  const movAnswer = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: movToken }))).headers.get("location");
  redis.pipeline = movePipe;
  is("refused", movAnswer, `${ORIGIN}/signin?status=move-has-login`);
  is("the store and the passkey stay with the old address, and its sessions are logged out", [Boolean(await storeForEmail(MOV)), Boolean(await storeForEmail(DEST)), (await listPasskeys(MOV)).map((p) => p.id), await emailForSession(movKey)], [true, false, ["cred-mov-1"], null]);

  part("Asking to move does not tell which addresses have passkeys");
  const PROBE = "probe-target@example.com";
  await makePasskey(PROBE, "cred-probe").keep();
  const staleSession = await openSession(MOV, "passkey", "cred-mov-1");
  await redis.pipeline([["DEL", `nl:auth:fresh:${hex(`nimbus-auth-fresh:${staleSession}`).slice(0, 40)}`]]);
  const probe = await addressRoute(form(`${ORIGIN}/api/store/address`, { email: PROBE }, `nl_session=${staleSession}`));
  is("a session that is not fresh is told to log in again, not that the address has passkeys", (probe.headers.get("location") ?? "").split("address=")[1], "reauth");

  part("A fenced write never falls back when its script cannot run");
  const FEN = "fen-strict@example.com";
  const fenP = makePasskey(FEN, "cred-fen-p");
  const fenQ = makePasskey(FEN, "cred-fen-q");
  await fenP.keep();
  await fenQ.keep();
  const fenSession = await signInWithPasskey(fenQ);
  const strictPipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:fenced-"))) throw new Error("EVAL unavailable");
    return strictPipe(commands);
  }) as typeof redis.pipeline;
  const strict = await removePasskey(FEN, "cred-fen-p", fenSession).catch(() => "refused");
  redis.pipeline = strictPipe;
  is("nothing is written: both passkeys stay", [strict, (await listPasskeys(FEN)).map((p) => p.id).sort()], ["refused", ["cred-fen-p", "cred-fen-q"]]);

  part("No gap while a move runs (review of 8b4ddf6ee)");
  const WVIC = "wvic-from@example.com";
  const WDEST = "wvic-dest@example.com";
  await claimHandle(WVIC, "wvic-from", "Wvic", "");
  await makePasskey(WVIC, "cred-wvic").keep();
  const wOwner = await openSession(WVIC, "passkey", "cred-wvic");
  const wAttacker = await linkSession(WVIC);
  mails.length = 0;
  await sendMoveLink(WVIC, WDEST, ORIGIN, wOwner);
  const wToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === WDEST)?.text ?? "")?.[1] ?? "";
  const wPipe = redis.pipeline.bind(redis);
  let wInside: unknown = null;
  let wFired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const c = commands[0];
    // The store's own lock, taken by the move of the store itself: the ways in have already left.
    if (!wFired && c && c[0] === "SET" && c.includes("NX") && c.includes(15)) {
      wFired = true;
      redis.pipeline = wPipe;
      const opts = await passkeyRoute(asJson(`${ORIGIN}/api/auth/passkey`, { action: "options" }, `nl_session=${wAttacker}`));
      wInside = [await hasSecondStep(WVIC), await mayAddSecondStep(WVIC, wAttacker), await mayAddNow(WVIC, wAttacker), opts.status];
      // Stands in for anything that slipped in all the same.
      await makePasskey(WVIC, "cred-evil").keep();
      throw new Error("store lock busy (made up)");
    }
    return wPipe(commands);
  }) as typeof redis.pipeline;
  const wAnswer = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: wToken }))).headers.get("location");
  redis.pipeline = wPipe;
  is("in the gap the old address counts as having a second step: no add, options refused", wInside, [true, false, false, 403]);
  is("the move fails", wAnswer, `${ORIGIN}/signin?status=move-error`);
  is("undone: the store and only the owner's passkey are back, nothing left at the new address", [Boolean(await storeForEmail(WVIC)), (await listPasskeys(WVIC)).map((p) => p.id), (await listPasskeys(WDEST)).length], [true, ["cred-wvic"], 0]);
  is("and every session of the old address is logged out", [await emailForSession(wAttacker), await emailForSession(wOwner)], [null, null]);
  is("the move's marks are gone", [await mayAddSecondStep(WDEST, await openSession(WDEST))], [true]);

  part("Adding is asked again under the lock, just before the write");
  const NOV = "nov-add@example.com";
  const novLink = await linkSession(NOV);
  const novOptions = await passkeys(novLink, { action: "options" }) as { ok: boolean; options?: { challenge: string } };
  is("an account with no second step gets the options", novOptions.ok, true);
  const novKey = makePasskey(NOV, "cred-nov-new");
  const novPipe = redis.pipeline.bind(redis);
  let novRaced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The instant the add takes the account's lock, after the route's own check passed: a passkey lands first.
    if (!novRaced && commands.some((c) => c[0] === "SET" && c[1] === lockOf(NOV) && c.includes("NX"))) {
      novRaced = true;
      await makePasskey(NOV, "cred-nov-first").keep();
    }
    return novPipe(commands);
  }) as typeof redis.pipeline;
  const novAdd = await passkeys(novLink, { action: "add", response: novKey.register(novOptions.options!.challenge), name: "New" });
  redis.pipeline = novPipe;
  is("a passkey that landed between the route's check and the lock: the link's add is refused under the lock", [novRaced, novAdd.error, (await listPasskeys(NOV)).map((p) => p.id)], [true, "second_step", ["cred-nov-first"]]);
  await redis.pipeline([["DEL", `nl:pk:${hex(`nimbus-passkeys:${NOV}`).slice(0, 40)}`]]);

  part("Two moves of one address at once: the second is refused, and only a move's own mark is taken away");
  const MA = "ma-one@example.com";
  const firstMark = await markMoving(MA, "ma-two@example.com");
  is("the first move marks both", [typeof firstMark, await isMoving(MA)], ["string", true]);
  is("a second move of the same address is refused, and its other address is left unmarked", [await markMoving(MA, "ma-three@example.com"), await isMoving("ma-three@example.com")], [null, false]);
  await endMoving(MA, "ma-three@example.com", "not-this-moves-token");
  is("another move's token takes nothing away", await isMoving(MA), true);
  await endMoving(MA, "ma-two@example.com", firstMark!);
  is("its own token does", [await isMoving(MA), await isMoving("ma-two@example.com")], [false, false]);
  const novOptions2 = await passkeys(novLink, { action: "options" }) as { ok: boolean; options?: { challenge: string } };
  is("with nothing in the way, the same answer adds it", (await passkeys(novLink, { action: "add", response: makePasskey(NOV, "cred-nov-2").register(novOptions2.options?.challenge ?? ""), name: "New" })).ok, true);
  const SET = "set-app@example.com";
  const started = await startSetup(SET, "e".repeat(64), "set-backup@example.org");
  if (typeof started === "string") throw new Error(started);
  const setSent = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === "set-backup@example.org")?.text ?? "")?.[1] ?? "";
  const setStep = codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
  is("turning the app on asks again under its lock", [await finishSetup(SET, "e".repeat(64), setStep, setSent, Date.now(), async () => false), (await twoStepStatus(SET)).on], ["second_step", false]);

  part("A failed step after the store moved never undoes the move");
  const TMV = "tmv-from@example.com";
  const TDST = "tmv-dest@example.com";
  await claimHandle(TMV, "tmv-from", "Tmv", "");
  await makePasskey(TMV, "cred-tmv").keep();
  const tOwner = await openSession(TMV, "passkey", "cred-tmv");
  mails.length = 0;
  await sendMoveLink(TMV, TDST, ORIGIN, tOwner);
  const tToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === TDST)?.text ?? "")?.[1] ?? "";
  const tOwnerKey = `nl:store:owner:${hex(`nimbus-store:${TDST}`).slice(0, 40)}`;
  const tPipe = redis.pipeline.bind(redis);
  let tBroke = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // Opening the new session fails after the store moved, and the first read of where it landed fails too.
    if (tBroke === 0 && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:auth:session:"))) { tBroke = 1; throw new Error("down for a moment"); }
    if (tBroke === 1 && commands.some((c) => c[0] === "GET" && c[1] === tOwnerKey)) { tBroke = 2; throw new Error("down for a moment"); }
    return tPipe(commands);
  }) as typeof redis.pipeline;
  const tAnswer = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: tToken }))).headers.get("location");
  redis.pipeline = tPipe;
  is("it says the move did not finish", tAnswer, `${ORIGIN}/signin?status=move-error`);
  is("but the store and the passkey stay together at the new address: nothing is split", [Boolean(await storeForEmail(TDST)), (await listPasskeys(TDST)).map((p) => p.id), (await listPasskeys(TMV)).length], [true, ["cred-tmv"], 0]);

  part("Locks lost midway leave nothing on two addresses");
  const LMA = "lma-from@example.com";
  const LMB = "lma-dest@example.com";
  await makePasskey(LMA, "cred-lma-1").keep();
  await makePasskey(LMA, "cred-lma-2").keep();
  const lmaLockB = `nl:pk:lock:${hex(`nimbus-passkey-lock:${LMB}`).slice(0, 40)}`;
  const credOf = (id: string) => `nl:pk:cred:${hex(`nimbus-passkey-id:${id}`).slice(0, 40)}`;
  const lPipe = redis.pipeline.bind(redis);
  let lSeen = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && c.includes(credOf("cred-lma-1"))) && ++lSeen === 1) {
      const out = await lPipe(commands);
      await lPipe([["DEL", lmaLockB]]);
      return out;
    }
    return lPipe(commands);
  }) as typeof redis.pipeline;
  const lMoved = await movePasskeys(LMA, LMB).then(() => "moved", () => "refused");
  redis.pipeline = lPipe;
  is("the lock of the new address runs out midway: refused", lMoved, "refused");
  is("everything is back where it was", [(await listPasskeys(LMA)).length, (await listPasskeys(LMB)).length, (await redis.pipeline([["GET", credOf("cred-lma-1")]]))[0]], [2, 0, LMA]);
  const TSA = "tsa-from@example.com";
  const TSB = "tsa-dest@example.com";
  await turnOnApp(TSA, "tsa-backup@example.org");
  const tsaRecord = `nl:2fa:${hex(`nimbus-2fa:${TSA}`).slice(0, 40)}`;
  const tsaLock = `nl:2fa:lock:${hex(`nimbus-2fa-lock:${TSA}`).slice(0, 40)}`;
  const sPipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:fenced-del:") && c.includes(tsaRecord))) await sPipe([["DEL", tsaLock]]);
    return sPipe(commands);
  }) as typeof redis.pipeline;
  const sMoved = await moveTwoStep(TSA, TSB).then(() => "moved", () => "refused");
  redis.pipeline = sPipe;
  is("two-step login whose old record could not be taken away: refused, and the copy is gone", [sMoved, (await twoStepStatus(TSA)).on, (await twoStepStatus(TSB)).on], ["refused", true, false]);

  part("A passkey already off the list still has its sessions closed when its day comes");
  const OFF = "off-list@example.com";
  const offKey = makePasskey(OFF, "cred-off");
  await offKey.keep();
  const offSession = await signInWithPasskey(offKey);
  await redis.pipeline([
    ["SET", `nl:pk:drop:${hex(`nimbus-passkey-drop:${OFF}`).slice(0, 40)}`, JSON.stringify({ atOf: { "cred-off": Date.now() - 1_000 }, told: 0 })],
    ["DEL", `nl:pk:${hex(`nimbus-passkeys:${OFF}`).slice(0, 40)}`],
  ]);
  await pendingRemoval(OFF);
  is("its session is logged out", await emailForSession(offSession), null);

  part("Asking to move to many addresses is limited per account");
  const ASK = "ask-many@example.com";
  await claimHandle(ASK, "ask-many", "Ask", "");
  const askKey = makePasskey(ASK, "cred-ask");
  await askKey.keep();
  const askSession = await signInWithPasskey(askKey);
  const answers: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await addressRoute(form(`${ORIGIN}/api/store/address`, { email: `target-${i}@example.com` }, `nl_session=${askSession}`));
    answers.push((r.headers.get("location") ?? "").split("address=")[1]);
  }
  is("five an hour, then limited", answers, ["sent", "sent", "sent", "sent", "sent", "limited"]);

  part("A move that can be neither finished nor undone stays marked until it is repaired (review of 1daa9131e)");
  const BRK = "brk-from@example.com";
  const BRD = "brk-dest@example.com";
  await claimHandle(BRK, "brk-from", "Brk", "");
  await makePasskey(BRK, "cred-brk").keep();
  const brkOwner = await openSession(BRK, "passkey", "cred-brk");
  mails.length = 0;
  await sendMoveLink(BRK, BRD, ORIGIN, brkOwner);
  const brkToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === BRD)?.text ?? "")?.[1] ?? "";
  const brkList = `nl:pk:${hex(`nimbus-passkeys:${BRK}`).slice(0, 40)}`;
  const bPipe = redis.pipeline.bind(redis);
  let bStoreFail = true;
  let bBackFail = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const c = commands[0];
    if (bStoreFail && c && c[0] === "SET" && c.includes("NX") && c.includes(15)) { bStoreFail = false; bBackFail = true; throw new Error("store lock busy (made up)"); }
    // From then on, putting the passkeys back on the old address fails too.
    if (bBackFail && commands.some((x) => x[0] === "EVAL" && x.includes(brkList))) throw new Error("down for a while");
    return bPipe(commands);
  }) as typeof redis.pipeline;
  const brkAnswer = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: brkToken }))).headers.get("location");
  is("the move fails, and so does putting the passkeys back", brkAnswer, `${ORIGIN}/signin?status=move-error`);
  is("both addresses stay marked after the move returns", [await isMoving(BRK), await isMoving(BRD)], [true, true]);
  is("so nothing is added to the old address, even with the passkey away", await mayAddSecondStep(BRK, await openSession(BRK)), false);
  const tokenBrk = hex(String(Math.random()));
  await bPipe([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenBrk}`).slice(0, 40)}`, BRK, "EX", 900]]);
  is("a login with the emailed link is refused while it cannot be repaired", (await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenBrk }))).headers.get("location"), `${ORIGIN}/signin?status=move-busy`);
  const brdSession = await openSession(BRD);
  bBackFail = false;
  redis.pipeline = bPipe;
  const tokenBrk2 = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenBrk2}`).slice(0, 40)}`, BRK, "EX", 900]]);
  const brkLogin = await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenBrk2 }));
  is("the next login repairs it: the passkey is back with the store, and the login goes on", [brkLogin.headers.get("location")?.includes("/studio"), (await listPasskeys(BRK)).map((p) => p.id), (await listPasskeys(BRD)).length, await isMoving(BRK), await isMoving(BRD)], [true, ["cred-brk"], 0, false, false]);
  is("and the address the ways in came back from is logged out", await emailForSession(brdSession), null);

  const BOTH = "both-from@example.com";
  const BOTHD = "both-dest@example.com";
  await claimHandle(BOTH, "both-from", "Both", "");
  await makePasskey(BOTH, "cred-both").keep();
  const bothOwner = await openSession(BOTH, "passkey", "cred-both");
  mails.length = 0;
  await sendMoveLink(BOTH, BOTHD, ORIGIN, bothOwner);
  const bothToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === BOTHD)?.text ?? "")?.[1] ?? "";
  const bothOwnerKey = `nl:store:owner:${hex(`nimbus-store:${BOTH}`).slice(0, 40)}`;
  const oPipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The store is written at the new address, and taking it off the old one fails: it is on both.
    if (commands.some((x) => x[0] === "DEL" && x.includes(bothOwnerKey))) throw new Error("down for a moment");
    return oPipe(commands);
  }) as typeof redis.pipeline;
  const bothAnswer = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: bothToken }))).headers.get("location");
  redis.pipeline = oPipe;
  const bothStores = [Boolean(await storeForEmail(BOTH)), Boolean(await storeForEmail(BOTHD))];
  is("a store left on both addresses", bothStores.every(Boolean) ? bothAnswer : "not on both", `${ORIGIN}/signin?status=move-error`);
  const tokenBoth = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenBoth}`).slice(0, 40)}`, BOTH, "EX", 900]]);
  is("both are marked until the next login", [await isMoving(BOTH), await isMoving(BOTHD)], [true, true]);
  const bothLogin = await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenBoth }));
  is(
    "which settles it by where the store's handle points: the copy at the new address goes, the passkey comes back, the login goes on",
    [bothLogin.headers.get("location")?.includes("/studio"), Boolean(await storeForEmail(BOTH)), Boolean(await storeForEmail(BOTHD)), (await listPasskeys(BOTH)).map((p) => p.id), await isMoving(BOTH)],
    [true, true, false, ["cred-both"], false],
  );

  part("A broken move that cannot be told apart is left for a person, with a support script");
  const NONE1 = "none-a@example.com";
  const NONE2 = "none-b@example.com";
  await markBrokenMove(NONE1, NONE2);
  const tokenNone = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenNone}`).slice(0, 40)}`, NONE1, "EX", 900]]);
  is("with no store on either address, a login by the emailed link is refused", (await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenNone }))).headers.get("location"), `${ORIGIN}/signin?status=move-busy`);
  is("the support script shows the state", ((await describeMove(NONE1)) as { broken: unknown }).broken, { from: NONE1, to: NONE2 });
  is("and clears it only with the address typed again", [await clearBrokenMoveByHand(NONE1, "someone-else@example.com"), await clearBrokenMoveByHand(NONE1, NONE1), await isMoving(NONE1), await isMoving(NONE2)], [false, true, false, false]);
  is("the support script is there", existsSync("scripts/move-repair.mjs") && existsSync("scripts/move-repair-run.ts"), true);

  part("Undoing a move forgets two-step login the old address gained midway, and gives back the owner's");
  const APP = "app-from@example.com";
  const APD = "app-dest@example.com";
  await claimHandle(APP, "app-from", "App", "");
  await makePasskey(APP, "cred-app").keep();
  await turnOnApp(APP, "app-backup@example.org");
  const appOwner = await openSession(APP, "app");
  mails.length = 0;
  await sendMoveLink(APP, APD, ORIGIN, appOwner);
  const appToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === APD)?.text ?? "")?.[1] ?? "";
  const appRecord = `nl:2fa:${hex(`nimbus-2fa:${APP}`).slice(0, 40)}`;
  const aPipe = redis.pipeline.bind(redis);
  let aFired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const c = commands[0];
    if (!aFired && c && c[0] === "SET" && c.includes("NX") && c.includes(15)) {
      aFired = true;
      // Something wrote two-step login of its own on the old address in the gap.
      await aPipe([["SET", appRecord, JSON.stringify({ s: "x", since: 1, codes: ["planted"], last: -1, reset: 0, backup: "" })]]);
      throw new Error("store lock busy (made up)");
    }
    return aPipe(commands);
  }) as typeof redis.pipeline;
  await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: appToken }));
  redis.pipeline = aPipe;
  is("the planted record is gone, the owner's ten codes are back on the old address, nothing at the new one, nothing left broken", [(await twoStepStatus(APP)).codesLeft, (await twoStepStatus(APD)).on, await isMoving(APP)], [10, false, false]);

  part("While an address is in a move, the app's code still lets its owner in; nothing else does");
  const MAPP = "mapp-owner@example.com";
  const mappApp = await turnOnApp(MAPP, "mapp-backup@example.org");
  const mappMark = await markMoving(MAPP, "mapp-elsewhere@example.com");
  const tokenMapp = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenMapp}`).slice(0, 40)}`, MAPP, "EX", 900]]);
  const mappHeld = await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenMapp }));
  is("the emailed link waits for the app's code", mappHeld.headers.get("location"), `${ORIGIN}/signin/code`);
  const mappIn = cookieOf(await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: mappApp.codes[0] }, `nl_2fa=${cookieOf(mappHeld, "nl_2fa")}`)), "nl_session");
  is("and the code lets the owner in", [mappIn.length, await sessionSecondStep(mappIn, MAPP)], [64, "recovery"]);
  const MNO = "mno-owner@example.com";
  await keepRecoveryAddress(MNO, "mno-rec@example.org");
  const mnoMark = await markMoving(MNO, "mno-elsewhere@example.com");
  await sendLostEmailLink(MNO, "203.0.113.77", ORIGIN);
  const mnoToken = /token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === "mno-rec@example.org")?.text ?? "")?.[1] ?? "";
  is("the recovery address's link is refused for an address in a move", (await lostConfirm(form(`${ORIGIN}/api/auth/lost/confirm`, { token: mnoToken }))).headers.get("location"), `${ORIGIN}/signin?status=move-busy`);
  const rescueToken = "f".repeat(64);
  await redis.pipeline([["SET", `nl:2fa:rescue:${hex(`nimbus-2fa-rescue:${rescueToken}`).slice(0, 40)}`, MAPP, "EX", 900]]);
  is("the link that turns the app off does nothing for an address in a move", [await spendRescue(rescueToken), (await twoStepStatus(MAPP)).on], [null, true]);
  await endMoving(MAPP, "mapp-elsewhere@example.com", mappMark!);
  await endMoving(MNO, "mno-elsewhere@example.com", mnoMark!);

  part("The move's record is written before anything moves (a process that dies midway leaves it)");
  const RSD = "rsd-from@example.com";
  const RSDD = "rsd-dest@example.com";
  await claimHandle(RSD, "rsd-from", "Rsd", "");
  await makePasskey(RSD, "cred-rsd").keep();
  const rsdOwner = await openSession(RSD, "passkey", "cred-rsd");
  mails.length = 0;
  await sendMoveLink(RSD, RSDD, ORIGIN, rsdOwner);
  const rsdToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === RSDD)?.text ?? "")?.[1] ?? "";
  const rPipe = redis.pipeline.bind(redis);
  let rSeen: unknown = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const c = commands[0];
    if (rSeen === null && c && c[0] === "SET" && c.includes("NX") && c.includes(15)) {
      redis.pipeline = rPipe;
      // The ways in have left; the store has not. Were the process to die now, this is what would be left.
      rSeen = [await readBrokenMove(RSD), (await listPasskeys(RSD)).length];
    }
    return rPipe(commands);
  }) as typeof redis.pipeline;
  await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: rsdToken }));
  redis.pipeline = rPipe;
  is("in the gap, the record is already there", rSeen, [{ from: RSD, to: RSDD }, 0]);
  is("and cleared once the move is done", [await readBrokenMove(RSD), await readBrokenMove(RSDD), Boolean(await storeForEmail(RSDD))], [null, null, true]);

  part("When moving two-step login refuses and its copy could not be taken back, the undo takes it");
  const CPY = "cpy-from@example.com";
  const CPYD = "cpy-dest@example.com";
  await claimHandle(CPY, "cpy-from", "Cpy", "");
  await makePasskey(CPY, "cred-cpy").keep();
  await turnOnApp(CPY, "cpy-backup@example.org");
  const cpyOwner = await openSession(CPY, "app");
  mails.length = 0;
  await sendMoveLink(CPY, CPYD, ORIGIN, cpyOwner);
  const cpyToken = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === CPYD)?.text ?? "")?.[1] ?? "";
  const cpyFrom = `nl:2fa:${hex(`nimbus-2fa:${CPY}`).slice(0, 40)}`;
  const cpyTo = `nl:2fa:${hex(`nimbus-2fa:${CPYD}`).slice(0, 40)}`;
  const cPipe = redis.pipeline.bind(redis);
  let cFromFails = 1;
  let cToFails = 1;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const isDel = (key: string) => commands.some((x) => x[0] === "EVAL" && String(x[1]).startsWith("-- marktmorgen:fenced-del:") && x.includes(key));
    if (cFromFails > 0 && isDel(cpyFrom)) { cFromFails -= 1; return [0]; }
    if (cToFails > 0 && isDel(cpyTo)) { cToFails -= 1; return [0]; }
    return cPipe(commands);
  }) as typeof redis.pipeline;
  const cpyAnswer = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token: cpyToken }))).headers.get("location");
  redis.pipeline = cPipe;
  is("refused, the app stays on the old address, and its copy at the new one is gone", [cpyAnswer, (await twoStepStatus(CPY)).on, (await twoStepStatus(CPYD)).on], [`${ORIGIN}/signin?status=move-has-login`, true, false]);

  part("A passkey removed, or the app turned off, just as a login opens its session");
  const UMA = "uma-race@example.com";
  const uma = makePasskey(UMA, "cred-uma-1");
  await uma.keep();
  const original = redis.pipeline.bind(redis);
  let strike: ((commands: (string | number)[][]) => Promise<void>) | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (strike && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:auth:session:"))) {
      const now = strike;
      strike = null;
      await now(commands);
    }
    return original(commands);
  }) as typeof redis.pipeline;
  strike = async () => { await original([["DEL", `nl:pk:${hex(`nimbus-passkeys:${UMA}`).slice(0, 40)}`]]); };
  is("a passkey removed as its session opens: no session", await signInWithPasskey(uma), "");
  is("none left behind", (await original([["SMEMBERS", `nl:auth:sessions:${hex(`nimbus-auth-sessions:${UMA}`).slice(0, 40)}`]]))[0], []);
  const VAL = "val-race@example.com";
  const valApp = await turnOnApp(VAL, "val-backup@example.org");
  const tokenVal = hex(String(Math.random()));
  await original([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${tokenVal}`).slice(0, 40)}`, VAL, "EX", 900]]);
  const heldVal = await callback(form(`${ORIGIN}/api/auth/callback`, { token: tokenVal }));
  strike = async () => { await original([["DEL", `nl:2fa:${hex(`nimbus-2fa:${VAL}`).slice(0, 40)}`]]); };
  const valIn = await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: valApp.codes[0] }, `nl_2fa=${cookieOf(heldVal, "nl_2fa")}`));
  redis.pipeline = original;
  is("the app turned off as its code's session opens: back to log in", valIn.headers.get("location"), `${ORIGIN}/signin?status=expired`);
  is("and the session is closed", await emailForSession(cookieOf(valIn, "nl_session")), null);

  part("A lock held too long is said as busy, never a bare error");
  const WES = "wes-busy@example.com";
  const wes = makePasskey(WES, "cred-wes-1");
  await wes.keep();
  const wesLink = await linkSession(WES);
  await passkeys(wesLink, { action: "remove", id: "cred-wes-1" });
  const wes2 = makePasskey(WES, "cred-wes-2");
  await wes2.keep();
  const wesApp = await signInWithPasskey(wes2);
  const blocking = await takeLock(lockOf(WES), 30, 1_000);
  is("keeping it while the lock is held elsewhere", await passkeys(wesApp, { action: "keep", id: "cred-wes-1" }), { status: 503, ok: false, error: "busy" });
  const optionsBusy = await passkeySignIn(asJson(`${ORIGIN}/api/auth/passkey/signin`, { action: "options" }, ""));
  const nonceBusy = cookieOf(optionsBusy, PASSKEY_COOKIE);
  const { options: askedBusy } = (await optionsBusy.json()) as { options: { challenge: string } };
  const busyIn = await passkeySignIn(asJson(`${ORIGIN}/api/auth/passkey/signin`, { action: "verify", response: wes.answer(askedBusy.challenge) }, `${PASSKEY_COOKIE}=${nonceBusy}`));
  is("logging in with the passkey meanwhile", [busyIn.status, ((await busyIn.json()) as { error?: string }).error], [503, "busy"]);
  await releaseLock(blocking);

  done();
}

void main();
