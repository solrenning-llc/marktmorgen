/**
 * The people who help run a store, and what they did.
 *
 * The owner invites someone by email with a role (lib/team-roles.ts). The
 * email carries a link that works once and for seven days; the person taps
 * it, which proves the inbox is theirs, and from then on they sign in the
 * way everyone here does — an emailed link or a passkey — and find the store
 * in their studio. There is no password anywhere in this, and no account to
 * make first.
 *
 *   nl:team:<store id>        -> { members, invites }, as JSON
 *   nl:team:invite:<hash>     -> the store, the invite and the address it is
 *                                for; seven days, spent by the tap that uses it
 *   nl:team:of:<hash>         -> the ids of the stores a person is on (a set);
 *                                a hint for their studio, never the proof —
 *                                the store's own record is read every time
 *   nl:team:log:<store id>    -> what the team did, newest first, 500 lines
 *
 * Membership is read from the store's record on every request that uses it,
 * so taking someone out, or changing their role, counts from their very next
 * click, whatever sessions they have open.
 *
 * Five people at most per store, invitations still waiting included. The
 * owner is told by email when someone joins and when a role changes
 * (lib/account-notice.ts), because a new pair of hands on a store is exactly
 * what a stolen session would add.
 *
 * Every change to a team is made with the team's lock held (lib/redis-lock
 * .ts), so two changes at the same instant — someone joining while the owner
 * takes somebody else off — are made one after the other. Without it the
 * second would write back the team it read before the first, and a person
 * just taken off could be back on it.
 */
import { type PipelineAccessCopy, PipelineAccessCopyUnconfirmed, copyPipelineAccess, forgetPipelineAccess, undoPipelineAccessCopy, undoUnconfirmedCopy } from "@/lib/pipeline-access";
import { type AccessLog, parseAccessLog } from "@/lib/pipeline-access-rules";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { liveSecondStep } from "@/lib/second-step-gate";
import { NIMBUS_FROM, headerText, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withLock } from "@/lib/redis-lock";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { twoStepOn } from "@/lib/two-step";
import { listPasskeys, pendingRemoval } from "@/lib/passkeys";
import { type Store, STORE_ID_PATTERN, storeForId } from "@/lib/store";
import { type Role, type TeamRole, INVITE_DAYS, ROLE_NAMES, ROLE_SUMMARIES, parseTeamRole } from "@/lib/team-roles";

/** People on one store's team, invitations still waiting included. */
export const MAX_TEAM = 5;
/** How long an invitation works (kept in lib/team-roles.ts, so a page can say it). */
export { INVITE_DAYS };
/** How many lines of the activity log are kept. */
export const LOG_LINES = 500;
/**
 * The most one stored log line weighs, its JSON in UTF-8 bytes (logTeam):
 * with what Redis keeps beside a list entry, within the 512 bytes a line
 * tests/store-data-registry.ts counts for the log.
 */
export const LOG_LINE_BYTES = 448;
/** Invitations one store may send in a day, so an inbox is never flooded from here. */
const INVITES_PER_DAY = 20;

const INVITE_SECONDS = INVITE_DAYS * 24 * 60 * 60;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const INVITE_ID = /^[0-9a-f]{16}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const teamKey = (sid: string) => `nl:team:${sid}`;
const inviteKey = (token: string) => `nl:team:invite:${sha(`nimbus-team-invite:${token}`).slice(0, 40)}`;
const indexKey = (email: string) => `nl:team:of:${sha(`nimbus-team-of:${normaliseEmail(email)}`).slice(0, 40)}`;
const logKey = (sid: string) => `nl:team:log:${sid}`;
const teamLockKey = (sid: string) => `nl:team:lock:${sid}`;

/** Runs one change to a store's team with its lock held: five seconds at most, waiting up to four. */
function withTeam<T>(sid: string, work: () => Promise<T>): Promise<T> {
  return withLock(teamLockKey(sid), 5, 4_000, work);
}

/**
 * Runs work with the team's lock held, for what must see the team as no
 * change half done leaves it (lib/api-key-pause.ts leftTeam: a move between
 * rewriting its keys and saving the team). Never from inside another change
 * to the same team, which already holds the lock.
 */
export function withTeamLock<T>(sid: string, work: () => Promise<T>): Promise<T> {
  return withTeam(sid, work);
}

/**
 * The same lock, for a change outside this file that must see the team as it
 * is while it writes (639 [GL7](7): a teammate's pipeline access, so a
 * sign-in moving at the same moment never leaves the new address without
 * it). Throws LockBusyError when the team stays busy. Never call
 * logTeam or another function of this file that takes the lock inside it.
 */
export function withTeamLocked<T>(sid: string, work: () => Promise<T>): Promise<T> {
  return withTeam(sid, work);
}

export type Member = {
  email: string;
  role: TeamRole;
  /** ISO time they took the invitation. */
  joinedAt: string;
};

