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
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, headerText, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withLock } from "@/lib/redis-lock";
import { type Store, STORE_ID_PATTERN, storeForId } from "@/lib/store";
import { type Role, type TeamRole, INVITE_DAYS, ROLE_NAMES, ROLE_SUMMARIES, parseTeamRole } from "@/lib/team-roles";

/** People on one store's team, invitations still waiting included. */
export const MAX_TEAM = 5;
/** How long an invitation works (kept in lib/team-roles.ts, so a page can say it). */
export { INVITE_DAYS };
/** How many lines of the activity log are kept. */
export const LOG_LINES = 500;
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

export type Team = { members: Member[]; invites: Invite[] };

export type LogLine = {
  /** ISO time. */
  at: string;
  /** Who did it: their sign-in address. */
  who: string;
  role: Role;
  /** What they did, in a few words. */
  what: string;
};

const EMPTY: Team = { members: [], invites: [] };

function parseTeam(raw: unknown): Team {
  if (typeof raw !== "string" || !raw) return { members: [], invites: [] };
  try {
    const value = JSON.parse(raw) as { members?: unknown; invites?: unknown };
    const members: Member[] = [];
    for (const entry of Array.isArray(value.members) ? value.members : []) {
      const m = entry as Record<string, unknown>;
      const role = parseTeamRole(m.role);
      if (typeof m.email !== "string" || !EMAIL_PATTERN.test(m.email) || !role) continue;
      members.push({ email: normaliseEmail(m.email), role, joinedAt: typeof m.joinedAt === "string" ? m.joinedAt : "" });
    }
    const invites: Invite[] = [];
    for (const entry of Array.isArray(value.invites) ? value.invites : []) {
      const i = entry as Record<string, unknown>;
      const role = parseTeamRole(i.role);
      if (typeof i.id !== "string" || !INVITE_ID.test(i.id) || typeof i.email !== "string" || !role) continue;
      invites.push({
        id: i.id,
        email: normaliseEmail(i.email),
        role,
        createdAt: typeof i.createdAt === "string" ? i.createdAt : "",
        expiresAt: typeof i.expiresAt === "number" ? i.expiresAt : 0,
      });
    }
    return { members: members.slice(0, MAX_TEAM), invites: invites.slice(0, MAX_TEAM) };
  } catch {
    return { members: [], invites: [] };
  }
}

const now = () => Math.floor(Date.now() / 1000);

/** A store's team as it is now. Invitations past their seven days are left out. */
export async function readTeam(sid: string): Promise<Team> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return { ...EMPTY };
  const [raw] = await redisPipeline([["GET", teamKey(sid)]]);
  const team = parseTeam(raw);
  return { members: team.members, invites: team.invites.filter((i) => i.expiresAt > now()) };
}

async function saveTeam(sid: string, team: Team): Promise<void> {
  await redisPipeline([["SET", teamKey(sid), JSON.stringify(team)]]);
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
 * longer agrees with is dropped from the index on the way.
 */
export async function memberStores(email: string): Promise<{ store: Store; role: TeamRole }[]> {
  if (!isRedisConfigured()) return [];
  const address = normaliseEmail(email);
  const [ids] = await redisPipeline([["SMEMBERS", indexKey(address)]]);
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && STORE_ID_PATTERN.test(id)) : [];
  const found: { store: Store; role: TeamRole }[] = [];
  const stale: string[] = [];
  for (const sid of list.slice(0, 50)) {
    const store = await storeForId(sid);
    const member = store ? (await readTeam(sid)).members.find((m) => m.email === address) : undefined;
    if (store && member && normaliseEmail(store.email) !== address) found.push({ store, role: member.role });
    else stale.push(sid);
  }
  if (stale.length) await redisPipeline([["SREM", indexKey(address), ...stale]]).catch(() => {});
  return found.sort((a, b) => a.store.name.localeCompare(b.store.name));
}

/** Writes one line into a store's activity log. Never throws. */
export async function logTeam(sid: string, line: Omit<LogLine, "at">): Promise<void> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return;
  const entry: LogLine = { at: new Date().toISOString(), who: normaliseEmail(line.who), role: line.role, what: line.what.slice(0, 200) };
  try {
    await redisPipeline([
      ["LPUSH", logKey(sid), JSON.stringify(entry)],
      ["LTRIM", logKey(sid), 0, LOG_LINES - 1],
    ]);
  } catch (error) {
    console.error("writing the team log failed", error);
  }
}

/** The activity log, newest first. */
export async function readLog(sid: string): Promise<LogLine[]> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const [rows] = await redisPipeline([["LRANGE", logKey(sid), 0, LOG_LINES - 1]]);
  const lines: LogLine[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const value = JSON.parse(String(row)) as Partial<LogLine>;
      if (typeof value.at !== "string" || typeof value.who !== "string" || typeof value.what !== "string") continue;
      const role: Role = value.role === "owner" ? "owner" : parseTeamRole(value.role) ?? "support";
      lines.push({ at: value.at, who: value.who, role, what: value.what });
    } catch {
      // A line that cannot be read is skipped, not shown half.
    }
  }
  return lines;
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
    const [, sent] = await redisPipeline([
      ["SET", counter, "0", "EX", 24 * 60 * 60, "NX"],
      ["INCR", counter],
    ]);
    if (Number(sent) > INVITES_PER_DAY) return { ok: false, reason: "limited" };

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
  return withTeam(store.sid, async () => {
    const team = await readTeam(store.sid);
    const member = team.members.find((m) => m.email === address);
    if (!member) return { ok: false as const, reason: "unknown" as const };
    if (member.role === role) return { ok: false as const, reason: "same" as const };
    await saveTeam(store.sid, {
      members: team.members.map((m) => (m.email === address ? { ...m, role } : m)),
      invites: team.invites,
    });
    return { ok: true as const, before: member.role, role };
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

/** Takes someone off the team, whether the owner does it or they leave. */
export async function removeMember(store: Store, email: string): Promise<boolean> {
  const address = normaliseEmail(email);
  const removed = await withTeam(store.sid, async () => {
    const team = await readTeam(store.sid);
    if (!team.members.some((m) => m.email === address)) return false;
    await saveTeam(store.sid, { members: team.members.filter((m) => m.email !== address), invites: team.invites });
    return true;
  });
  if (removed) await redisPipeline([["SREM", indexKey(address), store.sid]]).catch(() => {});
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

/** Forgets a store's team, its invitations and its log, when the store itself goes. */
export async function dropTeam(store: Store): Promise<void> {
  if (!store.sid) return;
  const team = await readTeam(store.sid);
  await redisPipeline([
    ...team.members.map((m) => ["SREM", indexKey(m.email), store.sid]),
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
  for (const sid of list) {
    const store = await storeForId(sid);
    if (!store || normaliseEmail(store.email) === after) continue;
    const role = await withTeam(sid, async () => {
      const team = await readTeam(sid);
      if (!team.members.some((m) => m.email === before) || team.members.some((m) => m.email === after)) return null;
      await saveTeam(sid, { members: team.members.map((m) => (m.email === before ? { ...m, email: after } : m)), invites: team.invites });
      return team.members.find((m) => m.email === before)?.role ?? "support";
    });
    if (!role) continue;
    await redisPipeline([["SADD", indexKey(after), sid]]);
    await logTeam(sid, { who: after, role, what: `Moved their sign-in from ${before}` });
  }
  await redisPipeline([["DEL", indexKey(before)]]);
}
