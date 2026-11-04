/**
 * An account's recovery address (added 13 October 2026): a second inbox the
 * creator confirmed with a code sent to it, for the day they can no longer open
 * the one they log in with. Nobody here unlocks an account by hand, so this —
 * with a passkey, which needs no email at all — is how a creator who lost their
 * email gets back in.
 *
 * From /signin/lost they type their sign-in address; when it has a recovery
 * address, a link goes there (the answer on the page is the same either way,
 * so it says nothing about who has an account). The link lets them in at once:
 *
 *   - with two-step login on, it leads to the code page like the emailed link
 *     does, and a right code or a passkey opens everything; "Get in now" opens
 *     the studio with what matters locked (lib/two-step.ts enterLocked);
 *   - without it, the studio opens with what matters locked for LOCK_DAYS —
 *     payments, the plan, the team, exports, settings, sending to the list,
 *     imports, the sign-in address, passkeys and two-step login — and then
 *     everything opens, the sign-in address included, so they can move it to an
 *     inbox they have. A login with the sign-in inbox, a passkey or a code
 *     before then logs those sessions out and ends the lock.
 *
 * The lock is what keeps an old recovery inbox that somebody else got into
 * from becoming a quiet way to take the store: the sign-in address is told at
 * once, and its owner has the week to answer.
 *
 *   nl:auth:rec:<hash>        the account's recovery address
 *   nl:auth:rec:set:<hash>    an address being confirmed, 10 minutes, tied to the session
 *   nl:auth:rec:link:<hash>   a link sent to the recovery address, 15 minutes, spent once
 *   nl:auth:rec:until:<hash>  until when logins through the recovery address are locked
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { LOCKED_LIST } from "@/lib/locked-words";

/** How long logins through the recovery address alone are locked. */
export const LOCK_DAYS = 7;
const SET_SECONDS = 10 * 60;
const LINK_SECONDS = 15 * 60;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const addressKey = (email: string) => `nl:auth:rec:${sha(`nimbus-rec:${normaliseEmail(email)}`).slice(0, 40)}`;
const setKey = (session: string) => `nl:auth:rec:set:${sha(`nimbus-rec-set:${session}`).slice(0, 40)}`;
const linkKey = (token: string) => `nl:auth:rec:link:${sha(`nimbus-rec-link:${token}`).slice(0, 40)}`;
const untilKey = (email: string) => `nl:auth:rec:until:${sha(`nimbus-rec-until:${normaliseEmail(email)}`).slice(0, 40)}`;

/** The account's recovery address, or "" for none. */
export async function recoveryAddress(email: string): Promise<string> {
  if (!isRedisConfigured()) return "";
  const [raw] = await redisPipeline([["GET", addressKey(email)]]);
  return typeof raw === "string" && EMAIL_PATTERN.test(raw) ? raw : "";
}

/** Keeps an address already proved to be read (the two-step setup's own code). */
export async function keepRecoveryAddress(email: string, address: string): Promise<void> {
  await redisPipeline([["SET", addressKey(email), normaliseEmail(address)]]);
}

/** An address shown without giving it away: its first letters, the rest as dots. */
export function hideAddress(address: string): string {
  const [name = "", domain = ""] = address.split("@");
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const end = dot > 0 ? domain.slice(dot) : "";
  return `${name.slice(0, 1)}•••@${host.slice(0, 1)}•••${end}`;
}

const when = () => new Date().toISOString().replace("T", " ").slice(0, 16);

async function mail(to: string, subject: string, lines: string[]): Promise<boolean> {
  if (!isSenderConfigured()) return false;
  return sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to, replyTo: "support@marktmorgen.com", subject, text: lines.join("\n") }).catch(() => false);
}

export type StartAnswer = "sent" | "invalid" | "same" | "limited" | "unsent";

/** Sends a six-digit code to the address being set, to prove it is read. */
export async function startRecoveryAddress(email: string, session: string, raw: string): Promise<StartAnswer> {
  const address = normaliseEmail(raw);
  if (!address || address.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(address)) return "invalid";
  if (address === normaliseEmail(email)) return "same";
  if (!(await withinLimit("recovery-address", normaliseEmail(email), 5, 60 * 60))) return "limited";
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const sent = await mail(address, `${code} is your code to confirm a recovery address`, [
    `The Marktmorgen account ${normaliseEmail(email)} is choosing this address to get back in if its owner can no longer open their email or lose their phone.`,
    "",
    `Your code: ${code}`,
    "",
    "It works for ten minutes. If you did not expect this, ignore it: nothing happens unless the code is typed in.",
  ]);
  if (!sent) return "unsent";
  await redisPipeline([["SET", setKey(session), JSON.stringify({ e: normaliseEmail(email), a: address, c: sha(`nimbus-rec-code:${code}`) }), "EX", SET_SECONDS]]);
  return "sent";
}

/** Keeps the address once its code is right; the sign-in address is told. */
export async function confirmRecoveryAddress(email: string, session: string, code: string): Promise<{ address: string } | "expired" | "wrong"> {
  const [raw] = await redisPipeline([["GET", setKey(session)]]);
  let pending: { e?: unknown; a?: unknown; c?: unknown } = {};
  try {
    pending = typeof raw === "string" ? (JSON.parse(raw) as typeof pending) : {};
  } catch {
    pending = {};
  }
  if (pending.e !== normaliseEmail(email) || typeof pending.a !== "string" || typeof pending.c !== "string") return "expired";
  if (sha(`nimbus-rec-code:${code.replace(/\D/g, "")}`) !== pending.c) return "wrong";
  await redisPipeline([
    ["SET", addressKey(email), pending.a],
    ["DEL", setKey(session)],
  ]);
  await mail(normaliseEmail(email), "Your Marktmorgen account has a new recovery address", [
    `${hideAddress(pending.a)} is now the recovery address of your Marktmorgen account: if you can no longer open this inbox, a link sent there lets you back in.`,
    "",
    `When: ${when()} UTC`,
    "",
    "If this was not you, log in, change it under Account in your studio, choose “Log out of all devices”, and reply to this email.",
  ]);
  return { address: pending.a };
}