export type Invite = {
  /** A short id for this invitation, so it can be taken back; not the token. */
  id: string;
  email: string;
  role: TeamRole;
  createdAt: string;
  /** Seconds since the epoch. */
  expiresAt: number;
};

export type Team = {
  members: Member[];
  invites: Invite[];
  /**
   * The owner requires two-step sign-in (an authenticator app or a passkey)
   * of everybody on the team before they open the studio (612 [WP11]).
   * Absent is off. Kept by every save of the team (saveTeam).
   */
  requireTwoStep?: boolean;
};

export type LogLine = {
  /** ISO time. */
  at: string;
  /** Who did it: their sign-in address. */
  who: string;
  role: Role;
  /** What they did, in a few words. */
  what: string;
  /**
   * A change of a teammate's pipeline access (639 [GL7](7)), by pipeline id:
   * the team page words it with the pipelines' names as they are when shown
   * (accessLogWords), `what` being the same words with the names then.
   */
  access?: AccessLog;
};

const EMPTY: Team = { members: [], invites: [] };

/**
 * A team record as read, keeping only members and invitations the studio accepts (a valid address and role,
 * MAX_TEAM at most); lib/api-keys.ts reads the team with it too. Only null is "no team yet" (a store nobody
 * was invited to). Anything else that is not the record's JSON object (another type, broken JSON, a list, a
 * members or invites field that is not a list, an entry that is not an object, a rule that is not true or
 * false) is unknown and throws UnknownReplyError (CX-123 rule 24): never read as an empty team, which would
 * let a member past the owner's second step, write the team back with nobody on it, or drop the store from
 * a member's index.
 */
export function parseTeam(raw: unknown): Team {
  if (raw === null) return { members: [], invites: [] };
  const unknown = () => new UnknownReplyError("a team record");
  if (typeof raw !== "string") throw unknown();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unknown();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unknown();
  const value = parsed as { members?: unknown; invites?: unknown; requireTwoStep?: unknown };
  // Every team record ever written carries both lists (saveTeam): one without them, or {}, is not an empty team,
  // which would let a member past the owner's second step or be written back with nobody on it (Codex G on #2036).
  for (const entries of [value.members, value.invites]) {
    if (!Array.isArray(entries)) throw unknown();
    for (const entry of entries as unknown[]) if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw unknown();
  }
  if (value.requireTwoStep !== undefined && typeof value.requireTwoStep !== "boolean") throw unknown();
  const members: Member[] = [];
  for (const entry of value.members as Record<string, unknown>[]) {
    const role = parseTeamRole(entry.role);
    if (typeof entry.email !== "string" || !EMAIL_PATTERN.test(entry.email) || !role) continue;
    members.push({ email: normaliseEmail(entry.email), role, joinedAt: typeof entry.joinedAt === "string" ? entry.joinedAt : "" });
  }
  const invites: Invite[] = [];
  for (const entry of value.invites as Record<string, unknown>[]) {
    const role = parseTeamRole(entry.role);
    if (typeof entry.id !== "string" || !INVITE_ID.test(entry.id) || typeof entry.email !== "string" || !role) continue;
    invites.push({
      id: entry.id,
      email: normaliseEmail(entry.email),
      role,
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
      expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : 0,
    });
  }
  const required = value.requireTwoStep === true;
  return { members: members.slice(0, MAX_TEAM), invites: invites.slice(0, MAX_TEAM), ...(required ? { requireTwoStep: true } : {}) };
}

/** The team record's own reply, exactly one for the one GET sent; any other answer is unknown (rule 24). */
async function teamRecord(sid: string): Promise<unknown> {
  const replies = repliesFor(await redisPipeline([["GET", teamKey(sid)]]), 1);
  if (!replies) throw new UnknownReplyError("a team record");
  return replies[0];
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * A store's team as it is now. Invitations past their seven days are left out. A record that cannot be read
 * in its exact shape throws UnknownReplyError (parseTeam): what depends on it refuses instead of acting on
 * an empty team.
 */
export async function readTeam(sid: string): Promise<Team> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return { ...EMPTY };
  const team = parseTeam(await teamRecord(sid));
  return { members: team.members, invites: team.invites.filter((i) => i.expiresAt > now()), ...(team.requireTwoStep ? { requireTwoStep: true } : {}) };
}

/**
 * Writes a team. Every change is made with the team's lock held, so the
 * owner's two-step requirement is read back here and kept unless the change
 * itself says otherwise: a member joining or leaving never switches it off.
 * A record read in an unknown shape throws before anything is written.
 */
async function saveTeam(sid: string, team: Team): Promise<void> {
  let required = team.requireTwoStep;
  if (required === undefined) {
    // Unreadable, nothing is written: the rule is never switched off by a save that could not read it.
    required = parseTeam(await teamRecord(sid)).requireTwoStep === true;
  }
  const kept: Team = { members: team.members, invites: team.invites, ...(required ? { requireTwoStep: true } : {}) };
  await redisPipeline([["SET", teamKey(sid), JSON.stringify(kept)]]);
}

