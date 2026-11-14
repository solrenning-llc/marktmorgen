/**
 * Review of claude5/move-keeps-recovery (app/api/auth/move): what the end of a move tells, and what it leaves behind
 * under the address the account moved away from. Checked through the real route:
 *
 *   - the link in a notice is built by linkOrigin (lib/request-origin.ts), never from a host the request names that
 *     is a creator's domain;
 *   - the old sign-in address is always told the move finished, not only when something failed;
 *   - a recovery address that could not be carried is not left keyed by the old sign-in address, where a future
 *     account there would inherit it;
 *   - a place taken off whose sweep of the API keys could not be finished (KeysNotSwept) has that sweep repeated,
 *     so a key the old address made meanwhile is held for good; repeated in vain, the move is not said as complete,
 *     and the store's owner and both addresses are told.
 *
 * Synthetic: the Redis stand-in, with chosen pipelines refused or answered wrong, and a fetch stub for the email
 * provider.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { openSession, sendMoveLink } from "@/lib/auth";
import { keepRecoveryAddress } from "@/lib/recovery-address";
import { KEY_PREFIX, makeKey, makerPrint, resolveKey } from "@/lib/api-keys";
import { type Store, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { storeForIdExactly } from "@/lib/store-exact";
import { memberStores, putMember, readLog, readTeam } from "@/lib/team";
import type { TeamRole } from "@/lib/team-roles";
import { resolveAccess } from "@/lib/studio-route";
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
const teamIndexKey = (email: string) => `nl:team:of:${sha(`nimbus-team-of:${email}`).slice(0, 40)}`;
/** The first pipeline `hit` names is run, and its replies answered in a shape no Redis gives (rule 24). */
const malformedOnce = (hit: (commands: Command[]) => boolean): Fault => {
  let spent = false;
  return (commands) => (!spent && hit(commands) ? ((spent = true), real(commands).then((replies) => replies.map(() => ({ 0: "x" })))) : null);
};

