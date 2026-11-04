/**
 * Two-step login (lib/totp.ts, lib/two-step.ts; added 13 October 2026).
 * Checked:
 *
 *   - the codes are RFC 6238's own, for its own test secret;
 *   - a code is taken a step either side of now, and never twice;
 *   - turning it on needs a right code from the app, and answers ten recovery
 *     codes once;
 *   - with it on, the emailed link opens no session: it leads to the code
 *     page, behind a cookie, and a right code opens the session;
 *   - five wrong codes end the waiting login;
 *   - a recovery code works once;
 *   - turning it off needs a right code; without it, the link opens the
 *     session as it always did;
 *   - moving the sign-in address carries it;
 *   - nobody is locked out: with nothing left, it turns off a week after it is
 *     asked for, and a login with a code, or Cancel, calls that off.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { base32Decode, base32Encode, codeAt, stepOf, STEP_SECONDS } from "@/lib/totp";
import { emailForSession } from "@/lib/auth";
import { studioAccess } from "@/lib/studio-route";
import { RESET_DAYS, cancelReset, finishSetup, hideAddress, lockedUntil, moveTwoStep, resetIfDue, startSetup, turnOff, twoStepOn, twoStepStatus } from "@/lib/two-step";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_two_step_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
/** The six digits in the last email to an address. */
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

const EMAIL = "maker@example.com";
const SESSION = "a".repeat(64);
const nowCode = (secret: string, at = Date.now()) => codeAt(base32Decode(secret)!, Math.floor(at / 1000 / STEP_SECONDS));

async function linkFor(email: string): Promise<string> {
  const token = createHash("sha256").update(String(Math.random())).digest("hex");
  const key = `nl:auth:link:${createHash("sha256").update(`nimbus-auth-link:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", key, email, "EX", 900]]);
  return token;
}