/**
 * Whether the team must use two-step sign-in, and, for one person, whether
 * they may open the studio under it: the owner always may (the requirement is
 * theirs to set); anybody else only in a session that was opened with a
 * second step (lib/second-step-gate.ts liveSecondStep): the app's code, a recovery
 * code, or a passkey used to log in. Owning a passkey or an app is not enough:
 * an emailed link opens a session without either, so a member who has only a
 * passkey and logs in by the link is asked for the second step here. A
 * session read without its id, or opened before this was written down, has
 * none: the answer is to ask for the step, never to let it through.
 * Read only when the requirement is on. A team record that answers in an
 * unknown shape (rule 24) is taken as requiring it: the step is asked for,
 * never skipped because the owner's choice could not be read.
 */
export async function teamTwoStepBlocks(store: Store, email: string, role: Role, session?: string): Promise<boolean> {
  if (role === "owner" || !store.sid) return false;
  const required = await readTeam(store.sid).then(
    (team) => team.requireTwoStep === true,
    (error: unknown) => {
      if (error instanceof UnknownReplyError) return true;
      throw error;
    },
  );
  if (!required) return false;
  return (await liveSecondStep(email, session)) === null;
}

/**
 * The team's members, read exactly (rule 24), for what must never take an
 * unknown answer for "nobody on the team" (lib/visit.ts: a teammate's visit
 * is not a buyer's). No record is no team; a reply in another shape, or text
 * that is not a team record as saveTeam writes it, throws UnknownReplyError.
 */
export async function readTeamMembers(sid: string): Promise<Member[]> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["GET", teamKey(sid)]]), 1);
  if (!replies) throw new UnknownReplyError("a store's team");
  const raw = replies[0];
  if (raw === null) return [];
  let stored: unknown = null;
  try {
    stored = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== "object" || !Array.isArray((stored as { members?: unknown }).members)) throw new UnknownReplyError("a store's team");
  return parseTeam(raw).members;
}

/**
 * What a member held at the team's door does next (teamTwoStepBlocks):
 * "passkey", log in again with the passkey they have; "app", log in again
 * with the emailed link and the app's code; "set_up", add a passkey or turn
 * on an app first. A passkey comes first when they have both, as it asks for
 * nothing to be typed.
 */
export type SecondStepWay = "passkey" | "app" | "set_up";

export async function secondStepWay(email: string, now = Date.now()): Promise<SecondStepWay> {
  // A passkey whose wait to be removed has run out goes first, so it is never offered (lib/passkeys.ts);
  // one still waiting to go is not offered either, as it opens no second step (lib/second-step-gate.ts).
  const waiting = (await pendingRemoval(email, now))?.ids ?? [];
  const [app, all] = await Promise.all([twoStepOn(email), listPasskeys(email)]);
  const keys = all.filter((p) => !waiting.includes(p.id));
  return keys.length > 0 ? "passkey" : app ? "app" : "set_up";
}

/**
 * The words for each way, in plain US English, for the page that holds a
 * member at the door. Logging in again opens a new session in place of this
 * one; nothing typed in another tab is lost, and a save refused there works
 * when it is pressed again.
 */
export const SECOND_STEP_WORDS: Readonly<Record<SecondStepWay, { title: string; body: string; action: string; href: string }>> = {
  passkey: {
    title: "Log in again with your passkey",
    body: "You logged in without your passkey or app code. This store's owner asks everyone on the team to log in with a second step, and your passkey is one. Log in again with it to open the store. Anything you typed in another tab stays there: press Save again once you are back.",
    action: "Log in with your passkey",
    href: "/signin",
  },
  app: {
    title: "Log in again with your app's code",
    body: "You logged in without your second step. This store's owner asks everyone on the team to use one. Log in again: after the emailed link, type the code from your authenticator app. Anything you typed in another tab stays there: press Save again once you are back.",
    action: "Log in again",
    href: "/signin",
  },
  set_up: {
    title: "Set up a second step",
    body: "This store's owner asks everyone on the team to log in with a second step. Add a passkey or turn on an authenticator app below, then log in again with it to open the store. Anything you typed in another tab stays there: press Save again once you are back.",
    action: "Set up a second step",
    href: "#two-step",
  },
};

/** The owner turns the requirement on or off; written into the team's activity log. */
export async function setRequireTwoStep(store: Store, on: boolean, by: string): Promise<boolean> {
  if (!store.sid) return false;
  const sid = store.sid;
  await withTeam(sid, async () => {
    const team = await readTeam(sid);
    await saveTeam(sid, { ...team, requireTwoStep: on });
  });
  await logTeam(sid, { who: by, role: "owner", what: on ? "Required two-step sign-in for the team" : "Stopped requiring two-step sign-in for the team" });
  return true;
}

/**
 * What this person is on this store: its owner, one of its team, or nothing.
 * The owner is whoever the store's own record names, so the answer for them
 * never waits on the team record.
 */
