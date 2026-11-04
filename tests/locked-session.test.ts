/**
 * A session let in without the second step (lib/two-step.ts, enterLocked;
 * also what the recovery address alone opens) may do nothing that cannot be
 * undone, and the owner hears about it where an intruder cannot read
 * (393 security audit SG1, 506 [SG1]). Checked:
 *
 *   - what a locked session may do is an allow-list: every permission of
 *     lib/team-roles.ts is classified, so a new one added to the roles
 *     without being classified fails here;
 *   - it cannot erase a person (the "erase" permission);
 *   - it cannot remove the owner's passkeys, one of the ways the owner calls
 *     the reset off;
 *   - the notices of that path ("opened without two-step login", "turned off
 *     after 7 days") go to the confirmed recovery address too, not only to
 *     the sign-in inbox the path assumes somebody else may hold;
 *   - accepting a team invitation does not open a full session for an
 *     address with two-step login on and no store or team of its own.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { emailForSession, openSession } from "@/lib/auth";
import { hasAccount } from "@/lib/account-exists";
import { studioAccess } from "@/lib/studio-route";
import * as twoStep from "@/lib/two-step";
import { RESET_DAYS, finishSetup, lockedUntil, resetIfDue, startSetup } from "@/lib/two-step";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/team-roles";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember } from "@/lib/team";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { POST as passkeyRoute } from "@/app/api/auth/passkey/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_locked_session_only_a_stand_in";
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (url.includes("api.stripe.com")) return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function linkFor(email: string): Promise<string> {
  const token = sha(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${sha(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  return token;
}
const post = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";

/** Two-step login turned on for an address, with a confirmed recovery address. */
async function turnOn(email: string, backup: string, session: string): Promise<void> {
  const started = await startSetup(email, session, backup);
  if (typeof started === "string") throw new Error(`setup: ${started}`);
  const finished = await finishSetup(email, session, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(`finish: ${finished}`);
}

/** A session opened from the code page with nothing but the sign-in inbox. */
async function lockedSessionFor(email: string): Promise<string> {
  const hold = cookieOf(await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(email) })), "nl_2fa");
  return cookieOf(await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${hold}`)), "nl_session");
}

async function main(): Promise<void> {
  redis.clear();

  part("What a locked session may do is an allow-list");
  const allows = (twoStep as unknown as { LOCKED_ALLOWS?: Record<string, boolean> }).LOCKED_ALLOWS;
  const every = [...ROLE_PERMISSIONS.owner] as Permission[];
  is("every permission of the roles is classified, allowed or locked", every.filter((p) => typeof allows?.[p] !== "boolean"), []);
  is("nothing is classified that the roles do not have", Object.keys(allows ?? {}).filter((p) => !every.includes(p as Permission)), []);
  is("erasing a person, payments, the plan, the team, deleting, exports, settings, sending and imports are locked", ["erase", "billing", "payments", "team", "delete", "export", "settings", "send", "import"].filter((p) => allows?.[p] !== false), []);

  const OWNER = "owner@locked.example";
  const BACKUP = "owner.backup@locked.example";
  await turnOn(OWNER, BACKUP, "a".repeat(64));
  // The owner has a passkey, written as lib/passkeys.ts keeps it.
  const listKey = `nl:pk:${sha(`nimbus-passkeys:${OWNER}`).slice(0, 40)}`;
  const credKey = `nl:pk:cred:${sha("nimbus-passkey-id:PKID").slice(0, 40)}`;
  await redis.pipeline([["SET", listKey, JSON.stringify([{ id: "PKID", publicKey: "AA", counter: 0, transports: [], name: "Owner phone", createdAt: "", lastUsedAt: "", synced: true }])], ["SET", credKey, OWNER]]);

  const before = mails.length;
  const locked = await lockedSessionFor(OWNER);
  is("the session is open, and locked", [await emailForSession(locked), (await lockedUntil(locked)) > 0], [OWNER, true]);
  const asStudio = async (need: string) => {
    const answer = await studioAccess(new NextRequest("https://marktmorgen.com/api/store/person", { method: "POST", headers: { cookie: `nl_session=${locked}` } }), need as never);
    return answer.ok ? "open" : (answer as { reason: string }).reason;
  };
  is("it cannot erase a person", await asStudio("erase"), "locked");
  is("nor anything the allow-list does not name", await Promise.all(every.filter((p) => allows?.[p] !== true).map(asStudio)), every.filter((p) => allows?.[p] !== true).map(() => "locked"));

  part("A locked session cannot remove the owner's passkeys");
  const removed = await passkeyRoute(new NextRequest("https://marktmorgen.com/api/auth/passkey", { method: "POST", headers: { "content-type": "application/json", cookie: `nl_session=${locked}` }, body: JSON.stringify({ action: "remove", id: "PKID" }) }));
  const [list] = await redis.pipeline([["GET", listKey]]);
  const [cred] = await redis.pipeline([["GET", credKey]]);
  is("refused as locked", [removed.status, ((await removed.json()) as { error?: string }).error], [403, "locked"]);
  is("and the passkey is still there", [String(list).includes("PKID"), cred], [true, OWNER]);

  part("The recovery address hears what this path does");
  const opened = mails.slice(before).filter((m) => m.subject.includes("opened without two-step login"));
  is("the opening is told to the sign-in inbox and to the recovery address", opened.map((m) => m.to).sort(), [BACKUP, OWNER].sort());
  is("the recovery address is told why it gets this", opened.find((m) => m.to === BACKUP)?.text.includes(`recovery address for the Marktmorgen account ${OWNER}`), true);
  const beforeOff = mails.length;
  is("after the days, two-step login turns off", await resetIfDue(OWNER, Date.now() + (RESET_DAYS + 1) * 86_400_000), true);
  is("and that is told to both too", mails.slice(beforeOff).filter((m) => m.subject.includes("Two-step login is off")).map((m) => m.to).sort(), [BACKUP, OWNER].sort());

  part("A team invitation does not skip two-step login");
  const CREATOR = "creator@join.example";
  await claimHandle(CREATOR, "join-two-step", "Join Two Step", "");
  await ensureStatsId(CREATOR);
  await ensureStoreId(CREATOR);
  await ensureListId(CREATOR);
  await setStripeAccount(CREATOR, "acct_1JoinTwoStepXXX", true);
  await setSubscription(CREATOR, { customerId: "cus_jointwostep", subscriptionId: "sub_jointwostep", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(CREATOR))!;
  const HELPER = "helper@join.example";
  await turnOn(HELPER, "helper.backup@join.example", "b".repeat(64));
  const invited = await inviteMember(shop, HELPER, "editor", "https://marktmorgen.com");
  is("the invitation is sent", invited.ok, true);
  // The route reads this before spending the invitation; true sends them to log in the usual way, with no session opened.
  is("an address with two-step login on, and no store, team or passkey, counts as an account", await hasAccount(HELPER), true);
  is("an address with nothing still does not", await hasAccount("nobody@join.example"), false);
  is("and the invitation route asks that very check", readFileSync(join(process.cwd(), "app/api/auth/join/route.ts"), "utf8").includes('import { hasAccount } from "@/lib/account-exists";'), true);

  part("A passkey removed by a full session is told to the recovery address too");
  const full = await openSession(OWNER);
  const beforeRemove = mails.length;
  const gone = await passkeyRoute(new NextRequest("https://marktmorgen.com/api/auth/passkey", { method: "POST", headers: { "content-type": "application/json", cookie: `nl_session=${full}` }, body: JSON.stringify({ action: "remove", id: "PKID" }) }));
  is("a full session may remove it", gone.status, 200);
  is("both addresses are told", mails.slice(beforeRemove).filter((m) => m.subject.includes("passkey was removed")).map((m) => m.to).sort(), [BACKUP, OWNER].sort());

  part("An account from before keeps its recovery address on its two-step record, and is told there too");
  const OLD = "old@locked.example";
  const OLD_BACKUP = "old.backup@locked.example";
  await turnOn(OLD, OLD_BACKUP, "d".repeat(64));
  // As an account set up before the address had a key of its own: only the record's `backup` holds it.
  const recordKey = `nl:2fa:${sha(`nimbus-2fa:${OLD}`).slice(0, 40)}`;
  const [rawRecord] = await redis.pipeline([["GET", recordKey]]);
  await redis.pipeline([["SET", recordKey, JSON.stringify({ ...(JSON.parse(String(rawRecord)) as object), backup: OLD_BACKUP })], ["DEL", `nl:auth:rec:${sha(`nimbus-rec:${OLD}`).slice(0, 40)}`]]);
  is("two-step login still reads that address (lib/two-step.ts)", (await twoStep.twoStepStatus(OLD)).backup !== "", true);
  const oldList = `nl:pk:${sha(`nimbus-passkeys:${OLD}`).slice(0, 40)}`;
  await redis.pipeline([["SET", oldList, JSON.stringify([{ id: "PKOLD", publicKey: "AA", counter: 0, transports: [], name: "Old laptop", createdAt: "", lastUsedAt: "", synced: true }])], ["SET", `nl:pk:cred:${sha("nimbus-passkey-id:PKOLD").slice(0, 40)}`, OLD]]);
  const beforeOld = mails.length;
  const oldGone = await passkeyRoute(new NextRequest("https://marktmorgen.com/api/auth/passkey", { method: "POST", headers: { "content-type": "application/json", cookie: `nl_session=${await openSession(OLD)}` }, body: JSON.stringify({ action: "remove", id: "PKOLD" }) }));
  is("removed by a full session", oldGone.status, 200);
  is("and told to the record's recovery address as well", mails.slice(beforeOld).filter((m) => m.subject.includes("passkey was removed")).map((m) => m.to).sort(), [OLD_BACKUP, OLD].sort());

  done();
}

void main();
