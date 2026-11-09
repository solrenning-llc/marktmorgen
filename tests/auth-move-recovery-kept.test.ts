/**
 * A move of the sign-in address never leaves the account without its recovery address in silence (review of
 * #2883). app/api/auth/move ran moveRecoveryAddress (lib/recovery-address.ts) inside a Promise.all whose error was
 * only logged: when carrying the address failed, the move was said as done ("address=moved") and nobody was told
 * the account may now have no recovery address. Checked, through the real route:
 *
 *   - healthy controls: the address goes with the account, and an account without one moves as before;
 *   - the carry refused, its reply lost after it ran, or the old address unreadable: the move stands (the store and
 *     its ways in are already at the new address), the studio says the recovery address did not move, and both
 *     sign-in addresses are told to add it again;
 *   - with the notices unsendable the studio still says it: the screen is the notice that cannot be lost;
 *   - with the sessions unread too, both are said;
 *   - the studio has words for both.
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
// The old sign-in address's notice at the end of every move (review of claude5/move-keeps-recovery, finding 2).
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
async function move(recovery: string | null, faults: (from: string, to: string) => Fault[] = () => [], mailDown = false) {
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
    location = (await moveRoute(post("https://marktmorgen.com/api/auth/move", { token }))).headers.get("location");
  } finally {
    redis.pipeline = real;
    console.error = quiet;
    sending = true;
  }
  // Changed (rule 23, review of claude5/move-keeps-recovery, finding 2): the old address's notice is now the one it
  // gets at the end of every move, under its own subject, so both subjects are read; the new address still gets
  // SUBJECT only when the recovery address did not come along.
  const told = mails.filter((m) => m.subject === SUBJECT || (m.subject === FINISHED && m.to === from));
  return {
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
  part("healthy controls");
  const kept = await move(RECOVERY);
  // Changed (rule 23, review of claude5/move-keeps-recovery, finding 2): the old address is told the move finished,
  // every time; what is still checked is that nobody is told the recovery address did not come along.
  is("the recovery address goes with the account, said as moved, nobody told it did not", [kept.location, kept.moved, kept.atTo, kept.told, kept.toldFrom.includes("recovery address")], ["https://marktmorgen.com/studio?address=moved", true, RECOVERY, [kept.from], false]);
  const none = await move(null);
  // Changed (rule 23, same finding): as above, the old address hears only that the move finished.
  is("an account without one moves as before", [none.location, none.moved, none.atTo, none.told, none.toldFrom.includes("recovery address")], ["https://marktmorgen.com/studio?address=moved", true, null, [none.from], false]);

  part("the recovery address could not be carried: the move stands, and it is never silent");
  for (const [label, fault] of [
    ["the carry refused", (_from: string, to: string) => [refuseCarry(to)]],
    ["the carry's reply lost after it ran", (_from: string, to: string) => [loseCarryReply(to)]],
    ["the old recovery address unreadable", (from: string) => [unreadOld(from)]],
  ] as const) {
    const out = await move(RECOVERY, fault);
    is(`${label}: moved, and the studio says the recovery address did not move`, [out.location, out.moved], ["https://marktmorgen.com/studio?address=moved-no-recovery", true]);
    is(`${label}: both sign-in addresses are told`, out.told, [out.from, out.to].sort());
    is(
      `${label}: the notices say what to do, in plain words`,
      [out.toldTo.includes("add a recovery address again"), out.toldFrom.includes(out.to), out.toldFrom.includes("add a recovery address again")],
      [true, true, true],
    );
  }

  part("the screen says it even when no email can go");
  const unsent = await move(RECOVERY, (_from, to) => [refuseCarry(to)], true);
  is("notices unsendable: the studio still says the recovery address did not move", [unsent.location, unsent.moved, unsent.told], ["https://marktmorgen.com/studio?address=moved-no-recovery", true, []]);

  part("with the sessions unread too, both are said");
  const both = await move(RECOVERY, (_from, to) => [refuseCarry(to), unreadSessions]);
  is("sessions unread and the recovery address not carried", [both.location, both.moved, both.told], ["https://marktmorgen.com/studio?address=moved-sessions-open-no-recovery", true, [both.from, both.to].sort()]);

  part("the studio has words for both");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  // Changed (rule 23, review of claude5/move-keeps-recovery, finding 4): both statuses are now made by movedNotice, a
  // notice that asks for action (a status with its own heading and a link to the recovery address), and they say to
  // check it, as a carry whose answer was lost may have written it (finding 3).
  is(
    "each status is a notice, and both say to check the recovery address and add one again",
    [
      // Changed (rule 23, finding 5): the statuses may also end in -no-teams.
      // Changed again (rule 23, Claude 2's third review of #3326): and in -keys-open, a removal's key sweep left unfinished.
      studio.includes("const flags = /^moved(-sessions-open)?(-no-recovery)?(-no-teams)?(-keys-open)?$/.exec(key);"),
      studio.includes('{ href: "#account-recovery", label: "Check your recovery address" }'),
      (studio.match(/We could not confirm that your recovery address came along\. Check it, and add one again if none is shown\./g) ?? []).length,
    ],
    [true, true, 1],
  );
  done();
}

void main();