export async function roleIn(store: Store, email: string): Promise<Role | null> {
  const address = normaliseEmail(email);
  if (address === normaliseEmail(store.email)) return "owner";
  if (!store.sid) return null;
  const team = await readTeam(store.sid);
  return team.members.find((m) => m.email === address)?.role ?? null;
}

/**
 * The stores this person is on as one of a team, with their role in each,
 * read from each store's own record. An entry in the index the record no
 * longer agrees with is dropped from the index on the way, only on confirmed
 * absence (rule 24): the team record, read exactly, has no such member (or no
 * record at all), or the store's own record names them its owner. An index
 * that answers in an unknown shape throws; a store whose team answers in an
 * unknown shape, or whose record could not be found, is left out of the list
 * but kept in the index, since storeForId answers null for an unknown reply too.
 */
export async function memberStores(email: string): Promise<{ store: Store; role: TeamRole }[]> {
  if (!isRedisConfigured()) return [];
  const address = normaliseEmail(email);
  const ids = stringList(repliesFor(await redisPipeline([["SMEMBERS", indexKey(address)]]), 1)?.[0]);
  if (!ids) throw new UnknownReplyError("a teammate's stores");
  const list = ids.filter((id) => STORE_ID_PATTERN.test(id));
  const found: { store: Store; role: TeamRole }[] = [];
  const stale: string[] = [];
  for (const sid of list.slice(0, 50)) {
    // A store whose team answers in an unknown shape is left out of this answer and kept in the index: it is
    // neither "on it" nor "gone", and one other store's unreadable record never stops the person's own studio.
    const team = await readTeam(sid).catch((error: unknown) => {
      if (error instanceof UnknownReplyError) return null;
      throw error;
    });
    if (!team) continue;
    const member = team.members.find((m) => m.email === address);
    if (!member) {
      stale.push(sid);
      continue;
    }
    const store = await storeForId(sid);
    if (!store) continue;
    if (normaliseEmail(store.email) !== address) found.push({ store, role: member.role });
    else stale.push(sid);
  }
  if (stale.length) await redisPipeline([["SREM", indexKey(address), ...stale]]).catch(() => {});
  return found.sort((a, b) => a.store.name.localeCompare(b.store.name));
}

/**
 * One log line as stored, never over LOG_LINE_BYTES: a pipeline-access
 * change's details (`access`) are kept only while the line fits, and the
 * line's own words (`what`, which name every pipeline) stay; past that, the
 * words, then the address, are shortened. So the log's room is what the
 * data registry counts, whatever a line holds.
 */
export function logLineRecord(entry: LogLine): string {
  const bytes = (value: LogLine) => Buffer.byteLength(JSON.stringify(value), "utf8");
  let line: LogLine = entry;
  if (bytes(line) > LOG_LINE_BYTES && line.access) line = { at: line.at, who: line.who, role: line.role, what: line.what };
  while (bytes(line) > LOG_LINE_BYTES && line.what.length) line = { ...line, what: [...line.what].slice(0, -8).join("") };
  while (bytes(line) > LOG_LINE_BYTES && line.who.length) line = { ...line, who: [...line.who].slice(0, -8).join("") };
  return JSON.stringify(line);
}

/** Writes one line into a store's activity log. Never throws. */
export async function logTeam(sid: string, line: Omit<LogLine, "at">): Promise<void> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return;
  const entry: LogLine = { at: new Date().toISOString(), who: normaliseEmail(line.who), role: line.role, what: line.what.slice(0, 200), ...(line.access ? { access: line.access } : {}) };
  try {
    await redisPipeline([
      ["LPUSH", logKey(sid), logLineRecord(entry)],
      ["LTRIM", logKey(sid), 0, LOG_LINES - 1],
    ]);
  } catch (error) {
    console.error("writing the team log failed", error);
  }
}

/**
 * The activity log, newest first; null when Redis answered in a shape that cannot be read (rule 24), so the Team page
 * never says "nothing yet". Only Redis's own empty list is none; a line that is itself not readable is skipped, as
 * before, and counted in `skipped`, so a decision that needs every line (a removal's "never taken off") can tell it
 * was not read whole (Claude 4 on #3164).
 */
export async function readLogWhole(sid: string): Promise<{ lines: LogLine[]; skipped: number } | null> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return { lines: [], skipped: 0 };
  const rows = stringList(repliesFor(await redisPipeline([["LRANGE", logKey(sid), 0, LOG_LINES - 1]]), 1)?.[0]);
  if (!rows) return null;
  const lines: LogLine[] = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      const value = JSON.parse(row) as Partial<LogLine>;
      if (typeof value.at !== "string" || typeof value.who !== "string" || typeof value.what !== "string") {
        skipped += 1;
        continue;
      }
      const role: Role = value.role === "owner" ? "owner" : parseTeamRole(value.role) ?? "support";
      const access = parseAccessLog(value.access);
      lines.push({ at: value.at, who: value.who, role, what: value.what, ...(access ? { access } : {}) });
    } catch {
      // A line that cannot be read is skipped, not shown half.
      skipped += 1;
    }
  }
  return { lines, skipped };
}

