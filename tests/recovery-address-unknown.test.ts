/**
 * A recovery address that could not be read is never "none" (CX-123 rule 24; VR2 audit finding on the studio's
 * Account section). lib/recovery-address.ts recoveryAddress answered "" for any reply that was not an address, so a
 * missing envelope, a number or a value this code never wrote read as "this account has no recovery address": the
 * studio and two-step status said so, the rescue page answered "none", and a move dropped it. Checked:
 *
 *   - a reply in any shape other than GET's own (null, or an address this code wrote) is unknown and throws;
 *   - confirmed absence (GET null) stays "" and a kept address is read back as it is (healthy controls);
 *   - the two-step status is not said with no recovery address when it could not be read;
 *   - the rescue from the code page never answers "none" on an unreadable address;
 *   - getting in without the second step is refused while the recovery address cannot be read, before the waiting
 *     login is spent or the day is set, so the owner's recovery address is never left untold of the window in which
 *     Cancel stops it (MM-SA-19; Claude 6 on #3154); once it reads, the same waiting login gets in and both are told;
 *   - a passkey is never removed, set to go or kept with only the sign-in inbox told because the recovery address
 *     could not be read: the change is refused before anything is written or sent (lib/passkeys.ts);
 *   - two-step login is not turned off on its day while the address to tell cannot be read: it waits.
 *
 * Synthetic: the Redis stand-in, with one GET's reply replaced, and a fetch stub for the email provider.
 */
import { createHash } from "node:crypto";
import { keepRecoveryAddress, recoveryAddress } from "@/lib/recovery-address";
import { cancelRemoval, listPasskeys, removePasskey, scheduleRemovalSaid } from "@/lib/passkeys";
import { RESET_DAYS, enterLocked, finishSetup, holdSignIn, resetIfDue, sendRescue, startSetup, twoStepOn, twoStepStatus } from "@/lib/two-step";
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
const addressKey = (email: string) => `nl:auth:rec:${sha(`nimbus-rec:${email}`).slice(0, 40)}`;
const SESSION = "d".repeat(64);
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

/** The reply the recovery address's own GET gets, as the cases below replace it; "envelope" drops the reply list. */
type Bad = { label: string; reply: unknown } | { label: string; envelope: true };
const BAD: Bad[] = [
  { label: "a missing reply list", envelope: true },
  { label: "a number", reply: 7 },
  { label: "a value this code never wrote", reply: "not an address" },
  { label: "an object", reply: { address: "x@example.com" } },
  { label: "a list", reply: ["x@example.com"] },
];

/** Runs `work` with every GET of `email`'s recovery address answered by `bad`; every other command is real. */
async function withBadRead<T>(email: string, bad: Bad, work: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  const key = addressKey(email);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original.call(redis, commands);
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) return "envelope" in bad ? [] : [bad.reply];
    return replies;
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const outcome = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    return `answered ${JSON.stringify(await work())}`;
  } catch (error) {
    return error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `other error: ${String(error)}`;
  }
};

