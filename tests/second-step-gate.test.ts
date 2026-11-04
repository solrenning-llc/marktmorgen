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
import { PASSKEY_COOKIE, REMOVAL_DAYS, cancelRemoval, listPasskeys, movePasskeys, pendingRemoval, removePasskey, scheduleRemoval } from "@/lib/passkeys";
import { keepRecoveryAddress, sendLostEmailLink } from "@/lib/recovery-address";
import { POST as lostConfirm } from "@/app/api/auth/lost/confirm/route";
import { RESET_DAYS, checkCode, finishSetup, lockedUntil, resetIfDue, startSetup, twoStepStatus } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { releaseLock, takeLock } from "@/lib/redis-lock";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { hasSecondStep, liveSecondStep, mayAddSecondStep, mayKeepPasskey } from "@/lib/second-step-gate";
import { secondStepWay } from "@/lib/team";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as passkeyRoute } from "@/app/api/auth/passkey/route";
import { POST as passkeySignIn } from "@/app/api/auth/passkey/signin/route";
import { POST as twoStepRoute } from "@/app/api/auth/two-step/route";
import { makePasskey } from "./passkey-world";
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
  await redis.pipeline([["SET", dropKai, JSON.stringify({ ...JSON.parse(String(rawDrop)), at: Date.now() - 1_000 })]]);
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
  await redis.pipeline([["SET", dropBo, JSON.stringify({ ...JSON.parse(String(rawBo)), at: Date.now() - 1_000 })]]);
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
      tiaMail.includes("If this was you, there is nothing to do: it is removed on that day."),
    ],
    [true, true, true],
  );
  const UNA = "una-two@example.com";
  const unaP = makePasskey(UNA, "cred-una-p");
  const unaQ = makePasskey(UNA, "cred-una-q");
  await unaP.keep();
  await unaQ.keep();
  const atUna = await scheduleRemoval(UNA, "cred-una-p", "e".repeat(64), true, t0);
  const unaMail = [...mails].reverse().find((m) => m.to === UNA && m.subject === "A passkey is set to be removed from your Marktmorgen account")?.text ?? "";
  is(
    "with another passkey and the app: when, and what to do if it was not them; only Keep it stops it",
    [
      unaMail.includes(`It will be removed on ${removalWhen(atUna!)}.`),
      unaMail.includes(`If it was not you, stop it before ${removalWhen(atUna!)}:`),
      unaMail.includes("with another of your passkeys, or the emailed link and the code from your authenticator app."),
      unaMail.includes("press “Keep it” next to the passkey. Only “Keep it” stops the removal: logging in alone does not, and logging in with the passkey that is being removed cannot."),
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
  const realPipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" && c.includes("XX"))) await realPipe([["DEL", `nl:2fa:${hex(`nimbus-2fa:${XAN}`).slice(0, 40)}`]]);
    return realPipe(commands);
  }) as typeof redis.pipeline;
  const raced = await checkCode(XAN, xan.codes[1]);
  redis.pipeline = realPipe;
  is("a code checked as two-step login is turned off: refused, and the record stays gone", [raced, (await twoStepStatus(XAN)).on], ["wrong", false]);

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
