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
import { openSession } from "@/lib/auth";
import { PASSKEY_COOKIE, REMOVAL_DAYS, listPasskeys, pendingRemoval } from "@/lib/passkeys";
import { RESET_DAYS } from "@/lib/two-step";
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

  done();
}

void main();
