/**
 * A new way in needs the old one (lib/second-step-gate.ts, owner C3-81): on
 * an account that already has a passkey or an authenticator app, a session
 * opened only by the emailed link, however fresh, adds no passkey and turns
 * on no app; a session opened with the passkey or the app's code does. An
 * account with neither still adds its first from the link. A passkey removed
 * from a link session waits REMOVAL_DAYS with an email (the way back for a
 * lost passkey), and a login with a passkey or a code calls it off; once it
 * has gone, the link adds a new one. Synthetic records; no email leaves.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession, openSession, sessionSecondStep } from "@/lib/auth";
import { PASSKEY_COOKIE, REMOVAL_DAYS, listPasskeys, pendingRemoval } from "@/lib/passkeys";
import { RESET_DAYS, finishSetup, lockedUntil, resetIfDue, startSetup, twoStepStatus } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { releaseLock, takeLock } from "@/lib/redis-lock";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { hasSecondStep, mayAddSecondStep } from "@/lib/second-step-gate";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as passkeyRoute } from "@/app/api/auth/passkey/route";
import { POST as passkeySignIn } from "@/app/api/auth/passkey/signin/route";
import { POST as twoStepRoute } from "@/app/api/auth/two-step/route";
import { makePasskey } from "./passkey-world";
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
const asJson = (url: string, body: unknown, cookie: string) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
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
async function turnOnApp(email: string, backup: string): Promise<{ secret: Uint8Array; codes: string[] }> {
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
  await signInWithPasskey(kai);
  is("a login with the passkey calls it off", [await pendingRemoval(KAI), (await listPasskeys(KAI)).length], [null, 1]);
  is("and says so", mails.some((m) => m.to === KAI && m.subject === "Your passkeys stay on your Marktmorgen account"), true);
  await passkeys(byLink, { action: "remove", id: "cred-kai-1" });
  const after = Date.now() + (REMOVAL_DAYS * 86_400_000) + 60_000;
  is("waiting its days, it goes", [await pendingRemoval(KAI, after), (await listPasskeys(KAI)).length, await hasSecondStep(KAI, after)], [null, 0, false]);
  const back = await linkSession(KAI);
  is("then the link adds a new one", (await passkeys(back, { action: "options" })).ok, true);

  part("From a session with the step, removing is at once");
  const kai2 = makePasskey(KAI, "cred-kai-2");
  await kai2.keep();
  const withKey = await signInWithPasskey(kai2);
  is("removed now", [(await passkeys(withKey, { action: "remove", id: "cred-kai-2" })).removeOn, (await listPasskeys(KAI)).length], [undefined, 0]);
  is("the session that removed it stays, without its mark", [await emailForSession(withKey), await sessionSecondStep(withKey, KAI)], [KAI, null]);

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

  done();
}

void main();
