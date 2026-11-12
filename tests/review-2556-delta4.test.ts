/**
 * Review of #2556 at 4d8ac350e (delta from c6267d1ef).
 *   1  lib/two-step.ts KEEP_ANY past KEPT_ANY_MAX: the list becomes "*", and then every session with no lock
 *      of its own, of every account, pays three more commands on each lockedUntil (every studio page load),
 *      for as long as failures keep coming and SESSION_TTL_SECONDS and a day after the last: counted in no
 *      cost line, and the switch to "*" is said nowhere (KEEP_ANY's answer is not read by endLocked).
 * Synthetic only.
 */
import { createHash } from "node:crypto";
import { openSession } from "@/lib/auth";
import { KEEP_ANY, KEPT_ANY_MAX, cancelReset, enterLocked, finishSetup, holdSignIn, lockedUntil, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { LOCKED_UNTIL_STAR_COMMANDS } from "./plan-cost-registry";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const ANY = `nl:2fa:lockedset:${sha("nimbus-2fa-lockedset:any account").slice(0, 40)}:kept`;

async function main(): Promise<void> {
  redis.clear();
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  const other = await openSession("rv4-other@example.com");
  const cost = async () => {
    let commands = 0;
    redis.pipeline = async (c: Command[]) => {
      commands += c.length;
      return real(c);
    };
    await lockedUntil(other);
    redis.pipeline = real;
    return commands;
  };
  const before = await cost();

  part("1: the list past its ceiling");
  // KEPT_ANY_MAX other accounts already kept locked (their tags, as endLocked writes them).
  for (let n = 0; n < KEPT_ANY_MAX; n += 1) await real([["EVAL", KEEP_ANY, 1, ANY, sha(`tag-${n}`).slice(0, 40), KEPT_ANY_MAX, 86_400]]);
  const LOST = "rv4-lost@example.com";
  const setup = await startSetup(LOST, "e".repeat(64), "rv4-lost-backup@example.org");
  if (typeof setup === "string") throw new Error(setup);
  const finished = await finishSetup(LOST, "e".repeat(64), codeAt(base32Decode(setup.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS)), codeTo("rv4-lost-backup@example.org"));
  if (typeof finished === "string") throw new Error(finished);
  const entered = await enterLocked(await holdSignIn(LOST));
  if (!entered) throw new Error("not let in");
  logged.length = 0;
  redis.pipeline = async (c: Command[]) => (await real(c)).map((reply, i) => (c[i][0] === "SMEMBERS" && String(c[i][1]).startsWith("nl:2fa:lockedset:") ? null : reply));
  await cancelReset(LOST, "studio");
  redis.pipeline = real;
  const [list] = await real([["GET", ANY]]);
  is("(the list became \"*\")", list, "*");
  const after = await cost();
  // Kept on purpose (the safe side, no session that was kept set free), and counted: at most LOCKED_UNTIL_STAR_EXTRA
  // (tests/plan-cost-registry.ts) a call, only in the "*" state; was [before, before] at 136186a0e.
  is("an unrelated account's session: commands per lockedUntil before and after, within the counted extra", [before, after <= before + LOCKED_UNTIL_STAR_COMMANDS], [before, true]);
  is("the switch to \"*\" is said somewhere beyond the account's own failed read", logged.length > 1, true);
  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