const post = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();

  part("The codes");
  const rfc = Buffer.from("12345678901234567890");
  is("RFC 6238's own values, for its own secret", [codeAt(rfc, Math.floor(59 / 30), 8), codeAt(rfc, Math.floor(1111111109 / 30), 8), codeAt(rfc, Math.floor(2000000000 / 30), 8)], ["94287082", "07081804", "69279037"]);
  is("base32 there and back", base32Decode(base32Encode(rfc))?.toString(), "12345678901234567890");
  const secret = base32Encode(rfc);
  const at = 1_760_000_000_000;
  const step = Math.floor(at / 1000 / 30);
  is("now, and a step either side", [stepOf(secret, codeAt(rfc, step), at), stepOf(secret, codeAt(rfc, step - 1), at), stepOf(secret, codeAt(rfc, step + 1), at)], [step, step - 1, step + 1]);
  is("not two steps away", stepOf(secret, codeAt(rfc, step - 2), at), null);
  is("never a step already used", stepOf(secret, codeAt(rfc, step), at, step), null);

  part("Turning it on");
  is("the recovery address has to be another inbox", [await startSetup(EMAIL, SESSION, "Maker@Example.com"), await startSetup(EMAIL, SESSION, "not an address")], ["same", "backup"]);
  const started = await startSetup(EMAIL, SESSION, "backup@example.org");
  if (typeof started === "string") throw new Error(started);
  const backupCode = codeTo("backup@example.org");
  is("a code is emailed to the recovery address", backupCode.length, 6);
  is("the app reads a secret and an address", [started.uri.startsWith("otpauth://totp/Marktmorgen%3Amaker%40example.com?secret="), started.secret.length], [true, 32]);
  is("a wrong code does not turn it on", [await finishSetup(EMAIL, SESSION, "000000" === nowCode(started.secret) ? "111111" : "000000", backupCode), await twoStepOn(EMAIL)], ["wrong", false]);
  is("another session cannot finish it", await finishSetup(EMAIL, "b".repeat(64), nowCode(started.secret), backupCode), "expired");
  is("not without the recovery address's code", await finishSetup(EMAIL, SESSION, nowCode(started.secret), backupCode === "000000" ? "111111" : "000000"), "backup-wrong");
  const finished = await finishSetup(EMAIL, SESSION, nowCode(started.secret), backupCode);
  if (typeof finished === "string") throw new Error(finished);
  is("on, with ten recovery codes shown once", [await twoStepOn(EMAIL), finished.codes.length, new Set(finished.codes).size], [true, 10, 10]);

  part("Logging in");
  const held = await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(EMAIL) }));
  const waiting = cookieOf(held, "nl_2fa");
  is("the link opens no session: it leads to the code page", [held.headers.get("location"), cookieOf(held, "nl_session"), waiting.length], ["https://marktmorgen.com/signin/code", "", 64]);
  const wrong = await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: "12345" }, `nl_2fa=${waiting}`));
  is("a wrong code: back to the page, saying so", wrong.headers.get("location"), "https://marktmorgen.com/signin/code?status=wrong");
  // The code just used to turn it on cannot be used again; the next step's can.
  const next = codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / 30) + 1);
  const right = await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: next }, `nl_2fa=${waiting}`));
  is("a right code opens the session", [right.headers.get("location"), cookieOf(right, "nl_session").length], ["https://marktmorgen.com/studio", 64]);
  const again = await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: next }, `nl_2fa=${waiting}`));
  is("and the waiting login is spent", again.headers.get("location"), "https://marktmorgen.com/signin?status=expired");

  const second = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(EMAIL) })), "nl_2fa");
  for (let i = 0; i < 5; i += 1) await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: "99999x" }, `nl_2fa=${second}`));
  const sixth = await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: finished.codes[0] }, `nl_2fa=${second}`));
  is("after five wrong codes, the waiting login is over, even for a right one", sixth.headers.get("location"), "https://marktmorgen.com/signin?status=expired");

  redis.clear();
  // A fresh hour of tries, and the account set up again for the rest.
  const again2 = await startSetup(EMAIL, SESSION, "backup@example.org");
  if (typeof again2 === "string") throw new Error(again2);
  const set2 = await finishSetup(EMAIL, SESSION, nowCode(again2.secret), codeTo("backup@example.org"));
  if (typeof set2 === "string") throw new Error(set2);
  const third = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(EMAIL) })), "nl_2fa");
  const byRecovery = await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: set2.codes[3].toUpperCase() }, `nl_2fa=${third}`));
  is("a recovery code logs in, written in capitals or not", byRecovery.headers.get("location"), "https://marktmorgen.com/studio");
  is("and is spent", (await twoStepStatus(EMAIL)).codesLeft, 9);
  const fourth = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(EMAIL) })), "nl_2fa");
  const reused = await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: set2.codes[3] }, `nl_2fa=${fourth}`));
  is("the same recovery code does not work twice", reused.headers.get("location"), "https://marktmorgen.com/signin/code?status=wrong");

  part("Moving the address, and turning it off");
  await moveTwoStep(EMAIL, "new@example.com");
  is("it goes with the address", [await twoStepOn(EMAIL), await twoStepOn("new@example.com"), (await twoStepStatus("new@example.com")).codesLeft], [false, true, 9]);
  is("a wrong code does not turn it off", await turnOff("new@example.com", "nope-nope"), "wrong");
  is("a recovery code does", [await turnOff("new@example.com", set2.codes[5]), await twoStepOn("new@example.com")], ["recovery", false]);
  const plain = await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor("new@example.com") }));
  is("without it, the link opens the session as it always did", [plain.headers.get("location"), cookieOf(plain, "nl_session").length], ["https://marktmorgen.com/studio", 64]);

  part("Lost the phone and the codes: back in at once through the recovery address");
  const RESCUED = "rescued@example.com";
  const rStart = await startSetup(RESCUED, SESSION, "second@example.org");
  if (typeof rStart === "string") throw new Error(rStart);
  if (typeof (await finishSetup(RESCUED, SESSION, nowCode(rStart.secret), codeTo("second@example.org"))) === "string") throw new Error("not set");
  is("the recovery address is shown without giving it away", (await twoStepStatus(RESCUED)).backup, hideAddress("second@example.org"));
  const rHold = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(RESCUED) })), "nl_2fa");
  const rSent = await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "rescue" }, `nl_2fa=${rHold}`));
  const rescueLink = /signin\/rescue\?token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === "second@example.org")?.text ?? "")?.[1] ?? "";
  is("a link goes to the recovery address, not the sign-in one", [rSent.headers.get("location"), rescueLink.length], ["https://marktmorgen.com/signin/code?status=rescue-sent", 64]);
  const { POST: rescueRoute } = await import("@/app/api/auth/rescue/route");
  const rescued = await rescueRoute(post("https://marktmorgen.com/api/auth/rescue", { token: rescueLink }));
  is("opening it logs in at once, and two-step login is off", [rescued.headers.get("location"), cookieOf(rescued, "nl_session").length, await twoStepOn(RESCUED)], ["https://marktmorgen.com/studio#two-step", 64, false]);
  is("and it works once", (await rescueRoute(post("https://marktmorgen.com/api/auth/rescue", { token: rescueLink }))).headers.get("location"), "https://marktmorgen.com/signin?status=expired");
  is("the sign-in address is told", mails.some((m) => m.to === RESCUED && m.text.includes("recovery address, and your account was logged in")), true);

  part("Lost the recovery inbox too: in at once, with what matters locked");
  const LOST = "lost@example.com";
  const set3Start = await startSetup(LOST, SESSION, "lost.backup@example.org");
  if (typeof set3Start === "string") throw new Error(set3Start);
  const set3 = await finishSetup(LOST, SESSION, nowCode(set3Start.secret), codeTo("lost.backup@example.org"));
  if (typeof set3 === "string") throw new Error(set3);
  const lostHold = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(LOST) })), "nl_2fa");
  const entered = await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${lostHold}`));
  const lockedSession = cookieOf(entered, "nl_session");
  const until = (await twoStepStatus(LOST)).reset;
  is("in at once, from the code page", [entered.headers.get("location"), lockedSession.length, await emailForSession(lockedSession)], ["https://marktmorgen.com/studio", 64, LOST]);
  is("with what matters locked for a week", [Math.round(((await lockedUntil(lockedSession)) - Date.now()) / 86_400_000), (await lockedUntil(lockedSession)) === until], [RESET_DAYS, true]);
  const asStudio = (need: string, session: string) =>
    studioAccess(new NextRequest("https://marktmorgen.com/api/store/x", { method: "POST", headers: { cookie: `nl_session=${session}` } }), need as never);
  const lockedAnswers = await Promise.all(["payments", "billing", "team", "delete", "export", "settings", "send", "import", "erase"].map(async (need) => (await asStudio(need, lockedSession)).ok === false && ((await asStudio(need, lockedSession)) as { reason: string }).reason));
  is("payments, the plan, the team, deleting, exports, settings, sending, imports and erasing a person wait", lockedAnswers, new Array(9).fill("locked"));
  const openAnswers = await Promise.all(["products", "page", "orders", "stats", "draft", "reviews"].map(async (need) => { const a = await asStudio(need, lockedSession); return a.ok ? "open" : (a as { reason: string }).reason; }));
  is("products, pages, orders, numbers, drafts and reviews do not", openAnswers.every((a) => a !== "locked"), true);
  // C2-76 (4 November 2026): what cannot be undone waits too, under a permission the session otherwise keeps.
  const reasonOf = async (need: string, action: string) => {
    const a = await studioAccess(new NextRequest("https://marktmorgen.com/api/store/x", { method: "POST", headers: { cookie: `nl_session=${lockedSession}` } }), need as never, action);
    return a.ok ? "open" : (a as { reason: string }).reason;
  };
  is("deleting a person and everything kept about them waits", await reasonOf("erase", "erase"), "locked");
  is("removing a product waits; adding and editing one do not", [await reasonOf("products", "remove"), await reasonOf("products", "edit") !== "locked", await reasonOf("products", "add") !== "locked"], ["locked", true, true]);
  const { POST: personRoute } = await import("@/app/api/store/person/route");
  const erased = await personRoute(new NextRequest("https://marktmorgen.com/api/store/person", { method: "POST", headers: { "content-type": "application/json", cookie: `nl_session=${lockedSession}` }, body: JSON.stringify({ action: "erase", token: "x".repeat(40), confirm: "DELETE" }) }));
  is("the erase route itself refuses it, before anything is read or deleted", ((await erased.json()) as { error?: string }).error, "locked");
  const { POST: passkeyRoute } = await import("@/app/api/auth/passkey/route");
  const removedKey = await passkeyRoute(new NextRequest("https://marktmorgen.com/api/auth/passkey", { method: "POST", headers: { "content-type": "application/json", cookie: `nl_session=${lockedSession}` }, body: JSON.stringify({ action: "remove", id: "a-passkey" }) }));
  is("and a passkey cannot be taken away from the owner either", [removedKey.status, ((await removedKey.json()) as { error?: string }).error], [403, "locked"]);
  const { POST: twoStepRoute } = await import("@/app/api/auth/two-step/route");
  const tried = await twoStepRoute(new NextRequest("https://marktmorgen.com/api/auth/two-step", { method: "POST", headers: { "content-type": "application/json", cookie: `nl_session=${lockedSession}` }, body: JSON.stringify({ action: "cancel" }) }));
  is("two-step login cannot be changed from it", [tried.status, ((await tried.json()) as { error?: string }).error], [403, "locked"]);

  const secondHold = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(LOST) })), "nl_2fa");
  const secondSession = cookieOf(await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${secondHold}`)), "nl_session");
  is("getting in again does not move the day", [(await twoStepStatus(LOST)).reset, await lockedUntil(secondSession)], [until, until]);
  const early = await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(LOST) }));
  is("before the week is out, the link still asks for the code first", early.headers.get("location"), "https://marktmorgen.com/signin/code");
  is("a login with a recovery code calls it off", [(await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: set3.codes[0] }, `nl_2fa=${cookieOf(early, "nl_2fa")}`))).headers.get("location"), (await twoStepStatus(LOST)).reset], ["https://marktmorgen.com/studio", 0]);
  is("and logs out every browser let in without it", [await emailForSession(lockedSession), await emailForSession(secondSession)], [null, null]);

  const again3 = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(LOST) })), "nl_2fa");
  const thirdLocked = cookieOf(await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${again3}`)), "nl_session");
  is("Cancel in the studio does too", [await cancelReset(LOST, "studio"), (await twoStepStatus(LOST)).reset, await emailForSession(thirdLocked)], [true, 0, null]);

  const again4 = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(LOST) })), "nl_2fa");
  const fourthLocked = cookieOf(await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${again4}`)), "nl_session");
  is("not a day early", await resetIfDue(LOST, Date.now() + (RESET_DAYS - 1) * 86_400_000), false);
  is("after the week, it turns off, and nothing is locked", [await resetIfDue(LOST, Date.now() + (RESET_DAYS + 1) * 86_400_000), await twoStepOn(LOST), await lockedUntil(fourthLocked, Date.now() + (RESET_DAYS + 1) * 86_400_000)], [true, false, 0]);
  const back = await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(LOST) }));
  is("and the emailed link logs in on its own", [back.headers.get("location"), cookieOf(back, "nl_session").length], ["https://marktmorgen.com/studio", 64]);

  done();
}

void main();