/** The activity log's readable lines, newest first, for showing; null when it could not be read (readLogWhole). */
export async function readLog(sid: string): Promise<LogLine[] | null> {
  return (await readLogWhole(sid))?.lines ?? null;
}

export type InviteResult =
  | { ok: true; invite: Invite }
  | { ok: false; reason: "shape" | "owner" | "member" | "invited" | "full" | "limited" | "role" | "unsent" };

/**
 * Invites someone onto a store's team and emails them the link.
 *
 * The owner's own address, someone already on the team and someone already
 * invited are refused, and so is a sixth person. The link is the whole key,
 * so only a hash of it is kept, and the email is the one place it exists.
 */
export async function inviteMember(
  store: Store,
  rawEmail: string,
  rawRole: unknown,
  origin: string,
): Promise<InviteResult> {
  const email = normaliseEmail(rawEmail);
  const role = parseTeamRole(rawRole);
  if (!role) return { ok: false, reason: "role" };
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return { ok: false, reason: "shape" };
  if (email === normaliseEmail(store.email)) return { ok: false, reason: "owner" };

  const made = await withTeam(store.sid, async (): Promise<{ ok: true; invite: Invite; token: string } | { ok: false; reason: "member" | "invited" | "full" | "limited" }> => {
    const team = await readTeam(store.sid);
    if (team.members.some((m) => m.email === email)) return { ok: false, reason: "member" };
    if (team.invites.some((i) => i.email === email)) return { ok: false, reason: "invited" };
    if (team.members.length + team.invites.length >= MAX_TEAM) return { ok: false, reason: "full" };

    const counter = `nl:rl:team-invite:${store.sid}`;
    const replies = repliesFor(await redisPipeline([
      ["SET", counter, "0", "EX", 24 * 60 * 60, "NX"],
      ["INCR", counter],
    ]), 2);
    // A count in any other shape is unknown (CX-123 rule 24): no invitation is emailed on it.
    const sent = countOf(replies?.[1]);
    if (sent === null || sent > INVITES_PER_DAY) return { ok: false, reason: "limited" };

    const token = randomBytes(32).toString("hex");
    const invite: Invite = {
      id: sha(`nimbus-team-invite-id:${token}`).slice(0, 16),
      email,
      role,
      createdAt: new Date().toISOString(),
      expiresAt: now() + INVITE_SECONDS,
    };
    await redisPipeline([
      ["SET", inviteKey(token), JSON.stringify({ sid: store.sid, id: invite.id, email, role }), "EX", INVITE_SECONDS],
    ]);
    await saveTeam(store.sid, { members: team.members, invites: [...team.invites, invite] });
    return { ok: true, invite, token };
  });
  if (!made.ok) return made;
  const { invite, token } = made;

  const sentOk = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: NIMBUS_FROM,
    to: email,
    replyTo: store.email,
    subject: headerText(`${store.name} invited you to help run their store`, 200),
    text: [
      `${store.name} (marktmorgen.com/@${store.handle}) invited you to help run their store on Marktmorgen, as ${ROLE_NAMES[role]}.`,
      "",
      `${ROLE_NAMES[role]}: ${ROLE_SUMMARIES[role]}`,
      "",
      "To join, open this link and tap the button:",
      `${origin}/signin/join?token=${token}`,
      "",
      `It works once and stops working in ${INVITE_DAYS} days. There is no password to make: from then on you log in with a link sent to this address, or with a passkey if you add one.`,
      "",
      "If you did not expect this, ignore it and nothing happens.",
    ].join("\n"),
  }).catch(() => false);
  if (!sentOk) {
    // Taken back, so the owner can simply try again rather than wait out the week.
    await revokeInvite(store, invite.id);
    return { ok: false, reason: "unsent" };
  }
  return { ok: true, invite };
}

/** Takes back an invitation that has not been used. */
export async function revokeInvite(store: Store, id: string): Promise<boolean> {
  return withTeam(store.sid, async () => {
    const team = await readTeam(store.sid);
    const invite = team.invites.find((i) => i.id === id);
    if (!invite) return false;
    // The token itself is not known here, only its id; the invitation stops
    // working because joining checks that it is still on the team's list.
    await saveTeam(store.sid, { members: team.members, invites: team.invites.filter((i) => i.id !== id) });
    return true;
  });
}