let n = 0;
/** One move through the real route, with `faults` in place for the route alone. */
async function move(
  recovery: string | null,
  faults: (from: string, to: string, sid: string) => Fault[] = () => [],
  mailDown = false,
  host = "",
  onTeam: boolean | { from: TeamRole; to?: TeamRole } = false,
) {
  n += 1;
  const from = `move-rec-from-${n}@example.com`;
  const to = `move-rec-to-${n}@example.com`;
  await claimHandle(from, `move-rec-${n}`, "Mover", "");
  // Another store whose team the mover is on (finding 5).
  let sid = "";
  if (onTeam) {
    const owner = `move-team-owner-${n}@example.com`;
    await claimHandle(owner, `move-team-${n}`, "Team Shop", "");
    await ensureStatsId(owner);
    const other = (await ensureStoreId(owner))!;
    sid = other.sid;
    // Second review (Claude 2 on #3326, finding HIGH): the new address may already be on that team, in its own role.
    const roles = onTeam === true ? { from: "support" as TeamRole, to: undefined } : onTeam;
    await putMember(other, from, roles.from);
    if (roles.to) await putMember(other, to, roles.to);
  }
  if (recovery) await keepRecoveryAddress(from, recovery);
  const asker = await openSession(from);
  mails.length = 0;
  await sendMoveLink(from, to, "https://marktmorgen.com", asker);
  const token = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
  mails.length = 0;
  sending = !mailDown;
  const active = faults(from, to, sid);
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
  const team = sid ? (await readTeam(sid)).members : [];
  const members = team.map((m) => m.email);
  // An unread log is a failure of the check, never an empty list (rule 24): main's readLog answers null for it.
  const lines = sid ? await readLog(sid) : [];
  if (lines === null) throw new Error("the team's log could not be read");
  return {
    toRole: team.find((m) => m.email === to)?.role ?? null,
    // What a session of the old address would get by naming the store (?store=), as the studio reads it (finding HIGH).
    oldOpens: sid ? (await resolveAccess(from, { pinned: sid }, null)).ok : false,
    all, fromKey, sid, members,
    log: lines.map((line) => line.what),
    fromTeams: sid ? (await memberStores(from)).length : 0,
    mails: [...mails],
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
  // Rule 23 (#3326, CodeQL "Incomplete URL substring sanitization"): the link was found as a substring of the text, which
  // a longer address holding it would also pass; every link in the notice is now read as an address, each must be this
  // site's own origin, and one of them must be its sign-in page.
  const links = (viaDomain.toldFrom.match(/https?:\/\/[^\s<>"')]+/g) ?? []).map((each) => new URL(each.replace(/[.,;:]+$/, "")));
  is("and the link they give is this site's own", [links.length > 0, links.every((each) => each.origin === "https://marktmorgen.com"), links.some((each) => each.pathname === "/signin")], [true, true, true]);
  part("the carry failed on the read: nothing is left keyed by the old sign-in address");
  const stale = await move(RECOVERY, (from) => [unreadOld(from)]);
  is("no recovery address is left behind under the old sign-in address", stale.fromKey, null);
  for (const [label, fault] of [
    ["the carry refused", (_f: string, to: string) => [refuseCarry(to)]],
    ["the carry's reply lost after it ran", (_f: string, to: string) => [loseCarryReply(to)]],
  ] as const) {
    const out = await move(RECOVERY, fault);
    is(`${label}: nothing is left under the old sign-in address, and the account says what it has`, [out.fromKey, out.location], [null, "https://marktmorgen.com/studio?address=moved-no-recovery"]);
  }
  const lost = await move(RECOVERY, (_f, to) => [loseCarryReply(to)]);
  is("a carry whose reply was lost but which ran keeps the address with the account", lost.atTo, RECOVERY);
  is(
    "the notices say to check, never that there is surely none",
    [lost.toldFrom.includes("could not confirm"), lost.toldTo.includes("could not confirm"), /may have no(ne| recovery address)/.test(lost.toldFrom + lost.toldTo)],
    [true, true, false],
  );
  const stuck = await move(RECOVERY, (from, to) => [refuseCarry(to), (commands) => (commands.some((c) => c[0] === "DEL" && c[1] === addressKey(from)) ? Promise.reject(new Error("refused")) : null)]);
  is("with the old record's delete refused too, the move still stands and is said, and the old address is still told", [stuck.location, stuck.all.includes(stuck.from)], ["https://marktmorgen.com/studio?address=moved-no-recovery", true]);

  part("places on other stores' teams not carried: said, and nothing left under the old sign-in address");
  const once = (hit: (commands: Command[]) => boolean): Fault => {
    let spent = false;
    return (commands) => (!spent && hit(commands) ? ((spent = true), Promise.reject(new Error("refused once"))) : null);
  };
  const teamHealthy = await move(null, () => [], false, "", true);
  is("healthy: the place goes with the account, and nothing is said about teams", [teamHealthy.location, teamHealthy.members, teamHealthy.toldFrom.includes("teams")], ["https://marktmorgen.com/studio?address=moved", [teamHealthy.to], false]);
  for (const [label, fault] of [
    ["the place stayed on the old address (its restrictions could not be read)", () => [once((commands) => commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:crm:pacc:")))]],
    ["the carry failed midway (the team could not be read)", (_f: string, _t: string, sid: string) => [once((commands) => commands.some((c) => c[0] === "GET" && c[1] === `nl:team:${sid}`))]],
  ] as const) {
    const out = await move(null, fault as (from: string, to: string, sid: string) => Fault[], false, "", true);
    is(`${label}: the move stands and the studio says it`, [out.location, out.moved], ["https://marktmorgen.com/studio?address=moved-no-teams", true]);
    is(`${label}: the old address is on no team any more, and its index is empty`, [out.members.includes(out.from), out.fromTeams], [false, 0]);
    is(`${label}: the team's log says why`, out.log.some((what) => what.startsWith("Taken off the team: they moved their sign-in")), true);
    const toTo = out.mails.find((m) => m.to === out.to);
    is(
      `${label}: both addresses are told to ask each owner to invite the new address again`,
      [out.toldFrom.includes(`Ask each store's owner to invite ${out.to} again.`), toTo?.subject, toTo?.text.includes("Ask each store's owner to invite this address again.")],
      [true, "Your places on other teams did not move with your account", true],
    );
  }

  part("second review of #3326: no place left on the old address while the move says every place came along");
  const both = await move(null, () => [], false, "", { from: "admin", to: "support" });
  is(
    "the new address already on the team: the old address is taken off it, the new keeps the role its owner gave it, and nothing is said as left behind",
    [both.location, both.members, both.toRole, both.oldOpens, both.fromTeams],
    ["https://marktmorgen.com/studio?address=moved", [both.to], "support", false, 0],
  );
  is("and the team's log says the old address's place was taken off", both.log.some((what) => what.startsWith(`Moved their sign-in from ${both.from}`) && what.includes("admin")), true);
  const bothStuck = await move(null, (_f, _t, sid) => [once((commands) => commands.some((c) => c[0] === "SET" && c[1] === `nl:team:${sid}`))], false, "", { from: "admin", to: "support" });
  is(
    "the new address already on the team, and taking the old one off refused once: said, and taken off by the move's own clean-up",
    [bothStuck.location, bothStuck.members, bothStuck.toRole, bothStuck.oldOpens],
    ["https://marktmorgen.com/studio?address=moved-no-teams", [bothStuck.to], "support", false],
  );
  for (const [label, fault] of [
    ["the old address's list of teams answered in an unknown shape", (from: string) => [malformedOnce((commands) => commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === teamIndexKey(from))]],
    ["the other store answered in an unknown shape", (_f: string, _t: string, sid: string) => [malformedOnce((commands) => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:store:id:${sid}`)]],
  ] as const) {
    const out = await move(null, fault as (from: string, to: string, sid: string) => Fault[], false, "", { from: "admin" });
    is(
      `${label}: never said as carried, and the old address opens the store no more`,
      [out.location, out.members.includes(out.from), out.oldOpens],
      ["https://marktmorgen.com/studio?address=moved-no-teams", false, false],
    );
  }
  const teamAndRecovery = await move(RECOVERY, (_f, to) => [refuseCarry(to), once((commands) => commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:crm:pacc:")))], false, "", true);
  is(
    "with the recovery address too, both are said, still in two emails",
    [teamAndRecovery.location, teamAndRecovery.mails.length, teamAndRecovery.mails.find((m) => m.to === teamAndRecovery.to)?.subject],
    ["https://marktmorgen.com/studio?address=moved-no-recovery-no-teams", 2, "Your recovery address and team places did not move with your account"],
  );

  part("third review of #3326: a removal whose key sweep could not be finished (KeysNotSwept) is repeated, never left");
  // The old address already on the team as `admin`, the new as `support`: the old place is taken off (removeMember).
  // A key the old address made while that removal was under way (after removeMember's first sweep, before its team
  // write, so the making request's own check, afterMake, still found it on the team) is what the second sweep is for.
  // That sweep's read of the store's keys is refused `refusals` times from the team write on.
  const sweepRefused = async (refusals: number, onTeam: { from: TeamRole; to?: TeamRole } = { from: "admin", to: "support" }, extra: Fault[] | ((from: string, sid: string) => Fault[]) = []) => {
    let key = "";
    let armed = false;
    let left = refusals;
    const out = await move(
      null,
      (from, _t, sid) => {
        let made = false;
        const makeMidway: Fault = (commands) =>
          !made && commands.some((c) => c[0] === "SET" && c[1] === `nl:team:${sid}`)
            ? ((made = true),
              makeKey(sid, "Made during the move", Date.now(), false, "none", { owner: false, by: makerPrint(sid, from), step: false })
                .then((result) => {
                  key = result.ok ? result.key : "";
                  return real(commands);
                })
                .then((replies) => ((armed = true), replies)))
            : null;
        const refuseSweep: Fault = (commands) =>
          armed && left > 0 && commands.length === 3 && commands[0][0] === "HGETALL" && commands[0][1] === `nl:api:keys:${sid}`
            ? ((left -= 1), Promise.reject(new Error("the second sweep's read was refused")))
            : null;
        return [...(typeof extra === "function" ? extra(from, sid) : extra), makeMidway, refuseSweep];
      },
      false,
      "",
      onTeam,
    );
    const now = await resolveKey(key);
    // An account made at the old address later and invited to the team: the key the old address made must not work again.
    const store = (await storeForIdExactly(out.sid)) as Store;
    await putMember(store, out.from, "admin");
    const reinvited = await resolveKey(key);
    return { ...out, key, why: now?.why ?? null, reinvitedPaused: reinvited?.paused ?? null };
  };
  const sweptOnRepeat = await sweepRefused(1);
  is("the key was made during the move (the test's own premise)", sweptOnRepeat.key.startsWith(KEY_PREFIX), true);
  is(
    "the sweep refused once: the move repeats it, the key the old address made is held for good, and the place is said as carried",
    [sweptOnRepeat.why, sweptOnRepeat.reinvitedPaused, sweptOnRepeat.location, sweptOnRepeat.toRole],
    ["left", true, "https://marktmorgen.com/studio?address=moved", "support"],
  );
  // The place stayed on the old address (its restrictions could not be read), so the move's clean-up takes it off, with
  // the old address still on the team: the same unfinished sweep there is repeated too.
  let pipelineRead = false;
  const stayedSwept = await sweepRefused(1, { from: "admin" }, [
    (commands) => (!pipelineRead && commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:crm:pacc:")) ? ((pipelineRead = true), Promise.reject(new Error("refused once"))) : null),
  ]);
  is(
    "the place stayed and the clean-up's sweep refused once: repeated there too, the key held for good, the old address off the team, the place said as not carried",
    [stayedSwept.why, stayedSwept.reinvitedPaused, stayedSwept.location, stayedSwept.members.includes(stayedSwept.from)],
    ["left", true, "https://marktmorgen.com/studio?address=moved-no-teams", false],
  );
  const sweepStuck = await sweepRefused(2);
  is(
    "the repeat refused too: the move is not said as complete there, on the page it lands on",
    sweepStuck.location,
    "https://marktmorgen.com/studio?address=moved-keys-open",
  );
  const ownerMail = sweepStuck.mails.find((m) => m.subject.startsWith("Some API keys for") && m.subject.endsWith("may still work"));
  is(
    "the store's owner is emailed and the team's log says it, and both sign-in addresses are told to ask that owner",
    [
      Boolean(ownerMail?.text.includes(sweepStuck.from)),
      sweepStuck.log.some((what) => what.includes(sweepStuck.from) && what.includes("may still work")),
      sweepStuck.toldFrom.includes("may still work"),
      sweepStuck.mails.find((m) => m.to === sweepStuck.to)?.text.includes("may still work") ?? false,
    ],
    [true, true, true, true],
  );

  // Claude 4's review of #3326 at 3c422510 (MEDIUM, rule 24): a store whose sweep is to be repeated is never counted as
  // swept when the clean-up cannot read it, or when anything there throws before the repeat is known to have finished.
  const keyMail = (out: { mails: { subject: string; text: string }[]; from: string }) =>
    Boolean(out.mails.find((m) => m.subject.startsWith("Some API keys for") && m.subject.endsWith("may still work"))?.text.includes(out.from));
  /** Armed at the clean-up (dropMemberships): the second read of the old address's team index, after moveMemberships'. */
  const atCleanUp = (from: string, hit: (commands: Command[]) => boolean, answer: (commands: Command[]) => Promise<unknown[]>): Fault => {
    let indexReads = 0;
    let spent = false;
    return (commands) => {
      if (commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === teamIndexKey(from)) indexReads += 1;
      return !spent && indexReads >= 2 && hit(commands) ? ((spent = true), answer(commands)) : null;
    };
  };
  const unreadStore = await sweepRefused(1, { from: "admin", to: "support" }, (from, sid) => [
    atCleanUp(from, (commands) => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:store:id:${sid}`, (commands) => real(commands).then(() => [42])),
  ]);
  is(
    "the clean-up cannot read the store whose sweep was left: the move says some keys may still work, never that all are held",
    [unreadStore.location, unreadStore.toldFrom.includes("may still work")],
    ["https://marktmorgen.com/studio?address=moved-keys-open", true],
  );
  const unreadTeam = await sweepRefused(1, { from: "admin", to: "support" }, (from, sid) => [
    atCleanUp(from, (commands) => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:team:${sid}`, () => Promise.reject(new Error("the clean-up's team read was refused"))),
  ]);
  is(
    "the clean-up reads the store, then its team read throws: said as keys open, and the store's owner is emailed",
    [unreadTeam.location, keyMail(unreadTeam), unreadTeam.toldFrom.includes("may still work")],
    ["https://marktmorgen.com/studio?address=moved-keys-open", true, true],
  );

  part("the studio's notices that ask for action: a status, a heading, a link that says where it goes");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  const shown = studio.slice(studio.indexOf("{actionNotice ? ("), studio.indexOf(") : notice ? (", studio.indexOf("{actionNotice ? (")));
  is(
    "announced, named by its own heading, each action a link to its place",
    [
      shown.includes('role="status" aria-labelledby="action-notice-title"'),
      shown.includes('<h2 id="action-notice-title"'),
      shown.includes("<a href={action.href}") && shown.includes("min-h-11"),
      studio.includes('{ href: "#account-recovery", label: "Check your recovery address" }'),
      // Changed (rule 23, Claude 2's third review of #3326): "-keys-open" says a removal's key sweep was left unfinished.
      studio.includes("const flags = /^moved(-sessions-open)?(-no-recovery)?(-no-teams)?(-keys-open)?$/.exec(key);"),
      studio.includes('id="account-recovery"') || readFileSync("components/recovery-address-manager.tsx", "utf8").includes('id="account-recovery"'),
      studio.includes('<form id="log-out-everywhere" action="/api/auth/signout-all"'),
    ],
    [true, true, true, true, true, true, true],
  );
  is(
    "the notices from before keep their pattern",
    studio.includes(') : notice ? (\n          <div className="notice notice-warn mt-6">\n            <p className="font-bold text-ink">{notice.title}</p>'),
    true,
  );
  done();
}
void main();
