/**
 * The recovery address read in an unknown shape (rule 24): never read as
 * "this account has no recovery address".
 *
 *   - removing or replacing it used to skip telling the old address (MM-SA-19);
 *   - moving the sign-in address used to delete it without carrying it over;
 *   - a code being confirmed used to be answered "expired";
 *   - the recovery login's lock used to be written afresh over what was kept,
 *     and a kept lock in any shape `Number()` reads (" 5", "0x10", "-1") opened everything;
 *   - getting in without two-step login (enterLocked) wrote the reset day, then
 *     failed before anybody was told, so the days ran out in silence;
 *   - a write whose answer is not "OK" (or 0/1 for DEL) was taken as done: a
 *     move deleted the address it had not carried, a confirmation or a removal
 *     told the owner what may not have happened (review of #2883).
 *
 * Synthetic only: the Redis stub, and a stand-in for Resend.
 */
import { createHash } from "node:crypto";
import { LOCK_DAYS, alignRecoveryLock, confirmRecoveryAddress, keepRecoveryAddress, moveRecoveryAddress, recoveryAddress, recoveryLockUntil, removeRecoveryAddress, startRecoveryAddress } from "@/lib/recovery-address";
import { RESET_DAYS, endRecoveryAccess, enterLocked, finishSetup, holdSignIn, openLockedSession, resetIfDue, startSetup } from "@/lib/two-step";
import { emailForSession } from "@/lib/auth";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const addressKey = (email: string) => `nl:auth:rec:${sha(`nimbus-rec:${email}`).slice(0, 40)}`;
const setKey = (session: string) => `nl:auth:rec:set:${sha(`nimbus-rec-set:${session}`).slice(0, 40)}`;
const untilKey = (email: string) => `nl:auth:rec:until:${sha(`nimbus-rec-until:${email}`).slice(0, 40)}`;
const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const sent: Commands = [];

