/**
 * Review of claude5/move-keeps-recovery (app/api/auth/move): what the end of a move tells, and what it leaves behind
 * under the address the account moved away from. Checked through the real route:
 *
 *   - the link in a notice is built by linkOrigin (lib/request-origin.ts), never from a host the request names that
 *     is a creator's domain;
 *   - the old sign-in address is always told the move finished, not only when something failed;
 *   - a recovery address that could not be carried is not left keyed by the old sign-in address, where a future
 *     account there would inherit it.
 *
 * Synthetic: the Redis stand-in, with chosen pipelines refused or answered wrong, and a fetch stub for the email
 * provider.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { openSession, sendMoveLink } from "@/lib/auth";
import { keepRecoveryAddress } from "@/lib/recovery-address";
import { claimHandle, storeForEmail } from "@/lib/store";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
type Mail = { to: string; subject: string; text: string };
const mails: Mail[] = [];
let sending = true;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    if (!sending) return new Response("{}", { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const addressKey = (email: string) => `nl:auth:rec:${sha(`nimbus-rec:${email}`).slice(0, 40)}`;
const SUBJECT = "Your recovery address did not move with your account";
const FINISHED = "The email your Marktmorgen account logs in with changed";
const post = (url: string, fields: Record<string, string>) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

/** What goes wrong during the move, by pipeline; every other command is real. */
type Fault = (commands: Command[]) => Promise<unknown[]> | null;
const carries = (to: string) => (commands: Command[]) => commands.some((c) => c[0] === "SET" && c[1] === addressKey(to));
const refuseCarry = (to: string): Fault => (commands) => (carries(to)(commands) ? Promise.reject(new Error("refused before it ran")) : null);
const loseCarryReply = (to: string): Fault => (commands) =>
  carries(to)(commands) ? real(commands).then(() => Promise.reject(new Error("the reply was lost after it ran"))) : null;
const unreadOld = (from: string): Fault => (commands) =>
  commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === addressKey(from) ? real(commands).then(() => ["not an address"]) : null;
const unreadSessions: Fault = (commands) =>
  commands.some((c) => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:auth:sessions:"))
    ? real(commands).then((replies) => replies.map((reply, i) => (commands[i][0] === "SMEMBERS" && String(commands[i][1]).startsWith("nl:auth:sessions:") ? { 0: "x" } : reply)))
    : null;

let n = 0;
/** One move through the real route, with `faults` in place for the route alone. */
async function move(recovery: string | null, faults: (from: string, to: string) => Fault[] = () => [], mailDown = false, host = "") {
  n += 1;
  const from = `move-rec-from-${n}@example.com`;
  const to = `move-rec-to-${n}@example.com`;
  await claimHandle(from, `move-rec-${n}`, "Mover", "");
  if (recovery) await keepRecoveryAddress(from, recovery);
  const asker = await openSession(from);
  mails.length = 0;
  await sendMoveLink(from, to, "https://marktmorgen.com", asker);
  const token = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
  mails.length = 0;
  sending = !mailDown;
  const active = faults(from, to);
  redis.pipeline = async (commands: Command[]) => {
    for (const fault of active) {
      const answer = fault(commands);
      if (answer) return answer;
    }
    return real(commands);
  };
  const quiet = console.error;
  console.error = () => {};
  let location: string | null;
  try {
    location = (await moveRoute(host ? new NextRequest("https://marktmorgen.com/api/auth/move", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-host": host, host }, body: new URLSearchParams({ token }) }) : post("https://marktmorgen.com/api/auth/move", { token }))).headers.get("location");
  } finally {
    redis.pipeline = real;
    console.error = quiet;
    sending = true;
  }
  // Changed (rule 23, finding 2): the old address's notice has its own subject now; both are read.
  const told = mails.filter((m) => m.subject === SUBJECT || (m.subject === FINISHED && m.to === from));
  const all = mails.map((m) => m.to);
  const fromKey = (await real([["GET", addressKey(from)]]))[0];
  return {
    all, fromKey,
    location,
    moved: Boolean(await storeForEmail(to)) && !(await storeForEmail(from)),
    atTo: (await real([["GET", addressKey(to)]]))[0],
    told: told.map((m) => m.to).sort(),
    toldTo: told.find((m) => m.to === to)?.text ?? "",
    toldFrom: told.find((m) => m.to === from)?.text ?? "",
    from,
    to,
  };
}

const RECOVERY = "backup-inbox@example.org";
async function main() {
  part("the link in a notice: through a creator's domain, never that domain (linkOrigin)");
  const viaDomain = await move(RECOVERY, (_f, to) => [refuseCarry(to)], false, "some-creator-store.example");
  is("the notice to the OLD address never links to a creator's domain", viaDomain.toldFrom.includes("some-creator-store.example"), false);
  part("the old address is told the move finished, also when nothing failed");
  const ok = await move(RECOVERY);
  is("the old address hears that the move finished", ok.all.includes(ok.from), true);
  is(
    "it says so in its subject and first line, says what to do if it was not them before the way in, and never names the recovery address",
    [
      ok.toldFrom.startsWith(`The Marktmorgen account that logged in with this address now logs in with ${ok.to}.`),
      ok.toldFrom.indexOf("If you did not make this change") >= 0 && ok.toldFrom.indexOf("If you did not make this change") < ok.toldFrom.indexOf(`Log in with ${ok.to}`),
      ok.toldFrom.includes("reply to this email"),
      ok.toldFrom.includes(RECOVERY) || ok.toldTo.includes(RECOVERY),
      ok.all.filter((to) => to === ok.from).length,
      ok.all.filter((to) => to === ok.to).length,
    ],
    [true, true, true, false, 1, 0],
  );
  is("the notices never name the recovery address when it did not come along either", viaDomain.toldFrom.includes(RECOVERY) || viaDomain.toldTo.includes(RECOVERY), false);
  is("and the link they give is this site's own", viaDomain.toldFrom.includes("https://marktmorgen.com/signin"), true);
  part("the carry failed on the read: nothing is left keyed by the old sign-in address");
  const stale = await move(RECOVERY, (from) => [unreadOld(from)]);
  is("no recovery address is left behind under the old sign-in address", stale.fromKey, null);
  done();
}
void main();