/** Forgets the recovery address; the sign-in address is told. */
export async function removeRecoveryAddress(email: string): Promise<void> {
  await redisPipeline([["DEL", addressKey(email)]]);
  await mail(normaliseEmail(email), "Your Marktmorgen account has no recovery address now", [
    "The recovery address of your Marktmorgen account was removed. If you can no longer open this inbox, a passkey is the way back in.",
    "",
    `When: ${when()} UTC`,
  ]);
}

/**
 * From /signin/lost: a link to the recovery address of the account that logs
 * in with `signIn`, when it has one. The caller answers the same either way.
 */
export async function sendLostEmailLink(signIn: string, ip: string, origin: string): Promise<void> {
  const email = normaliseEmail(signIn);
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return;
  if (!(await withinLimit("lost-email-ip", ip, 10, 60 * 60))) return;
  if (!(await withinLimit("lost-email", email, 3, 60 * 60))) return;
  const address = await recoveryAddress(email);
  if (!address) return;
  const token = randomBytes(32).toString("hex");
  await redisPipeline([["SET", linkKey(token), email, "EX", LINK_SECONDS]]);
  await mail(address, "Get back into your Marktmorgen account", [
    `This is the recovery address of the Marktmorgen account ${email}. Somebody said they can no longer open that inbox and asked for a way in.`,
    "",
    "This link logs you in. It works once, for 15 minutes:",
    `${origin}/signin/lost/confirm?token=${token}`,
    "",
    `Until ${LOCK_DAYS} days have passed, ${LOCKED_LIST} stay locked for a login like this; everything else is open at once. Then you can move your sign-in address to an inbox you have.`,
    "",
    "If you did not ask for this, ignore it: nothing changes unless the link is used.",
  ]);
  await mail(email, "Somebody asked to log in to your Marktmorgen account through its recovery address", [
    `A link was sent to your recovery address (${hideAddress(address)}) because somebody said they can no longer open this inbox.`,
    "",
    `When: ${when()} UTC`,
    "",
    "If this was you, there is nothing to do. If it was not, log in with this inbox or a passkey: that ends anything opened through the recovery address.",
  ]);
}

/** Spends a link sent to the recovery address: whose account it opens, or null. */
export async function spendLostEmailLink(token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token) || !isRedisConfigured()) return null;
  let email: unknown;
  try {
    [email] = await redisPipeline([["GETDEL", linkKey(token)]]);
  } catch {
    const [readBack] = await redisPipeline([["GET", linkKey(token)]]);
    const [removed] = await redisPipeline([["DEL", linkKey(token)]]);
    email = Number(removed) === 1 ? readBack : null;
  }
  return typeof email === "string" && email ? email : null;
}

/** How long, after its lock has run out unanswered, the recovery address goes on logging in with everything open. */
const CLEARED_DAYS = 30;

/**
 * Until when a login through the recovery address is locked, in ms: the first
 * one sets it LOCK_DAYS ahead. Once those days have passed with no answer from
 * the sign-in inbox, a passkey or a code, the recovery address has shown it is
 * the owner's: for CLEARED_DAYS more its logins open everything, so the owner
 * can move the sign-in address to an inbox they have. 0 for such a login.
 */
export async function recoveryLockUntil(email: string, now = Date.now()): Promise<number> {
  const [raw] = await redisPipeline([["GET", untilKey(email)]]);
  const until = Number(raw);
  if (typeof raw === "string" && Number.isFinite(until)) return until > now ? until : 0;
  const next = now + LOCK_DAYS * 86_400_000;
  await redisPipeline([["SET", untilKey(email), String(next), "EX", (LOCK_DAYS + CLEARED_DAYS) * 86_400]]);
  return next;
}

/** Puts the lock on a day already set elsewhere (lib/two-step.ts enterLocked), so its CLEARED_DAYS follow it too. */
export async function alignRecoveryLock(email: string, until: number, now = Date.now()): Promise<void> {
  const seconds = Math.max(60, Math.ceil((until - now) / 1000)) + CLEARED_DAYS * 86_400;
  await redisPipeline([["SET", untilKey(email), String(until), "EX", seconds]]);
}

/** Ends the lock (the sign-in inbox, a passkey or a code logged in). True when there was one. */
export async function endRecoveryLock(email: string): Promise<boolean> {
  const [removed] = await redisPipeline([["DEL", untilKey(email)]]);
  return Number(removed) === 1;
}

/** Carries the recovery address to a new sign-in address (app/api/auth/move). */
export async function moveRecoveryAddress(from: string, to: string): Promise<void> {
  const address = await recoveryAddress(from);
  const commands: (string | number)[][] = [["DEL", addressKey(from), untilKey(from)]];
  // The new sign-in address may be the old recovery address: then there is none left.
  if (address && address !== normaliseEmail(to)) commands.unshift(["SET", addressKey(to), address]);
  await redisPipeline(commands);
}
