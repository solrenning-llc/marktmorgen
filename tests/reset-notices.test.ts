/**
 * The reset path's notices also reach the confirmed recovery address
 * (MM-SA-19, 506 [SG1]; docs/security-audit-2026-10-28.md).
 *
 * Getting in without the second step (enterLocked) assumes somebody else may
 * hold the sign-in inbox, so telling only that inbox may tell only them. The
 * three notices on that path (opened without two-step login, a passkey
 * removed, two-step login off after RESET_DAYS) go to the confirmed recovery
 * address as well. Checked:
 *
 *   - each of the three reaches the sign-in address and the confirmed recovery address;
 *   - an address still waiting for its confirming code gets nothing;
 *   - an account from before, whose two-step record kept the address (`backup`), is told there;
 *   - one notice only when both addresses are the same;
 *   - the sign-in address's subjects and wording are the ones it always got.
 *
 * Synthetic: the Redis stand-in and a fetch stub for the email provider; no real email is sent.
 */
import { createHash } from "node:crypto";
import { removePasskey } from "@/lib/passkeys";
import { keepRecoveryAddress, startRecoveryAddress } from "@/lib/recovery-address";
import { RESET_DAYS, enterLocked, finishSetup, holdSignIn, resetIfDue, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
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

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${email}`).slice(0, 40)}`;
const passkeyListKey = (email: string) => `nl:pk:${sha(`nimbus-passkeys:${email}`).slice(0, 40)}`;
const SESSION = "c".repeat(64);
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

/** What each address was sent from `from` on, by subject. */
const sentSince = (from: number) => mails.slice(from).map((m) => `${m.to} | ${m.subject}`);

const OPENED = "Your Marktmorgen account was opened without two-step login";
const REMOVED = "A passkey was removed from your Marktmorgen account";
const OFF = "Two-step login is off for your Marktmorgen account";

/** An account with two-step login on, through the real setup, with a confirmed recovery address. */
async function withConfirmedRecovery(email: string, backup: string): Promise<void> {
  const started = await startSetup(email, SESSION, backup);
  if (typeof started === "string") throw new Error(started);
  const finished = await finishSetup(email, SESSION, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(finished);
}

/** An account from before there was a separate recovery address: its record kept `backup` itself. */
async function legacyRecord(email: string, backup: string): Promise<void> {
  await redis.pipeline([["SET", recordKey(email), JSON.stringify({ s: "sealed-stand-in", since: 1, codes: [], last: -1, reset: 0, backup })]]);
}

async function withPasskey(email: string, id: string): Promise<void> {
  await redis.pipeline([["SET", passkeyListKey(email), JSON.stringify([{ id, publicKey: "pk", counter: 0, transports: [], name: "Work laptop", createdAt: "", lastUsedAt: "", synced: false }])]]);
}

/** The three notices of the reset path, in order: opened without two-step, a passkey removed, off after the days. */
async function resetPath(email: string): Promise<number> {
  const from = mails.length;
  const entered = await enterLocked(await holdSignIn(email));
  if (!entered) throw new Error("not let in");
  await withPasskey(email, `key-${email}`);
  await removePasskey(email, `key-${email}`);
  await resetIfDue(email, Date.now() + (RESET_DAYS + 1) * 86_400_000);
  return from;
}

async function main(): Promise<void> {
  redis.clear();

  part("A confirmed recovery address hears what its sign-in inbox hears");
  const OWNER = "owner@example.com";
  const BACKUP = "owner.backup@example.org";
  await withConfirmedRecovery(OWNER, BACKUP);
  const ownerFrom = await resetPath(OWNER);
  is("each of the three, to both addresses", sentSince(ownerFrom), [
    `${OWNER} | ${OPENED}`,
    `${BACKUP} | ${OPENED}`,
    `${OWNER} | ${REMOVED}`,
    `${BACKUP} | ${REMOVED}`,
    `${OWNER} | ${OFF}`,
    `${BACKUP} | ${OFF}`,
  ]);
  const toBackup = mails.slice(ownerFrom).filter((m) => m.to === BACKUP);
  is("the recovery address is told whose account it is", toBackup.length === 3 && toBackup.every((m) => m.text.startsWith(`This is the recovery address for the Marktmorgen account ${OWNER}, so you get this notice too.`)), true);
  is("and is not told a link was sent to it", (toBackup[0]?.text ?? "").includes("a login link sent to the sign-in address") && !(toBackup[0]?.text ?? "").includes("sent to this address"), true);
  is("the passkey notice tells it which account to log in to", (toBackup[1]?.text ?? "").includes(`as ${OWNER}, remove any passkey`), true);

  part("The sign-in address's notices are the ones it always got");
  const toOwner = mails.slice(ownerFrom).filter((m) => m.to === OWNER);
  is("opened without two-step", toOwner[0].text.startsWith("Somebody who opened a login link sent to this address said they no longer have your authenticator app"), true);
  is("a passkey removed", [toOwner[1].text.startsWith(`The passkey called “Work laptop” was removed from your Marktmorgen account (${OWNER}). It cannot log in anymore.`), toOwner[1].text.includes("with this email address, remove any passkey")], [true, true]);
  is("two-step login off", toOwner[2].text.startsWith(`Two-step login was turned off ${RESET_DAYS} days after you got in without it, and nothing in your studio is locked any more.`), true);

  part("An address not yet confirmed hears nothing");
  const PENDING_OWNER = "pending@example.com";
  const PENDING = "not.confirmed@example.org";
  await legacyRecord(PENDING_OWNER, "");
  is("the address waits for its code", await startRecoveryAddress(PENDING_OWNER, "d".repeat(64), PENDING), "sent");
  const pendingFrom = await resetPath(PENDING_OWNER);
  is("only the sign-in address is told", sentSince(pendingFrom), [`${PENDING_OWNER} | ${OPENED}`, `${PENDING_OWNER} | ${REMOVED}`, `${PENDING_OWNER} | ${OFF}`]);

  part("An account from before: its record's own recovery address");
  const OLD = "old@example.com";
  const OLD_BACKUP = "old.backup@example.org";
  await legacyRecord(OLD, OLD_BACKUP);
  const oldFrom = await resetPath(OLD);
  is("each of the three, to both, the last read before the record goes", sentSince(oldFrom), [
    `${OLD} | ${OPENED}`,
    `${OLD_BACKUP} | ${OPENED}`,
    `${OLD} | ${REMOVED}`,
    `${OLD_BACKUP} | ${REMOVED}`,
    `${OLD} | ${OFF}`,
    `${OLD_BACKUP} | ${OFF}`,
  ]);

  part("One address for both: one notice");
  const SAME = "same@example.com";
  await legacyRecord(SAME, "");
  await keepRecoveryAddress(SAME, "Same@Example.com");
  const sameFrom = await resetPath(SAME);
  is("never twice to the same inbox", sentSince(sameFrom), [`${SAME} | ${OPENED}`, `${SAME} | ${REMOVED}`, `${SAME} | ${OFF}`]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
