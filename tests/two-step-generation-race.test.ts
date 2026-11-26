/**
 * Issue #4179 (Codex G, MEDIUM; security): logging in with the authenticator app (app/api/auth/code) checks the code
 * (lib/two-step.ts finishSignIn), then opens the session, then asks only whether two-step login is still on
 * (twoStepOn). When the owner replaced the app in between (startSetup and finishSetup, whose clean-up runs before the
 * session exists), the session opened on the OLD app's code was handed out as a second step of the NEW one. Now
 * finishSignIn answers the generation of the record the code was checked against (a print of its sealed secret), and
 * the route keeps the session only while the record is still that generation: replaced or turned off in between, the
 * session is closed and the person logs in again with the new app.
 *
 * Synthetic only: the in-memory Redis and a stand-in email provider.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession } from "@/lib/auth";
import { finishSetup, startSetup, turnOff } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "stub";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const form = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";

async function turnOnApp(email: string, backup: string): Promise<{ secret: Buffer; codes: string[] }> {
  const setup = await startSetup(email, "d".repeat(64), backup);
  if (typeof setup === "string") throw new Error(setup);
  const sent = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === backup)?.text ?? "")?.[1] ?? "";
  const secret = base32Decode(setup.secret)!;
  const finished = await finishSetup(email, "d".repeat(64), codeAt(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)), sent);
  if (typeof finished === "string") throw new Error(finished);
  return { secret, codes: finished.codes };
}

/** A waiting login (the emailed link), its nl_2fa cookie. */
async function waiting(email: string): Promise<string> {
  const token = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  return cookieOf(await callback(form(`${ORIGIN}/api/auth/callback`, { token })), "nl_2fa");
}

const original = redis.pipeline.bind(redis);
/** Run once, right before the route writes the new session's key: the app replaced in between. */
let between: (() => Promise<void>) | null = null;
/** What the replacement in between did. */
let replaced = "not run";
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (between && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:auth:session:"))) {
    const run = between;
    between = null;
    // The code is checked and spent; the app is replaced now, before the session exists (its clean-up finds nothing).
    await run().catch((error: unknown) => {
      replaced = `failed: ${String(error)}`;
    });
    return original(commands);
  }
  return original(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();

  part("Control: the app's code, nothing replaced: logged in");
  const ADA = "ada-two-step@example.com";
  const adaSecret = (await turnOnApp(ADA, "ada-backup@example.org")).secret;
  const adaIn = await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: codeAt(adaSecret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1) }, `nl_2fa=${await waiting(ADA)}`));
  const adaSession = cookieOf(adaIn, "nl_session");
  is("sent to the studio", adaIn.headers.get("location")?.endsWith("/studio"), true);
  is("the session is open", await emailForSession(adaSession), ADA);

  part("The old app's code checked, then the app replaced before the session is handed out");
  const BEA = "bea-two-step@example.com";
  const old = await turnOnApp(BEA, "bea-backup@example.org");
  const oldSecret = old.secret;
  const held = await waiting(BEA);
  between = async () => {
    // The owner turns the old app off (a recovery code of it) and sets up a new one.
    const off = await turnOff(BEA, old.codes[0]);
    if (off !== "recovery") throw new Error(`not turned off: ${off}`);
    await turnOnApp(BEA, "bea-backup@example.org");
    replaced = "done";
  };
  const raced = await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: codeAt(oldSecret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1) }, `nl_2fa=${held}`));
  is("the app was replaced in between", replaced, "done");
  const racedSession = cookieOf(raced, "nl_session");
  is("not let in: sent to log in again", raced.headers.get("location")?.includes("/signin"), true);
  is("no session handed out", racedSession, "");
  const opened = redis.keys?.().filter((key) => key.startsWith("nl:auth:session:")) ?? [];
  const live: string[] = [];
  for (const key of opened) if ((await original([["GET", key]]))[0] === BEA) live.push(key);
  is("no session of the account is left open on the old app's code", live.length, 0);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