/** Changes a member's role. Counts from their next click. */
export async function setMemberRole(store: Store, email: string, rawRole: unknown): Promise<{ ok: true; before: TeamRole; role: TeamRole } | { ok: false; reason: "unknown" | "role" | "same" }> {
  const role = parseTeamRole(rawRole);
  if (!role) return { ok: false, reason: "role" };
  const address = normaliseEmail(email);
  // Loaded here, as lib/api-key-pause.ts reads the team through this file.
  const { roleChanged, tellOwnerOfRole, undoPause } = await import("@/lib/api-key-pause");
  return withTeam(store.sid, async () => {
    const team = await readTeam(store.sid);
    const member = team.members.find((m) => m.email === address);
    if (!member) return { ok: false as const, reason: "unknown" as const };
    if (member.role === role) return { ok: false as const, reason: "same" as const };
    // API keys the new role may not hand out wait for the owner (owner C3-100), paused before the role is
    // saved, under the same lock: if this fails, the role is not changed; if the save fails, the pause is undone.
    const paused = await roleChanged(store, address, role);
    try {
      await saveTeam(store.sid, {
        members: team.members.map((m) => (m.email === address ? { ...m, role } : m)),
        invites: team.invites,
      });
    } catch (error) {
      await undoPause(store, paused).catch((undo: unknown) => console.error("undoing the API keys paused for a role change failed", undo));
      throw error;
    }
    return { ok: true as const, before: member.role, role, unrecorded: paused.filter((p) => p.kind === "unrecorded").map((p) => p.name), unmatched: paused.filter((p) => p.kind === "unmatched").map((p) => p.name) };
  }).then(async (result) => {
    // Keys nobody is recorded as making, paused as they may be this teammate's, may be the owner's own: told.
    if (!result.ok) return result;
    const { unrecorded, unmatched, ...done } = result;
    if (unrecorded.length || unmatched.length) await tellOwnerOfRole(store, address, unrecorded, unmatched).catch((error: unknown) => console.error("telling the owner which API keys a role change paused failed", error));
    return done;
  });
}

/**
 * Puts somebody on a store's team without an invitation.
 *
 * Only one store has no owner to send invitations: the demo store, which
 * nobody can sign in to (lib/house-store.ts) and which is put together in
 * code instead (lib/demo-seed.ts). Its Zoom and Google Calendar connections
 * are made in the studio like every creator's, so somebody has to be able to
 * open that studio. This is how that person is put there, and it is called
 * from the demo's own seed and nowhere else.
 *
 * Idempotent: asked twice, the second time writes nothing. The owner is
 * never added, since they are already the owner.
 */
export async function putMember(store: Store, email: string, role: TeamRole): Promise<boolean> {
  const address = normaliseEmail(email);
  if (!EMAIL_PATTERN.test(address) || !store.sid || !isRedisConfigured()) return false;
  if (address === normaliseEmail(store.email)) return false;
  const added = await withTeam(store.sid, async () => {
    const team = await readTeam(store.sid);
    const member = team.members.find((m) => m.email === address);
    if (member && member.role === role) return false;
    if (!member && team.members.length >= MAX_TEAM) return false;
    const members = member
      ? team.members.map((m) => (m.email === address ? { ...m, role } : m))
      : [...team.members, { email: address, role, joinedAt: new Date().toISOString() }];
    await saveTeam(store.sid, { members, invites: team.invites });
    return true;
  });
  if (added) await redisPipeline([["SADD", indexKey(address), store.sid]]).catch(() => {});
  return added;
}

/**
 * A teammate was taken off the team but what they could reach was not all
 * closed after (their API keys paused, the store taken out of their index,
 * their pipeline access forgotten): the removal is to be repeated.
 */
export class KeysNotSwept extends Error {
  constructor() {
    super("The API keys of a teammate taken off the team could not all be paused; repeat the removal.");
    this.name = "KeysNotSwept";
  }
}

/**
 * Takes someone off the team, whether the owner does it or they leave. Every
 * API key they made is paused, whatever the team's two-step rule (owner
 * C3-100, lib/api-key-pause.ts leftTeam): a key outlives the person who made
 * it, and only the owner may revoke it now. Done before the team is written,
 * and again after, so a key they made in between is caught too (one written
 * after that is checked by the route that made it, lib/api-key-pause.ts
 * afterMake). If the first cannot be done, nobody is taken off. If the
 * second cannot, they are off the team but the sweep is not finished: this
 * throws KeysNotSwept, and the route asks for the removal to be repeated,
 * which runs the sweep again even for an address no longer on the team (it
 * then answers false). The owner is emailed which keys were paused and why.
 */
