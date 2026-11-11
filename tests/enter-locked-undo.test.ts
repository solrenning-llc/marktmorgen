/**
 * Getting in without the second step (lib/two-step.ts enterLocked) starts the
 * RESET_DAYS clock only for a login that really opened (Claude 5 on #2948).
 *
 * The first such login writes the day two-step login turns off, then opens a
 * locked session, then tells the sign-in and recovery addresses. When the
 * session does not open (its lock not confirmed, the request failed) or the
 * recovery lock cannot be aligned, or the recovery address the notice goes to
 * cannot be read (read before anything is written), nobody got in and nobody was told: the day
 * is taken back, so two-step login never turns off by itself on a login that
 * never happened, and a session opened on the way is taken back too. A day
 * already set by an earlier login is never moved or taken back.
 *
 * Synthetic accounts, Redis stand-in, emails caught here.
 */
import { createHash } from "node:crypto";
import { RESET_DAYS, enterLocked, finishSetup, holdSignIn, resetIfDue, startSetup, twoStepStatus } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// A synthetic key the Resend fixture knows (tests/resend-fixture-credentials.ts), the one reset-notices uses.
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
const pipeline = redis.pipeline.bind(redis);
/** Answers a batch whose first command `match` picks with `reply` ("throw": the request fails). */
let tamper: { match: (c: Command) => boolean; reply: unknown } | null = null;
redis.pipeline = (async (commands: Command[]) => {
  if (tamper && tamper.match(commands[0])) {
    if (tamper.reply === "throw") throw new Error("synthetic: connection reset");
    await pipeline(commands);
    return tamper.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const SESSION = "c".repeat(64);
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const untilKey = (email: string) => `nl:auth:rec:until:${sha(`nimbus-rec-until:${email}`).slice(0, 40)}`;
const OPENED = /opened (again )?without two-step login/;

async function withTwoStepOn(email: string): Promise<void> {
  const backup = `backup.${email}`;
  const started = await startSetup(email, SESSION, backup);
  if (typeof started === "string") throw new Error(started);
  const finished = await finishSetup(email, SESSION, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(finished);
}

/** One login without the second step, with `how` in place while it runs: what it answered and what followed. */
async function attempt(email: string, how: typeof tamper) {
  const from = mails.length;
  const token = await holdSignIn(email);
  tamper = how;
  const entered = await enterLocked(token).then((r) => (r ? "let in" : "refused"), () => "failed");
  tamper = null;
  const reset = (await twoStepStatus(email)).reset;
  return { entered, told: mails.slice(from).filter((m) => OPENED.test(m.subject)).length, reset };
}
const later = Date.now() + (RESET_DAYS + 1) * 86_400_000;

async function main(): Promise<void> {
  redis.clear();

  const FAILS: [string, NonNullable<typeof tamper>][] = [
    ["the locked session's lock not confirmed", { match: (c) => c[0] === "SET" && String(c[1]).startsWith("nl:2fa:locked:"), reply: [] }],
    ["the locked session's lock request failed", { match: (c) => c[0] === "SET" && String(c[1]).startsWith("nl:2fa:locked:"), reply: "throw" }],
    ["the recovery lock could not be aligned", { match: (c) => c[0] === "SET" && String(c[1]).startsWith("nl:auth:rec:until:"), reply: "throw" }],
    // Claude 6 on #2948: the notice's recovery address, read after the day was set and the session opened.
    ["the recovery address could not be read", { match: (c) => c[0] === "GET" && /^nl:auth:rec:[0-9a-f]{40}$/.test(String(c[1])), reply: "throw" }],
  ];

  part("A first login without the second step that did not open: the day is taken back, nobody was told");
  for (const [label, how] of FAILS) {
    const email = `first${FAILS.findIndex(([l]) => l === label)}@example.com`;
    await withTwoStepOn(email);
    is(`${label}: not let in, not told, no day set`, await attempt(email, how), { entered: "failed", told: 0, reset: 0 });
    is(`${label}: two-step login never turns off by itself`, [await resetIfDue(email, later), (await twoStepStatus(email)).on], [false, true]);
  }

  part("A day already set by an earlier login is never taken back by one that did not open");
  for (const [label, how] of FAILS) {
    const email = `again${FAILS.findIndex(([l]) => l === label)}@example.com`;
    await withTwoStepOn(email);
    const first = await attempt(email, null);
    is(`${label}: the first login let in, told both addresses and set the day`, [first.entered, first.told, first.reset > 0], ["let in", 2, true]);
    is(`${label}: the second, failed, leaves that day as it was`, await attempt(email, how), { entered: "failed", told: 0, reset: first.reset });
  }

  part("Control: a login that opens sets the day once, tells both addresses, and aligns the recovery lock");
  await withTwoStepOn("healthy@example.com");
  const healthy = await attempt("healthy@example.com", null);
  is("let in, told once at each address (sign-in and recovery), the day set", [healthy.entered, healthy.told, healthy.reset > Date.now()], ["let in", 2, true]);
  is("the recovery lock holds the same day", (await pipeline([["GET", untilKey("healthy@example.com")]]))[0], String(healthy.reset));
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