async function withTwoStepOn(email: string, backup: string): Promise<void> {
  const started = await startSetup(email, SESSION, backup);
  if (typeof started === "string") throw new Error(started);
  const finished = await finishSetup(email, SESSION, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(finished);
}

async function main(): Promise<void> {
  redis.clear();
  const KEPT = "kept@example.com";
  const KEPT_BACKUP = "kept.backup@example.org";
  await keepRecoveryAddress(KEPT, KEPT_BACKUP);

  part("Healthy controls: a kept address, and confirmed absence");
  is("a kept recovery address is read back", await recoveryAddress(KEPT), KEPT_BACKUP);
  is("no recovery address (GET null) is none", await recoveryAddress("nobody@example.com"), "");

  part("A reply in another shape is unknown, never none");
  for (const bad of BAD) is(`${bad.label}: unknown`, await withBadRead(KEPT, bad, () => outcome(() => recoveryAddress(KEPT))), "unknown");

  part("Two-step status: an unreadable recovery address is not said as none");
  const OWNER = "owner@example.com";
  const BACKUP = "owner.backup@example.org";
  await withTwoStepOn(OWNER, BACKUP);
  is("healthy: the status shows it, partly hidden", (await twoStepStatus(OWNER)).backup, "o•••@e•••.org");
  for (const bad of BAD) is(`${bad.label}: the status could not be read`, await withBadRead(OWNER, bad, () => outcome(async () => (await twoStepStatus(OWNER)).backup)), "unknown");

  part("The rescue from the code page never answers none on an unreadable address");
  const rescueOwner = "rescue@example.com";
  await withTwoStepOn(rescueOwner, "rescue.backup@example.org");
  is("healthy: a rescue link is sent", await sendRescue(await holdSignIn(rescueOwner), "https://example.test"), "sent");
  const noRecovery = "norecovery@example.com";
  await withTwoStepOn(noRecovery, "norecovery.backup@example.org");
  await redis.pipeline([["DEL", addressKey(noRecovery)]]);
  is("confirmed absence: none", await sendRescue(await holdSignIn(noRecovery), "https://example.test"), "none");
  for (const bad of BAD) {
    const held = await holdSignIn(rescueOwner);
    is(`${bad.label}: not none`, await withBadRead(rescueOwner, bad, () => outcome(() => sendRescue(held, "https://example.test"))), "unknown");
  }

  part("Getting in without the second step waits while the address to tell cannot be read");
  const OPENED = "Your Marktmorgen account was opened without two-step login";
  for (const [i, bad] of BAD.entries()) {
    const email = `locked${i}@example.com`;
    const backup = `locked${i}.backup@example.org`;
    await withTwoStepOn(email, backup);
    const held = await holdSignIn(email);
    const from = mails.length;
    is(`${bad.label}: refused as unknown`, await withBadRead(email, bad, () => outcome(() => enterLocked(held))), "unknown");
    is(`${bad.label}: no day was set and nobody was told`, [(await twoStepStatus(email)).reset, mails.length - from], [0, 0]);
    const entered = await enterLocked(held);
    is(`${bad.label}: once it reads, the same waiting login gets in`, entered?.email ?? null, email);
    is(
      `${bad.label}: and the sign-in inbox and the recovery address are both told`,
      [email, backup].map((to) => mails.slice(from).some((m) => m.to === to && m.subject === OPENED)),
      [true, true],
    );
  }

  part("A passkey change is refused, not told to the sign-in inbox alone, while the recovery address cannot be read");
  const passkeyKey = (email: string) => `nl:pk:${sha(`nimbus-passkeys:${email}`).slice(0, 40)}`;
  const withPasskey = (email: string, id: string) =>
    redis.pipeline([["SET", passkeyKey(email), JSON.stringify([{ id, publicKey: "pk", counter: 0, transports: [], name: "Work laptop", createdAt: "", lastUsedAt: "", synced: false }])]]);
  for (const [i, bad] of BAD.entries()) {
    const email = `pk${i}@example.com`;
    const backup = `pk${i}.backup@example.org`;
    await keepRecoveryAddress(email, backup);
    await withPasskey(email, "k1");
    const from = mails.length;
    is(`${bad.label}: removing at once is unknown`, await withBadRead(email, bad, () => outcome(() => removePasskey(email, "k1"))), "unknown");
    is(`${bad.label}: the passkey is still there and nobody was told`, [(await listPasskeys(email)).length, mails.length - from], [1, 0]);
    is(`${bad.label}: setting it to go is unknown`, await withBadRead(email, bad, () => outcome(() => scheduleRemovalSaid(email, "k1", SESSION))), "unknown");
    is(`${bad.label}: nothing set and nobody told`, [await outcome(() => cancelRemoval(email, "k1", undefined)), mails.length - from], ['answered "unknown"', 0]);
    await scheduleRemovalSaid(email, "k1", SESSION);
    const set = mails.length;
    is(`${bad.label}: keeping it is unknown`, await withBadRead(email, bad, () => outcome(() => cancelRemoval(email, "k1", undefined))), "unknown");
    is(`${bad.label}: still set to go and nobody told`, [mails.length - set], [0]);
    is(`${bad.label}: once it reads, keeping it tells both`, [await cancelRemoval(email, "k1", undefined), [email, backup].map((to) => mails.slice(set).some((m) => m.to === to && m.subject === "Your passkey stays on your Marktmorgen account"))], ["kept", [true, true]]);
    const healthy = mails.length;
    is(`${bad.label}: once it reads, removing it tells both`, [await removePasskey(email, "k1"), [email, backup].map((to) => mails.slice(healthy).some((m) => m.to === to && m.subject === "A passkey was removed from your Marktmorgen account"))], ["removed", [true, true]]);
  }

  part("Two-step login is not turned off on its day while the address to tell cannot be read");
  for (const [i, bad] of BAD.entries()) {
    const email = `reset${i}@example.com`;
    await withTwoStepOn(email, `reset${i}.backup@example.org`);
    const entered = await enterLocked(await holdSignIn(email));
    if (!entered) throw new Error("not let in");
    const later = Date.now() + (RESET_DAYS + 1) * 86_400_000;
    const reset = await withBadRead(email, bad, () => outcome(() => resetIfDue(email, later)));
    is(`${bad.label}: not turned off`, reset === "answered true", false);
    is(`${bad.label}: two-step login is still on`, await twoStepOn(email), true);
    is(`${bad.label}: once readable, it turns off and tells the recovery address`, [await resetIfDue(email, later), mails.some((m) => m.to === `reset${i}.backup@example.org` && m.subject === "Two-step login is off for your Marktmorgen account")], [true, true]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