export async function removeMember(store: Store, email: string, options: { repeat?: boolean } = {}): Promise<boolean> {
  const address = normaliseEmail(email);
  // Somebody not on the team is swept only for a removal being repeated (the route reads that from the log):
  // a mistyped address pauses nothing and emails nobody.
  if (!options.repeat && !(await readTeam(store.sid)).members.some((m) => m.email === address)) return false;
  // Loaded here, as lib/api-key-pause.ts reads the team through this file.
  const { leftTeam, tellOwnerOfExit, undoExit } = await import("@/lib/api-key-pause");
  const first = await leftTeam(store, address);
  let removed: boolean;
  let forgot = false;
  try {
    removed = await withTeam(store.sid, async () => {
      const team = await readTeam(store.sid);
      if (!team.members.some((m) => m.email === address)) return false;
      await saveTeam(store.sid, { members: team.members.filter((m) => m.email !== address), invites: team.invites });
      // What they could do with each pipeline (639 [GL7](7)) goes with them, under the same lock, so someone
      // added back at once and restricted again never has that new restriction deleted by this removal.
      forgot = await forgetPipelineAccess(store, address).then(() => true, () => false);
      return true;
    });
  } catch (error) {
    // The team was not written: if they are still on it (read again, under the lock), the first sweep is undone,
    // so nobody stays on the team with keys held for good (owner C3-121). Unreadable, nothing is assumed.
    await undoExit(store, address, first.attempt).catch((undo: unknown) => console.error("undoing the sweep of a removal that did not happen failed", undo));
    throw error;
  }
  let second: Awaited<ReturnType<typeof leftTeam>>;
  try {
    second = await leftTeam(store, address);
  } catch (error) {
    console.error("pausing a former teammate's API keys after taking them off failed; the removal is to be repeated", error);
    throw new KeysNotSwept();
  }
  await tellOwnerOfExit(store, address, { left: [...first.left, ...second.left], unmatched: [...first.unmatched, ...second.unmatched], unrecorded: [...first.unrecorded, ...second.unrecorded] }).catch((error: unknown) =>
    console.error("telling the owner which API keys a teammate leaving paused failed", error),
  );
  // The store leaves their index, and what they could do with each pipeline (639 [GL7](7)) goes with them; a repeat
  // does it again, as a removal whose cleanup failed is repeated. Either failing is said as not finished, never removed.
  // The pipeline access was forgotten under the team's lock above; when that did not happen (it failed, or this is a
  // repeat), it is forgotten here under the lock again, and only while they are not back on the team, so a restriction
  // set for someone added back at once is never deleted by this removal.
  if (removed || options.repeat) {
    try {
      await redisPipeline([["SREM", indexKey(address), store.sid]]);
      if (!forgot) {
        await withTeam(store.sid, async () => {
          if ((await readTeam(store.sid)).members.some((m) => m.email === address)) return;
          await forgetPipelineAccess(store, address);
        });
      }
    } catch (error) {
      console.error("closing a former teammate's index or pipeline access failed; the removal is to be repeated", error);
      throw new KeysNotSwept();
    }
  }
  return removed;
}

/**
 * What an invitation is for, read without spending it, so the page the link
 * opens can say which store and which role before anything happens.
 */
export async function peekInvite(token: string): Promise<{ store: Store; email: string; role: TeamRole } | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", inviteKey(token)]]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const claim = JSON.parse(raw) as { sid?: unknown; id?: unknown; email?: unknown; role?: unknown };
    const role = parseTeamRole(claim.role);
    if (typeof claim.sid !== "string" || typeof claim.email !== "string" || !role) return null;
    const store = await storeForId(claim.sid);
    if (!store) return null;
    const team = await readTeam(store.sid);
    if (!team.invites.some((i) => i.id === claim.id)) return null;
    return { store, email: normaliseEmail(claim.email), role };
  } catch {
    return null;
  }
}

export type JoinResult =
  | { ok: true; store: Store; member: Member }
  | { ok: false; reason: "expired" | "gone" | "full" | "owner" };

/**
 * Spends an invitation and puts its person on the team.
 *
 * The link is deleted first, in one step, so it can only ever be used once
 * however many times it is tapped at the same moment. It then has to still
 * be on the store's list — an invitation the owner took back is dead even if
 * its link was never used — and the team must still have room.
 */
export async function spendInvite(token: string): Promise<JoinResult> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return { ok: false, reason: "expired" };
  const key = inviteKey(token);
  let raw: unknown;
  try {
    [raw] = await redisPipeline([["GETDEL", key]]);
  } catch {
    const [read] = await redisPipeline([["GET", key]]);
    const [removed] = await redisPipeline([["DEL", key]]);
    raw = Number(removed) === 1 ? read : null;
  }
  if (typeof raw !== "string" || !raw) return { ok: false, reason: "expired" };

  let claim: { sid?: unknown; id?: unknown; email?: unknown; role?: unknown };
  try {
    claim = JSON.parse(raw) as typeof claim;
  } catch {
    return { ok: false, reason: "expired" };
  }
  if (typeof claim.sid !== "string" || typeof claim.id !== "string" || typeof claim.email !== "string") {
    return { ok: false, reason: "expired" };
  }
  const store = await storeForId(claim.sid);
  if (!store) return { ok: false, reason: "gone" };
  const email = normaliseEmail(claim.email);
  if (email === normaliseEmail(store.email)) return { ok: false, reason: "owner" };
  const inviteId = claim.id;

  const joined = await withTeam(store.sid, async (): Promise<{ ok: true; member: Member } | { ok: false; reason: "expired" | "full" }> => {
    const team = await readTeam(store.sid);
    const invite = team.invites.find((i) => i.id === inviteId && i.email === email);
    if (!invite) return { ok: false, reason: "expired" };
    const already = team.members.find((m) => m.email === email);
    if (!already && team.members.length >= MAX_TEAM) return { ok: false, reason: "full" };

    const member: Member = already ?? { email, role: invite.role, joinedAt: new Date().toISOString() };
    await saveTeam(store.sid, {
      members: already ? team.members : [...team.members, member],
      invites: team.invites.filter((i) => i.id !== invite.id),
    });
    return { ok: true, member };
  });
  if (!joined.ok) return joined;
  await redisPipeline([["SADD", indexKey(email), store.sid]]);
  return { ok: true, store, member: joined.member };
}

