/**
 * The recovery address read in an unknown shape (rule 24): never read as
 * "this account has no recovery address".
 *
 *   - removing or replacing it used to skip telling the old address (MM-SA-19);
 *   - moving the sign-in address used to delete it without carrying it over;
 *   - a code being confirmed used to be answered "expired";
 *   - the recovery login's lock used to be written afresh over what was kept.
 *
 * Synthetic only: the Redis stub, and a stand-in for Resend.
 */
import { createHash } from "node:crypto";
import { LOCK_DAYS, confirmRecoveryAddress, keepRecoveryAddress, moveRecoveryAddress, recoveryAddress, recoveryLockUntil, removeRecoveryAddress, startRecoveryAddress } from "@/lib/recovery-address";
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

  part("Controls");
  redis.clear();
  is("no recovery address: none", await recoveryAddress(ME), "");
  const first = await recoveryLockUntil(ME);
  is("no lock yet: a week from now, kept", [Math.round((first - Date.now()) / 86_400_000), (await real([["GET", untilKey(ME)]]))[0]], [LOCK_DAYS, String(first)]);
  await keepRecoveryAddress(ME, OLD);
  mails.length = 0;
  await removeRecoveryAddress(ME);
  is("a healthy removal tells the old address", [await recoveryAddress(ME), mails.map((m) => m.to).sort()], ["", [ME, OLD].sort()]);
  done();
}

void main();