async function outcome<T>(key: string, reply: unknown[], body: () => Promise<T>): Promise<T | "rejected"> {
  sent.length = 0;
  redis.pipeline = (async (c: Commands) => {
    sent.push(...c);
    return c.length === 1 && c[0][0] === "GET" && c[0][1] === key ? [...reply] : real(c);
  }) as typeof redis.pipeline;
  try {
    return await body();
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

/**
 * Runs `body` with each command that `bad` matches answered by `reply`; the
 * other commands of the same pipeline run for real. `reply` "throw" is an error
 * answer: the rest ran, and the pipeline throws (lib/redis.ts).
 */
async function writesAnswer<T>(bad: (c: (string | number)[]) => boolean, reply: unknown, body: () => Promise<T>): Promise<T | "rejected"> {
  sent.length = 0;
  redis.pipeline = (async (c: Commands) => {
    sent.push(...c);
    if (!c.some(bad)) return real(c);
    const rest = await real(c.filter((one) => !bad(one)));
    if (reply === "throw") throw new Error("Redis error: OOM command not allowed");
    let next = 0;
    return c.map((one) => (bad(one) ? reply : rest[next++]));
  }) as typeof redis.pipeline;
  try {
    return await body();
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

const ME = "owner@example.com";
const OLD = "old.spare@example.org";
const SESSION = "d".repeat(64);
const MALFORMED: [string, unknown[]][] = [["no reply", []], ["undefined", [undefined]], ["a number", [9]], ["an object", [{}]], ["two replies", [OLD, OLD]]];

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  for (const [label, reply] of MALFORMED) {
    part(`The recovery address answers ${label}`);
    await keepRecoveryAddress(ME, OLD);
    is("read: never 'none'", await outcome(addressKey(ME), reply, () => recoveryAddress(ME)), "rejected");

    mails.length = 0;
    is("removing it is not done on a guess", await outcome(addressKey(ME), reply, () => removeRecoveryAddress(ME)), "rejected");
    is("it is still kept, and nobody was told it went", [await recoveryAddress(ME), mails.length], [OLD, 0]);

    await startRecoveryAddress(ME, SESSION, "new.spare@example.org");
    const code = /Your code: (\d{6})/.exec(mails.at(-1)?.text ?? "")?.[1] ?? "";
    mails.length = 0;
    is("replacing it is not done on a guess", await outcome(addressKey(ME), reply, () => confirmRecoveryAddress(ME, SESSION, code)), "rejected");
    is("the old one is still kept, and nobody was told", [await recoveryAddress(ME), mails.length], [OLD, 0]);

    is("the code being confirmed is not 'expired'", await outcome(setKey(SESSION), reply, () => confirmRecoveryAddress(ME, SESSION, code)), "rejected");

    is("moving the sign-in address does not drop it", await outcome(addressKey(ME), reply, () => moveRecoveryAddress(ME, "moved@example.com")), "rejected");
    is("still kept where it was", [await recoveryAddress(ME), await recoveryAddress("moved@example.com")], [OLD, ""]);

    part(`The recovery login's lock answers ${label}`);
    const kept = Date.now() + 2 * 86_400_000;
    await real([["SET", untilKey(ME), String(kept)]]);
    const until = await outcome(untilKey(ME), reply, () => recoveryLockUntil(ME));
    is("locked, never opened, on an unknown lock", typeof until === "number" && until > Date.now(), true);
    is("and nothing written over the kept lock", [sent.filter((c) => c[0] === "SET").length, (await real([["GET", untilKey(ME)]]))[0]], [0, String(kept)]);
  }

  part("A kept lock in a shape the writer never stores is not known: locked, nothing written");
  for (const kept of ["-1", "1.5", " 5", "0x10", "0", "1e3", "00", "12abc", String(Date.now() + 86_400_000) + ".5"]) {
    redis.clear();
    await real([["SET", untilKey(ME), kept]]);
    sent.length = 0;
    const until = await outcome("none", [], () => recoveryLockUntil(ME));
    is(`"${kept}": locked for the week, never opened`, typeof until === "number" && until > Date.now() + (LOCK_DAYS - 1) * 86_400_000, true);
    is(`"${kept}": and kept as it was`, [sent.filter((c) => c[0] === "SET").length, (await real([["GET", untilKey(ME)]]))[0]], [0, kept]);
  }

  part("A pending code stored as text that is not its JSON is not known, never 'expired'");
  for (const text of ["{", "[1]", "5", "null", '"x"']) {
    redis.clear();
    await real([["SET", setKey(SESSION), text]]);
    is(`"${text}"`, await outcome("none", [], () => confirmRecoveryAddress(ME, SESSION, "123456")), "rejected");
  }

  const NEW = "new.spare@example.org";
  const TO = "moved@example.com";
  for (const [label, reply] of [["no answer", undefined], ["an error", "throw"], ["a number", 9], ["another text", "QUEUED"]] as [string, unknown][]) {
    part(`Moving the sign-in address: the copy to the new one answers ${label}`);
    redis.clear();
    await keepRecoveryAddress(ME, OLD);
    const isCopy = (c: (string | number)[]) => c[0] === "SET" && c[1] === addressKey(TO);
    is("the move is not said as done", await writesAnswer(isCopy, reply, () => moveRecoveryAddress(ME, TO)), "rejected");
    is("and the old one is not deleted", await recoveryAddress(ME), OLD);

    part(`Moving the sign-in address: deleting the old one answers ${label}`);
    redis.clear();
    await keepRecoveryAddress(ME, OLD);
    const isDrop = (c: (string | number)[]) => c[0] === "DEL" && c[1] === addressKey(ME);
    is("the move is not said as done", await writesAnswer(isDrop, reply, () => moveRecoveryAddress(ME, TO)), "rejected");
    is("the new address has it", await recoveryAddress(TO), OLD);

    part(`Confirming a new recovery address: keeping it answers ${label}`);
    redis.clear();
    await keepRecoveryAddress(ME, OLD);
    await startRecoveryAddress(ME, SESSION, NEW);
    const code = /Your code: (\d{6})/.exec(mails.at(-1)?.text ?? "")?.[1] ?? "";
    mails.length = 0;
    const isKeep = (c: (string | number)[]) => c[0] === "SET" && c[1] === addressKey(ME);
    is("not said as done", await writesAnswer(isKeep, reply, () => confirmRecoveryAddress(ME, SESSION, code)), "rejected");
    is("and nobody was told it changed", mails.length, 0);

    part(`Removing the recovery address: the delete answers ${label}`);
    redis.clear();
    await keepRecoveryAddress(ME, OLD);
    mails.length = 0;
    const isRemove = (c: (string | number)[]) => c[0] === "DEL" && c[1] === addressKey(ME);
    is("not said as done", await writesAnswer(isRemove, reply, () => removeRecoveryAddress(ME)), "rejected");
    is("and nobody was told it went", mails.length, 0);

    if (reply === "throw") continue;
    part(`Writes that answer ${label} are not said as kept`);
    redis.clear();
    is("keeping a recovery address", await writesAnswer(isKeep, reply, () => keepRecoveryAddress(ME, OLD)), false);
    const isLock = (c: (string | number)[]) => c[0] === "SET" && c[1] === untilKey(ME);
    is("aligning the lock", await writesAnswer(isLock, reply, () => alignRecoveryLock(ME, Date.now() + 86_400_000)), false);
  }

  part("Getting in without two-step login: an unreadable recovery address changes nothing before anybody is told");
  for (const [label, reply] of MALFORMED) {
    redis.clear();
    const OWNER = "locked.owner@example.com";
    const BACKUP = "locked.backup@example.org";
    const started = await startSetup(OWNER, SESSION, BACKUP);
    if (typeof started === "string") throw new Error(started);
    const appCode = codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
    const mailed = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === BACKUP)?.text ?? "")?.[1] ?? "";
    const finished = await finishSetup(OWNER, SESSION, appCode, mailed);
    if (typeof finished === "string") throw new Error(finished);
    const held = await holdSignIn(OWNER);
    mails.length = 0;
    is(`${label}: not let in on a guess`, await outcome(addressKey(OWNER), reply, () => enterLocked(held)), "rejected");
    is(`${label}: no reset day was started, so two-step login does not turn off unannounced`, await resetIfDue(OWNER, Date.now() + (RESET_DAYS + 1) * 86_400_000), false);
    const again = await enterLocked(held);
    is(`${label}: the waiting login is not spent; asked again, both addresses are told`, [again?.email, mails.map((m) => m.to).sort()], [OWNER, [BACKUP, OWNER].sort()]);
  }

  // Claude 6 on #2883 (MEDIUM, rule 30): a full login ends what the recovery address opened. The lock's DEL answered
  // in no known shape was read as "there was no lock", so the recovery session stayed alive, nobody was told, and it
  // opened everything after its day. Only a confirmed 0 is "no lock"; anything else goes on as if there was one.
  for (const [label, reply] of [["no answer", undefined], ["9", 9], ["QUEUED", "QUEUED"], ["an error", "throw"]] as [string, unknown][]) {
    part(`A full login ends the recovery login when the lock's delete answers ${label}`);
    redis.clear();
    await keepRecoveryAddress(ME, OLD);
    const until = await recoveryLockUntil(ME);
    const intruder = await openLockedSession(ME, until);
    mails.length = 0;
    const ended = await writesAnswer((c) => c[0] === "DEL" && c[1] === untilKey(ME), reply, () => endRecoveryAccess(ME));
    is(`${label}: the call does not fail`, ended, undefined);
    is(`${label}: the recovery session is logged out`, await emailForSession(intruder), null);
    is(`${label}: the owner is told`, mails.some((m) => m.to === ME), true);
  }
  part("Control: a full login with a recovery lock ends it and tells the owner");
  redis.clear();
  await keepRecoveryAddress(ME, OLD);
  const healthyIntruder = await openLockedSession(ME, await recoveryLockUntil(ME));
  mails.length = 0;
  await endRecoveryAccess(ME);
  is("logged out and told", [await emailForSession(healthyIntruder), mails.some((m) => m.to === ME)], [null, true]);
  part("A full login with no recovery lock (a confirmed 0) tells nobody");
  redis.clear();
  mails.length = 0;
  await endRecoveryAccess(ME);
  is("nobody is told", mails.length, 0);

  part("Controls");
  redis.clear();
  is("no recovery address: none", await recoveryAddress(ME), "");
  const first = await recoveryLockUntil(ME);
  is("no lock yet: a week from now, kept", [Math.round((first - Date.now()) / 86_400_000), (await real([["GET", untilKey(ME)]]))[0]], [LOCK_DAYS, String(first)]);
  await keepRecoveryAddress(ME, OLD);
  mails.length = 0;
  await removeRecoveryAddress(ME);
  is("a healthy removal tells the old address", [await recoveryAddress(ME), mails.map((m) => m.to).sort()], ["", [ME, OLD].sort()]);
  is("a healthy keep is kept", [await keepRecoveryAddress(ME, OLD), await recoveryAddress(ME)], [true, OLD]);
  is("a healthy move carries it and drops the old one", [await moveRecoveryAddress(ME, "moved@example.com"), await recoveryAddress("moved@example.com"), await recoveryAddress(ME)], [undefined, OLD, ""]);
  const day = Date.now() + 3 * 86_400_000;
  is("a healthy alignment is kept", [await alignRecoveryLock(ME, day), await recoveryLockUntil(ME)], [true, day]);
  await keepRecoveryAddress(ME, OLD);
  await moveRecoveryAddress(ME, OLD);
  is("moved onto the recovery address itself: none is left", [await recoveryAddress(ME), await recoveryAddress(OLD)], ["", ""]);
  done();
}

void main();
