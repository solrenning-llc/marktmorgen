/**
 * Claude 6's LEVE on #2674 (7057694750), the follow-up named in that PR: two company-paid emails of two-step login
 * still read their hourly counter with the fail-open withinLimit, so with only the counter failing they were sent with
 * nothing counted. `two-step-backup` (startSetup) mails a code to an address the person typed, before any other
 * Redis write; `two-step-rescue` (sendRescue) mails a link to the recovery address. Each now reads its counter with
 * essentialLimitState: past the limit "limited", as before; a count that cannot be read "unsent", nothing sent, never
 * "limited".
 *
 * Each flow first really sends with room (a positive control), so a 0 sent on an unreadable count is the guard's
 * work. Synthetic only: an in-memory Redis, a fetch that answers Resend, a sending key the Resend fixture knows.
 */
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { finishSetup, holdSignIn, sendRescue, startSetup } from "@/lib/two-step";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// A synthetic key the Resend fixture knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
const ORIGIN = "https://marktmorgen.com";
type Mail = { to: string; text: string };
const mails: Mail[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// One counter scope at a time: "full" puts it far past any limit; "unknown" makes Redis throw on that counter only.
type Mode = "full" | "unknown" | "room";
let mode: { scope: string; how: Mode } | null = null;
const filled = new Set<string>();
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const hit = mode && mode.how !== "room" ? commands.find((c) => String(c[1] ?? "").startsWith(`nl:rl:${mode!.scope}:`)) : undefined;
  if (hit && mode!.how === "unknown") throw new Error("Redis timed out (synthetic)");
  if (hit) { filled.add(String(hit[1])); await real([["SET", String(hit[1]), "1000000000", "EX", 86_400]]); }
  return real(commands);
}) as typeof redis.pipeline;

async function under<T>(scope: string, how: Mode, run: () => Promise<T>): Promise<{ value: T; sent: number }> {
  mode = { scope, how };
  const before = mails.length;
  try {
    return { value: await run(), sent: mails.length - before };
  } finally {
    mode = null;
    if (filled.size) await real([["DEL", ...filled]]);
    filled.clear();
  }
}

const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const label = (value: unknown) => (typeof value === "string" ? value : "started");

async function main(): Promise<void> {
  redis.clear();

  part("A code to a recovery address being set up (two-step-backup)");
  const room = await under("two-step-backup", "room", () => startSetup("ana-setup@example.com", "a".repeat(64), "ana-backup@example.org"));
  is("control: with room, the setup starts and one code is mailed", [label(room.value), room.sent], ["started", 1]);
  const unknown = await under("two-step-backup", "unknown", () => startSetup("ben-setup@example.com", "b".repeat(64), "ben-backup@example.org"));
  is("the count unreadable: unsent, nothing mailed, never 'limited'", [label(unknown.value), unknown.sent], ["unsent", 0]);
  const full = await under("two-step-backup", "full", () => startSetup("cy-setup@example.com", "c".repeat(64), "cy-backup@example.org"));
  is("past the hour's codes: limited, as before", [label(full.value), full.sent], ["limited", 0]);

  part("A rescue link to the recovery address (two-step-rescue)");
  const DEE = "dee-rescue@example.com";
  const started = await startSetup(DEE, "d".repeat(64), "dee-backup@example.org");
  if (typeof started === "string") throw new Error(`setup: ${started}`);
  const finished = await finishSetup(DEE, "d".repeat(64), nowCode(started.secret), codeTo("dee-backup@example.org"));
  if (typeof finished === "string") throw new Error(`setup: ${finished}`);
  const rescueRoom = await under("two-step-rescue", "room", async () => sendRescue(await holdSignIn(DEE), ORIGIN));
  is("control: with room, the link is mailed", [rescueRoom.value, rescueRoom.sent], ["sent", 1]);
  const rescueUnknown = await under("two-step-rescue", "unknown", async () => sendRescue(await holdSignIn(DEE), ORIGIN));
  is("the count unreadable: unsent, nothing mailed, never 'limited'", [rescueUnknown.value, rescueUnknown.sent], ["unsent", 0]);
  const rescueFull = await under("two-step-rescue", "full", async () => sendRescue(await holdSignIn(DEE), ORIGIN));
  is("past the hour's links: limited, as before", [rescueFull.value, rescueFull.sent], ["limited", 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
