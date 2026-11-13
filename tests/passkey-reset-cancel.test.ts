/**
 * Issue #4355 (Codex G, g-2220): a passkey login while a request to turn two-step login off waits, and calling that
 * wait off is not confirmed (its write answers in no known shape). The login must not succeed: no session cookie is
 * issued and no session is left open, so the reset never turns two-step off behind a login that proved the passkey.
 * Synthetic records; no email leaves.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { PASSKEY_COOKIE } from "@/lib/passkeys";
import { RESET_DAYS, finishSetup, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { POST as passkeySignIn } from "@/app/api/auth/passkey/signin/route";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_second_step_gate_only";
const mails: { to: string; subject: string; text: string }[] = [];
/** Addresses the email provider answers 503 for, as if it were down. */
const mailDown = new Set<string>();
/** Addresses whose next email waits until `open` is called, then is refused (503) or sent, as `fail` says (C3-113). */
const mailHeld = new Map<string, { wait: Promise<void>; fail: boolean }>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    const held = mailHeld.get(Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""));
    if (held) {
      mailHeld.delete(Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""));
      await held.wait;
      if (held.fail) return new Response("{}", { status: 503 });
    }
    if (mailDown.has(Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""))) return new Response("{}", { status: 503 });
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");

// Each test browser its own address, so the sign-in's tries per address (app/api/auth/passkey/signin) never run out here.
let browsers = 0;
const asJson = (url: string, body: unknown, cookie: string) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", cookie, "x-forwarded-for": `198.51.100.${Math.floor(browsers++ / 2) % 250}` }, body: JSON.stringify(body) });

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
  part("Issue #4355: a passkey login while a two-step reset waits, and calling it off is not confirmed");
  const ZED = "zed-reset@example.com";
  await turnOnApp(ZED, "zed-backup@example.org");
  const key = makePasskey(ZED, "cred-zed-1");
  await key.keep();
  const rec = `nl:2fa:${hex(`nimbus-2fa:${ZED}`).slice(0, 40)}`;
  const [raw] = await redis.pipeline([["GET", rec]]);
  // A turn-off day in the shape enterLocked writes: at least RESET_DAYS after the app was turned on (lib/two-step.ts).
  const turnedOn = JSON.parse(String(raw)) as { since: number };
  const due = turnedOn.since + RESET_DAYS * 86_400_000;
  await redis.pipeline([["SET", rec, JSON.stringify({ ...turnedOn, reset: due })]]);
  const opened = new Set<string>();
  const original = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof original }).pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) if (c[0] === "SET" && String(c[1]).startsWith("nl:auth:session:")) opened.add(String(c[1]));
    return commands.some((c) => (c[0] === "SET" || c[0] === "EVAL" || c[0] === "EVALSHA") && c.includes(rec)) ? [] : original(commands);
  }) as typeof original;
  let session = "";
  try {
    session = await signInWithPasskey(key);
  } finally {
    (redis as unknown as { pipeline: typeof original }).pipeline = original;
  }
  const after = JSON.parse(String((await original([["GET", rec]]))[0]));
  is("the reset is still pending (the cancel did not go through)", after.reset, due);
  is("no session cookie is issued while the reset could not be called off", session, "");
  const left = await redis.pipeline([...opened].map((k) => ["GET", k]));
  is("a session was opened before the check (so the test reaches the cancel)", opened.size > 0, true);
  is("and no session is left open behind the refusal", left.filter((v) => v !== null).length, 0);

  part("The same login, once calling the wait off goes through");
  const again = await signInWithPasskey(key);
  is("a session is issued", again.length > 0, true);
  const settled = JSON.parse(String((await redis.pipeline([["GET", rec]]))[0]));
  is("and the wait is called off", settled.reset, 0);

  part("With no reset waiting, nothing changes");
  const plain = await signInWithPasskey(key);
  is("a passkey login with nothing to call off still succeeds", plain.length > 0, true);
  done();
}
void main();