/**
 * Forgets a store's team, its invitations and its log, when the store itself goes. A team that answers in an
 * unknown shape (rule 24) is still forgotten, so the store's deletion goes on; only the teammates' index entries,
 * which could not be read, are left, and memberStores drops each on the confirmed absence that follows.
 */
export async function dropTeam(store: Store): Promise<void> {
  if (!store.sid) return;
  const members = await readTeam(store.sid).then(
    (team) => team.members,
    (error: unknown) => {
      if (error instanceof UnknownReplyError) return [];
      throw error;
    },
  );
  await redisPipeline([
    ...members.map((m) => ["SREM", indexKey(m.email), store.sid]),
    ["DEL", teamKey(store.sid)],
    ["DEL", logKey(store.sid)],
  ]);
}

/**
 * Carries a person's places on other stores' teams to their new address,
 * when they move their account (app/api/auth/move). Without it, moving
 * would quietly take them off every team they are on.
 */
export async function moveMemberships(from: string, to: string): Promise<void> {
  const before = normaliseEmail(from);
  const after = normaliseEmail(to);
  const [ids] = await redisPipeline([["SMEMBERS", indexKey(before)]]);
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && STORE_ID_PATTERN.test(id)) : [];
  // Stores whose membership stayed on the old address: their index entry is kept.
  const stayed: string[] = [];
  for (const sid of list) {
    const store = await storeForId(sid);
    if (!store || normaliseEmail(store.email) === after) continue;
    const role = await withTeam(sid, async () => {
      const team = await readTeam(sid);
      if (!team.members.some((m) => m.email === before) || team.members.some((m) => m.email === after)) return null;
      // What they may do with each pipeline (639 [GL7](7)) is copied to the new address first. If that cannot
      // be confirmed, this store's membership stays on the old address: the new one never has the store without
      // its restrictions.
      let copied: PipelineAccessCopy | null = null;
      try {
        copied = await copyPipelineAccess(store, before, after);
        // The API keys they made follow them (owner C3-100); left behind, they would read as a former teammate's.
        // Cut short, the keys already moved are moved back, so they and the membership stay on the old address together.
        const { movedMaker } = await import("@/lib/api-key-pause");
        await movedMaker(sid, before, after).catch(async (error: unknown) => {
          await movedMaker(sid, after, before).catch((back: unknown) => console.error("moving a teammate's API keys back to their old address failed", back));
          throw error;
        });
      } catch (error) {
        console.error("copying pipeline access or the maker of their API keys failed; the membership stays on the old address", error);
        // A copy that landed goes back too, with its room: the new address keeps only what it had (Codex N, #2036).
        if (copied) await undoPipelineAccessCopy(store, after, copied).catch((undo: unknown) => console.error("putting back the new address's pipeline access failed", undo));
        // One whose write may have landed with its answer lost goes back the same way, from what the copy read under
        // this lock; its room is given back only once that is confirmed (Codex G, #2036).
        else if (error instanceof PipelineAccessCopyUnconfirmed) await undoUnconfirmedCopy(store, after, error).catch((undo: unknown) => console.error("putting back the new address's pipeline access failed", undo));
        stayed.push(sid);
        return null;
      }
      try {
        await saveTeam(sid, { members: team.members.map((m) => (m.email === before ? { ...m, email: after } : m)), invites: team.invites });
      } catch (error) {
        // Not saved: the keys go back to the old address with the membership.
        const { movedMaker } = await import("@/lib/api-key-pause");
        await movedMaker(sid, after, before).catch((back: unknown) => console.error("moving a teammate's API keys back to their old address failed", back));
        throw error;
      }
      // The old address's restrictions go only once the team names the new one, still under the lock, so
      // someone who joins on the old address at once and is restricted never has that restriction deleted.
      await forgetPipelineAccess(store, before).catch((error) => console.error("forgetting the old address's pipeline access failed", error));
      return team.members.find((m) => m.email === before)?.role ?? "support";
    });
    if (!role) continue;
    await redisPipeline([["SADD", indexKey(after), sid]]);
    await logTeam(sid, { who: after, role, what: `Moved their sign-in from ${before}` });
  }
  // The old address keeps only the stores that stayed on it; SREM with no member is an error in Redis, so it is sent only with some.
  const moved = list.filter((sid) => !stayed.includes(sid));
  if (!stayed.length) await redisPipeline([["DEL", indexKey(before)]]);
  else if (moved.length) await redisPipeline([["SREM", indexKey(before), ...moved]]);
}
