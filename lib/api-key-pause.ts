/**
 * What the team's two-step rule, and a teammate leaving, do to API keys (owner
 * C3-100, 4 November 2026).
 *
 * A key made by a teammate in a session opened by the emailed link alone is
 * as strong as that inbox: whoever read the link could have made it. So when
 * the store's owner starts asking the team for a second step (lib/team.ts
 * setRequireTwoStep), every such key is paused: each request with it is
 * refused (lib/api-guard.ts, "key_paused"), and it is never deleted. Whoever
 * made it turns it back on under API keys in the studio, from a session
 * opened with a passkey or an authenticator app's code
 * (app/api/store/api-keys/route.ts, "turn_on"); from then on it is vouched
 * for, and no later switch pauses it again.
 *
 *   - The owner's own keys never change.
 *   - A key made before 4 November 2026 has no record of who made it or how
 *     they logged in. It counts as made without a second step by someone other
 *     than the owner, so it pauses too; the owner, who alone could vouch for
 *     it, may turn it back on with a second step.
 *   - A teammate who leaves the team, or is taken off it, has every key they
 *     made paused at once, whatever the rule and however they logged in
 *     (leftTeam, run by lib/team.ts removeMember), and their fingerprint goes
 *     from those keys. Such a key can never be turned back on, only revoked,
 *     and only by the owner. Under the rule a key whose maker is not on the
 *     team pauses too, vouched for or not.
 *   - Turning the rule off again does not turn any key back on.
 *   - A teammate whose role is changed to one that may no longer hand out
 *     keys (or keys that write) has those keys paused ("role") until the
 *     owner turns them back on.
 *   - What a key added stops with it: the webhook endpoints it added are
 *     sent nothing while it is paused, start again when it is turned back
 *     on, and stop for good when it is revoked. That is read from the key at
 *     every send (lib/webhooks.ts liveEndpoints), never from a mark on the
 *     endpoint, so an endpoint written in the instant its key stopped is
 *     sent nothing either.
 *
 * Every change of a hold is a compare-and-set from what was read
 * (lib/api-keys.ts swapHolds), so two changes at once never undo each other:
 * a key whose maker left ("left") is never turned back on, nor put back to
 * how it was by an undo, nor marked as told.
 *
 * Before the switch is saved, the owner's page shows how many keys and
 * endpoints will pause and whose (pausePreview), and the save is refused when
 * that list changed meanwhile (its stamp, made from the ids), so what was
 * reviewed is what happens (WCAG 3.3.6). Each teammate whose keys paused gets
 * one short email saying how to turn them back on: a key is marked "told"
 * once its email went, so a switch that saved the rule but could not finish
 * pausing or telling finishes when it is pressed again, and nobody is told
 * twice.
 */
import { createHash } from "node:crypto";
import {
  type Hold,
  type KeyHold,
  type KeyMaker,
  type KeyRecord,
  NOT_LEFT,
  claimMaker,
  isPaused,
  keyRecords,
  makerPrint,
  makerPrints,
  revokeKey,
  type PauseWhy,
  pauseWhy,
  rewriteMakers,
  swapHolds,
} from "@/lib/api-keys";
import { MAKER_FORMER, MAKER_UNMATCHED, MAKER_UNRECORDED, type PauseLine, type PausePreview, type ShownKey } from "@/lib/api-key-rules";
import { NIMBUS_FROM, headerText, sendEmail, sendEmailOutcome } from "@/lib/email";
import type { Store } from "@/lib/store";
import { readTeam, roleIn, withTeamLock } from "@/lib/team";
import { type Role, can } from "@/lib/team-roles";
import { endpointsOfKeys } from "@/lib/webhooks";
import { SITE_URL } from "@/lib/site-url";
export type { PauseLine, PausePreview };

/** Who is making a key now, as its record keeps it: the owner, or a teammate's fingerprint on this store; and whether the session has a second step. */
export function makerFor(sid: string, role: Role, email: string, step: boolean): KeyMaker {
  return role === "owner" ? { owner: true, by: "", step } : { owner: false, by: makerPrint(sid, email), step };
}

/** Whose a key is: a teammate's, the owner's, one who left, one whose fingerprint matches nobody on the team, or nobody recorded. */
type Whose = { kind: "member"; email: string } | { kind: "former" } | { kind: "unmatched" } | { kind: "unrecorded" } | { kind: "owner" };

function whoseOf(maker: KeyMaker | null, members: Map<string, string>): Whose {
  if (!maker) return { kind: "unrecorded" };
  if (maker.owner) return { kind: "owner" };
  if (maker.left || !maker.by) return { kind: "former" };
  const email = members.get(maker.by);
  return email ? { kind: "member", email } : { kind: "unmatched" };
}

/**
 * Whether a key is paused when the team's rule is on: one whose maker is not
 * on the team, vouched for or not; else one made without a second step by
 * anyone but the owner, or by somebody never recorded, unless it was turned
 * back on with a second step.
 */
export function pausesUnderRule(key: Pick<KeyRecord, "maker" | "hold">, members: Map<string, string>): boolean {
  const whose = whoseOf(key.maker, members);
  if (whose.kind === "former" || whose.kind === "unmatched") return true;
  if (key.hold === "vouched") return false;
  if (whose.kind === "unrecorded") return true;
  if (whose.kind === "owner") return false;
  return !key.maker?.step;
}

/** The team by every fingerprint each teammate's keys may carry (lib/api-keys.ts makerPrints). */
async function membersByPrint(store: Store): Promise<Map<string, string>> {
  const team = await readTeam(store.sid);
  const out = new Map<string, string>();
  for (const m of team.members) for (const print of makerPrints(store.sid, m.email)) out.set(print, m.email);
  return out;
}

const madeBy = (key: Pick<KeyRecord, "maker">, prints: string[]): boolean => Boolean(key.maker && !key.maker.owner && !key.maker.left && prints.includes(key.maker.by));

const whoWords = (whose: Whose): string =>
  whose.kind === "member" ? whose.email : whose.kind === "unrecorded" ? MAKER_UNRECORDED : whose.kind === "unmatched" ? MAKER_UNMATCHED : MAKER_FORMER;

/** A short stamp of exactly which keys and endpoints a review showed, so a save after either changed is refused. */
function stampOf(keyIds: string[], endpointIds: string[]): string {
  return createHash("sha256").update(`${[...keyIds].sort().join(",")}|${[...endpointIds].sort().join(",")}`).digest("hex").slice(0, 16);
}

/** The keys that would pause if the rule were switched on now, with the endpoints they added, whose they are and a stamp of the list. */
export async function pausePreview(store: Store): Promise<PausePreview> {
  if (!store.sid) return { total: 0, endpoints: 0, untold: 0, stamp: stampOf([], []), people: [] };
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const pausing = keys.filter((k) => !isPaused(k.hold) && pausesUnderRule(k, members));
  const endpoints = await endpointsOfKeys(store, pausing.map((k) => k.id));
  const lines = new Map<string, PauseLine>();
  for (const key of pausing) {
    const whose = whoseOf(key.maker, members);
    const who = whoWords(whose);
    const line = lines.get(who) ?? { who, count: 0, endpoints: 0, emailed: whose.kind === "member" };
    line.count += 1;
    line.endpoints += endpoints.filter((e) => e.key === key.id).length;
    lines.set(who, line);
  }
  // Keys paused before whose makers, still on the team, were not told yet: the next press finishes telling them.
  const untold = keys.filter((k) => k.hold === "paused" && whoseOf(k.maker, members).kind === "member").length;
  return {
    total: pausing.length,
    endpoints: endpoints.length,
    untold,
    stamp: stampOf(pausing.map((k) => k.id), endpoints.map((e) => e.id)),
    people: [...lines.values()],
  };
}

/** What a pause is to do, key by key: the hold it takes and the one it had, so it can be undone exactly. */
export type PausePlan = { id: string; to: Hold; before: KeyHold | null }[];

/**
 * What the rule pauses now: a key whose maker is on the team is held
 * "paused" until they are emailed (tellPaused); one with nobody to tell is
 * "told" at once.
 */
export async function planPause(store: Store): Promise<PausePlan> {
  if (!store.sid) return [];
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  return keys
    .filter((k) => !isPaused(k.hold) && pausesUnderRule(k, members))
    .map((k) => ({ id: k.id, to: whoseOf(k.maker, members).kind === "member" ? ("paused" as const) : ("told" as const), before: k.hold }));
}

const groups = (plan: PausePlan) => {
  const out = new Map<string, { to: Hold; before: KeyHold | null; ids: string[] }>();
  for (const p of plan) {
    const at = `${p.to}|${p.before ?? ""}`;
    const group = out.get(at) ?? { to: p.to, before: p.before, ids: [] };
    group.ids.push(p.id);
    out.set(at, group);
  }
  return [...out.values()];
};

/** Carries a plan out, each key only from the hold it was read with; returns the ids paused. */
export async function applyPause(store: Store, plan: PausePlan): Promise<string[]> {
  const done: string[] = [];
  for (const g of groups(plan)) done.push(...(await swapHolds(store.sid, g.ids, g.to, [g.before])));
  return done;
}

/** Pauses what the rule pauses now; returns how many. Run before the rule is saved and once more after, so a key made in between is caught. */
export async function pauseForRule(store: Store): Promise<number> {
  return (await applyPause(store, await planPause(store))).length;
}

/**
 * Undoes a plan whose rule could not be saved: each key goes back to the hold
 * it had only if it still holds what the plan gave it, so a hold written
 * meanwhile (a teammate leaving, a key told) is never undone. Safe for keys
 * the plan never reached.
 */
export async function undoPause(store: Store, plan: PausePlan): Promise<void> {
  // A key whose hold this code does not know was never changed (swapHolds never matches it), and "unknown" is never written.
  for (const g of groups(plan)) if (g.before !== "unknown") await swapHolds(store.sid, g.ids, g.before, [g.to]);
}

/**
 * A key just made by a teammate, checked again once written, as the studio's
 * door let them in a moment before: if they are no longer on the team, it is
 * theirs who left; if their role no longer allows it, it waits for the owner;
 * if the team's rule turned on and it was made without a second step, it is
 * paused as the switch would have. They are told in the answer that made it.
 */
export async function afterMake(store: Store, id: string, maker: KeyMaker, email: string, write: boolean): Promise<boolean> {
  if (!store.sid || maker.owner) return false;
  const role = await roleIn(store, email);
  if (!role) {
    await leftTeam(store, email);
    return true;
  }
  if (!can(role, "export") || (write && !can(role, "import"))) return (await swapHolds(store.sid, [id], "role", [null])).length > 0;
  if (!(await readTeam(store.sid)).requireTwoStep) return false;
  if (!pausesUnderRule({ maker, hold: null }, await membersByPrint(store))) return false;
  return (await swapHolds(store.sid, [id], "told", [null])).length > 0;
}

/** What one sweep of a teammate leaving paused: theirs, for good; others' whose maker matches nobody on the team; and keys nobody is recorded as having made. */
export type Exit = { left: string[]; unmatched: string[]; unrecorded: string[]; attempt?: ExitAttempt };

/**
 * What a sweep tried to write (owner C3-121), confirmed or not: an answer
 * lost on the way back does not prove nothing was written. Kept so the sweep
 * can be undone exactly, from the very values it would have written, if the
 * removal it belongs to did not happen.
 */
export type ExitAttempt = { theirs: string[]; holds: { id: string; to: Hold; before: KeyHold | null }[] };

/**
 * A teammate left the team or was taken off it (lib/team.ts removeMember,
 * which runs this before and after the team is written): every key they made
 * is held "left", whatever the rule and however they logged in, and their
 * fingerprint goes from those keys. Any other teammate's key whose
 * fingerprint matches nobody on the team now (a secret changed, or a change
 * half done) is held "unmatched", which the owner can turn back on: it is
 * never locked for good on a guess. Every key whose maker was never recorded
 * is paused too, as it may be theirs; the owner may turn it back on. Run with
 * the team's lock held, so it never reads a team in the middle of a move
 * (lib/team.ts moveMemberships). Idempotent: run again, it finds what is left
 * to do. Returns the names of the keys it paused. While the person is still
 * on the team (the pass before the team is written), a failure undoes what
 * the pass wrote, so nobody is left on the team with keys held for good.
 */
export async function leftTeam(store: Store, email: string): Promise<Exit> {
  if (!store.sid) return { left: [], unmatched: [], unrecorded: [] };
  const prints = makerPrints(store.sid, email);
  return withTeamLock(store.sid, async () => {
    const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
    const theirs = keys.filter((k) => madeBy(k, prints));
    const unmatched = unmatchedOf(keys, members, prints);
    const unrecorded = keys.filter((k) => !k.maker && k.hold === null);
    const stillOn = [...members.values()].includes(normalised(email));
    // Every write this pass tries, recorded before it is sent (attempted); what came back confirmed, after.
    const attempt: ExitAttempt = {
      theirs: theirs.map((k) => k.id),
      holds: [
        ...theirs.map((k) => ({ id: k.id, to: "left" as Hold, before: k.hold })),
        ...unmatched.map((k) => ({ id: k.id, to: "unmatched" as Hold, before: k.hold })),
        ...unrecorded.map((k) => ({ id: k.id, to: "told" as Hold, before: k.hold })),
      ],
    };
    const held = new Set<string>();
    const odd = new Set<string>();
    const paused = new Set<string>();
    try {
      // Held first, so the key opens nothing from this moment, whatever happens to the rest.
      for (const id of await swapHolds(store.sid, attempt.theirs, "left", NOT_LEFT)) held.add(id);
      for (const id of await swapHolds(store.sid, unmatched.map((k) => k.id), "unmatched", NOT_UNMATCHED)) odd.add(id);
      for (const id of await swapHolds(store.sid, unrecorded.map((k) => k.id), "told", [null])) paused.add(id);
      if (theirs.length) await rewriteMakers(store.sid, (maker) => (!maker.owner && !maker.left && prints.includes(maker.by) ? { owner: false, by: "", step: maker.step, left: true } : null));
    } catch (error) {
      // Still on the team: everything this pass tried goes back, confirmed or not.
      if (stillOn) await putBack(store, email, attempt);
      throw error;
    }
    return {
      left: theirs.filter((k) => held.has(k.id)).map((k) => k.name),
      unmatched: unmatched.filter((k) => odd.has(k.id)).map((k) => k.name),
      unrecorded: unrecorded.filter((k) => paused.has(k.id)).map((k) => k.name),
      attempt,
    };
  });
}

/**
 * Puts back what a sweep tried (ExitAttempt): the makers first, then each
 * hold, only from the value the sweep would have written, so a hold written
 * since by anything else stays. Best effort, said in the log when it fails.
 */
async function putBack(store: Store, email: string, attempt: ExitAttempt): Promise<void> {
  const print = makerPrint(store.sid, email);
  const theirs = new Set(attempt.theirs);
  await rewriteMakers(store.sid, (maker, id) => (maker.left && theirs.has(id) && print ? { owner: false, by: print, step: maker.step } : null)).catch((back: unknown) =>
    console.error("putting back the maker of a teammate's API keys failed; those keys stay refused until the owner looks", back),
  );
  await undoPause(store, attempt.holds).catch((back: unknown) => console.error("putting back the holds of a sweep failed; those keys stay paused until the owner looks", back));
}

/**
 * Undoes a sweep whose removal did not happen (lib/team.ts removeMember, when
 * writing the team failed): only if the person is, read again under the
 * team's lock, still on the team, so an exit that did happen meanwhile is
 * never undone. Throws when the team cannot be read: nothing is assumed.
 */
export async function undoExit(store: Store, email: string, attempt: ExitAttempt | undefined): Promise<boolean> {
  if (!store.sid || !attempt || (!attempt.theirs.length && !attempt.holds.length)) return false;
  return withTeamLock(store.sid, async () => {
    if (!(await readTeam(store.sid)).members.some((m) => m.email === normalised(email))) return false;
    await putBack(store, email, attempt);
    return true;
  });
}

/** Every hold a key whose maker matches nobody on the team may be moved to "unmatched" from: any but for good, and turned on included. */
const NOT_UNMATCHED: (Hold | null)[] = [null, "paused", "told", "role", "vouched"];

const normalised = (email: string) => email.trim().toLowerCase();

/** Keys whose maker's fingerprint matches nobody on the team now, not the leaver's, not already held for it or for good. */
function unmatchedOf(keys: KeyRecord[], members: Map<string, string>, leaving: string[] = []): KeyRecord[] {
  return keys.filter((k) => !madeBy(k, leaving) && whoseOf(k.maker, members).kind === "unmatched" && k.hold !== "unmatched" && k.hold !== "left" && k.hold !== "unknown");
}


const turnOnHow = (store: Store, origin: string) =>
  `To turn one back on, log in with your passkey or your authenticator app's code, open API keys in the studio (${origin}/studio?store=${store.sid}#api) and press "Turn back on" beside it.`;

/**
 * Tells the store's owner, in one short email, which API keys a teammate
 * leaving paused and why, and how to turn back on the ones that can be: a
 * key nobody is recorded as having made may be the owner's own (made before
 * 4 November 2026), and its integration stops until they do. Nothing is sent
 * when nothing was paused. Returns whether it went.
 */
export async function tellOwnerOfExit(store: Store, who: string, exit: Exit, origin = SITE_URL): Promise<boolean> {
  if (!exit.left.length && !exit.unmatched.length && !exit.unrecorded.length) return true;
  const back = [...exit.unrecorded, ...exit.unmatched].length;
  return sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: headerText(`Some API keys for ${store.name} were paused`, 200),
    text: [
      `${who} is no longer on the team of ${store.name}, so some of the store's API keys were paused. Anything using them is refused until they are turned back on. Nothing was deleted.`,
      ...(exit.unrecorded.length
        ? ["", "Paused because nobody is recorded as having made them (keys made before November 4, 2026). They may be yours:", ...exit.unrecorded.map((name) => `- ${name}`)]
        : []),
      ...(exit.unmatched.length
        ? ["", UNMATCHED_EMAIL, ...exit.unmatched.map((name) => `- ${name}`)]
        : []),
      ...(back ? ["", turnOnHow(store, origin)] : []),
      ...(exit.left.length
        ? ["", "Paused for good, because they were made by someone no longer on the team. You can revoke them there and make new ones:", ...exit.left.map((name) => `- ${name}`)]
        : []),
    ].join("\n"),
  }).catch(() => false);
}

/**
 * Tells the store's owner which keys nobody is recorded as having made were
 * paused because a teammate's role changed: they may be the owner's own.
 */
export async function tellOwnerOfRole(store: Store, who: string, names: string[], unmatched: string[] = [], origin = SITE_URL): Promise<boolean> {
  if (!names.length && !unmatched.length) return true;
  return sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: headerText(`Some API keys for ${store.name} were paused`, 200),
    text: [
      `The role of ${who} on the team of ${store.name} changed, so some of the store's API keys were paused. Anything using them is refused until they are turned back on. Nothing was deleted.`,
      ...(names.length
        ? ["", "Paused because nobody is recorded as having made them (keys made before November 4, 2026), and the new role does not allow such keys. They may be yours:", ...names.map((name) => `- ${name}`)]
        : []),
      ...(unmatched.length ? ["", UNMATCHED_EMAIL, ...unmatched.map((name) => `- ${name}`)] : []),
      "",
      turnOnHow(store, origin),
    ].join("\n"),
  }).catch(() => false);
}

/** How an email names keys whose maker could not be matched to the team, with the likely cause. */
const UNMATCHED_EMAIL =
  "Paused because they could not be linked to anyone on the team, most likely because the server's secret changed. Before turning one back on, check whose it is (its name and when it was last used help), then choose that person:";

/**
 * A teammate's role is about to change (lib/team.ts setMemberRole, inside the
 * team's lock, before the new role is saved): keys their new role may not hand
 * out (any key without "export", one that writes without "import",
 * lib/team-roles.ts) are held "role" until the owner turns them back on, and,
 * as when someone leaves, so are such keys nobody is recorded as having made.
 * Returns what it did, so it can be undone if the role cannot be saved.
 */
export async function roleChanged(store: Store, email: string, role: Role): Promise<(PausePlan[number] & { name: string; kind: "theirs" | "unrecorded" | "unmatched" })[]> {
  if (!store.sid || role === "owner") return [];
  const prints = makerPrints(store.sid, email);
  const over = (k: KeyRecord) => !can(role, "export") || (k.write && !can(role, "import"));
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const plan = [
    ...keys
      .filter((k) => ((madeBy(k, prints) && k.hold !== "role") || (!k.maker && k.hold === null)) && over(k) && k.hold !== "left")
      .map((k) => ({ id: k.id, to: "role" as Hold, before: k.hold, name: k.name, kind: (k.maker ? "theirs" : "unrecorded") as "theirs" | "unrecorded" | "unmatched" })),
    // The same safety net as an exit: a key whose maker matches nobody on the team, turned on before or not, is held again.
    ...unmatchedOf(keys, members).map((k) => ({ id: k.id, to: "unmatched" as Hold, before: k.hold, name: k.name, kind: "unmatched" as const })),
  ];
  const done = new Set(await applyPause(store, plan));
  return plan.filter((p) => done.has(p.id));
}

/** A teammate moved their sign-in address (lib/team.ts moveMemberships): their keys follow them. Throws when that could not be written. */
export async function movedMaker(sid: string, from: string, to: string): Promise<void> {
  const before = makerPrints(sid, from);
  const after = makerPrint(sid, to);
  if (!before.length || !after) return;
  await rewriteMakers(sid, (maker) => (!maker.owner && !maker.left && before.includes(maker.by) && maker.by !== after ? { ...maker, by: after } : null));
}

/** The team's members as they are, with roles, and by fingerprint. */
async function teamNow(store: Store) {
  const team = await readTeam(store.sid);
  const byPrint = new Map<string, string>();
  for (const m of team.members) for (const print of makerPrints(store.sid, m.email)) byPrint.set(print, m.email);
  return { members: team.members, byPrint, rule: team.requireTwoStep === true };
}

/**
 * Who may turn a paused key back on, by why it is paused (lib/api-keys.ts
 * pauseWhy, the gate's own reading): its maker, on the team, for the two-step
 * rule; the owner, for one nobody is recorded as making, one whose maker
 * could not be matched to the team or one its maker's role does not allow;
 * nobody, for one whose maker left or whose hold this code does not know.
 */
function mayTurnOnAs(why: PauseWhy | null, key: KeyRecord, whose: Whose, mine: string[], role: Role): boolean {
  // A hold this code does not know is turned back on by nobody: only revoked (Claude 2 on #3096).
  if (!why || why === "left" || why === "unknown") return false;
  if (why === "rule") return whose.kind === "member" && role !== "owner" && madeBy(key, mine);
  return role === "owner";
}


/** The key list as the studio's panel shows it to this person, newest first. */
export async function shownKeys(store: Store, email: string, role: Role): Promise<ShownKey[]> {
  if (!store.sid) return [];
  // Strict: a list read in another shape throws, so the studio says it could not read the keys (audit SG2, finding 23).
  const [keys, team] = await Promise.all([keyRecords(store.sid, true), teamNow(store)]);
  const mine = makerPrints(store.sid, email);
  return keys
    .map((k): ShownKey => {
      const whose = whoseOf(k.maker, team.byPrint);
      const why = pauseWhy(store.sid, k.maker, k.hold, team.members, k.write, team.rule);
      const byMe = role === "owner" ? whose.kind === "owner" : whose.kind === "member" && madeBy(k, mine);
      const maker = byMe ? "you" : whose.kind === "owner" ? "the owner" : whoWords(whose);
      // One its maker's role still does not allow is not offered: turning it on would change nothing.
      const mayTurnOn = mayTurnOnAs(why, k, whose, mine, role) && (why === "unmatched" || !pauseWhy(store.sid, k.maker, "vouched", team.members, k.write, team.rule));
      const mayRevoke = why !== "left" || role === "owner";
      // For an unmatched or unrecorded key the owner says whose it is: themself, or a teammate whose role allows it.
      const whoseChoices = (why === "unmatched" || why === "unrecorded") && mayTurnOn ? team.members.filter((m) => can(m.role, "export") && (!k.write || can(m.role, "import"))).map((m) => m.email) : [];
      return { id: k.id, name: k.name, hint: k.hint, madeAt: k.madeAt, usedAt: k.usedAt, write: k.write, agent: k.agent, paused: why !== null, maker, mayTurnOn, mayRevoke, why, whoseChoices };
    })
    .sort((a, b) => b.madeAt - a.madeAt);
}

export type TurnOn = "ok" | "unknown" | "not_paused" | "not_yours" | "whose" | "role_disallows";

/**
 * Turns a paused key back on, by who may (mayTurnOnAs), as vouched for. The
 * route has already checked the session's second step. Written only from the
 * hold it was read with, so a teammate leaving at that instant wins. The
 * endpoints it added are sent to again from then on (read at every send).
 *
 * A key whose maker could not be matched to the team, or one nobody is
 * recorded as making, is turned on only once the owner says whose it is
 * (`as`: "owner", or a current teammate's address): its maker is written as
 * that person first, so it is from then on a key of theirs, under their role
 * and gone when they leave (Codex D: turned on with no maker, it was out of
 * reach of every later sweep). One whose
 * maker's role does not allow it is turned on only once the role does.
 */
export async function turnKeyOn(store: Store, email: string, role: Role, id: string, as = ""): Promise<TurnOn> {
  if (!store.sid) return "unknown";
  const [keys, team] = await Promise.all([keyRecords(store.sid), teamNow(store)]);
  const key = keys.find((k) => k.id === id);
  if (!key) return "unknown";
  const why = pauseWhy(store.sid, key.maker, key.hold, team.members, key.write, team.rule);
  if (!why) return "not_paused";
  if (!mayTurnOnAs(why, key, whoseOf(key.maker, team.byPrint), makerPrints(store.sid, email), role)) return "not_yours";
  if (why === "unmatched" || why === "unrecorded") {
    const target = normalised(as);
    const member = team.members.find((m) => m.email === target);
    if (target !== "owner" && !member) return "whose";
    if (member && (!can(member.role, "export") || (key.write && !can(member.role, "import")))) return "role_disallows";
    const maker: KeyMaker = member ? { owner: false, by: makerPrint(store.sid, member.email), step: false } : { owner: true, by: "", step: true };
    if (!maker.owner && !maker.by) return "whose";
    const before = key.maker;
    // Codex D (#2290): one nobody is recorded as making gets a maker too, so a later exit or role change still reaches it.
    const written = before ? (await rewriteMakers(store.sid, (m, at) => (at === id && !m.owner && !m.left && m.by === before.by ? maker : null))).includes(id) : await claimMaker(store.sid, id, maker);
    if (!written) return "not_paused";
  } else if (pauseWhy(store.sid, key.maker, "vouched", team.members, key.write, team.rule)) {
    // Its maker's role (or match) still does not allow it: turning it on would change nothing.
    return "role_disallows";
  }
  return (await swapHolds(store.sid, [id], "vouched", [key.hold])).length ? "ok" : "not_paused";
}

export type Revoke = "ok" | "unknown" | "owner_only";

/** Revokes a key; the endpoints it added stop with it (read at every send). A key whose maker left the team is the owner's alone to revoke. */
export async function revokeChecked(store: Store, role: Role, id: string): Promise<Revoke> {
  if (!store.sid) return "unknown";
  const [keys, team] = await Promise.all([keyRecords(store.sid), teamNow(store)]);
  const key = keys.find((k) => k.id === id);
  if (!key) return "unknown";
  if (pauseWhy(store.sid, key.maker, key.hold, team.members, key.write, team.rule) === "left" && role !== "owner") return "owner_only";
  return (await revokeKey(store.sid, id)) ? "ok" : "unknown";
}

/**
 * One short email to each teammate whose keys are paused and who was not told
 * yet, however many keys, saying how to turn them back on. A person's keys
 * are claimed together, in one step, before the email (paused to told), so
 * two presses at once never email anybody twice, and never mark a key told
 * that was turned back on or left meanwhile; when the email cannot go, they
 * are put back for the next press. An email that may have gone (a timeout,
 * a server error, a throw after the request) leaves them told: it has no key
 * of its own, so the next press would write twice (rule 30, as 283 [HG2]);
 * that person is counted as neither emailed nor waiting, but as uncertain,
 * so the owner's page never calls the confirmed ones everyone (VR item 2).
 * Returns who was written to, how many keys still wait for theirs and how
 * many people's emails could not be confirmed.
 */
export async function tellPaused(store: Store, origin: string): Promise<{ emailed: string[]; waiting: number; uncertain: number }> {
  if (!store.sid) return { emailed: [], waiting: 0, uncertain: 0 };
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const byPerson = new Map<string, KeyRecord[]>();
  const nobody: string[] = [];
  for (const key of keys) {
    if (key.hold !== "paused") continue;
    const whose = whoseOf(key.maker, members);
    // Nobody on the team to tell (the maker left meanwhile): told as it is.
    if (whose.kind !== "member") nobody.push(key.id);
    else byPerson.set(whose.email, [...(byPerson.get(whose.email) ?? []), key]);
  }
  if (nobody.length) await swapHolds(store.sid, nobody, "told", ["paused"]);
  const emailed: string[] = [];
  let waiting = 0;
  let uncertain = 0;
  for (const [email, theirs] of byPerson) {
    const claimed = new Set(await swapHolds(store.sid, theirs.map((k) => k.id), "told", ["paused"]));
    const names = theirs.filter((k) => claimed.has(k.id)).map((k) => k.name);
    if (!names.length) continue;
    const one = names.length === 1;
    const outcome = await sendEmailOutcome({
      meter: { by: "store", store, kind: "email" },
      from: NIMBUS_FROM,
      to: email,
      replyTo: store.email,
      subject: headerText(`Your API ${one ? "key" : "keys"} for ${store.name} ${one ? "is" : "are"} paused`, 200),
      text: [
        `The owner of ${store.name} (marktmorgen.com/@${store.handle}) now asks everyone on the team to log in with a second step: a passkey, or a code from an authenticator app.`,
        "",
        `You made ${one ? "this API key" : `these ${names.length} API keys`} while logged in without one, so ${one ? "it is" : "they are"} paused. Anything using ${one ? "it" : "them"} is refused, and webhook endpoints ${one ? "it" : "they"} added are sent nothing, until you turn ${one ? "it" : "them"} back on. Nothing was deleted.`,
        "",
        ...names.map((name) => `- ${name}`),
        "",
        "To turn a key back on:",
        `1. Log in at ${origin}/signin with your passkey, or with the emailed link and the code from your authenticator app. If you have neither yet, add one under Two-step login in the studio first, then log in again with it.`,
        `2. Open the store's studio: ${origin}/studio?store=${store.sid}#api`,
        '3. Under API keys, press "Turn back on" beside each paused key.',
        "",
        "If you no longer need a key, you can revoke it there instead.",
      ].join("\n"),
    }).catch(() => "uncertain" as const);
    if (outcome === "sent") emailed.push(email);
    else if (outcome === "uncertain") {
      uncertain += 1;
      console.error("an email about paused API keys may have gone; the keys stay told, not emailed again", store.handle);
    } else {
      // Put back for the next press, only where still told by this one.
      waiting += (await swapHolds(store.sid, [...claimed], "paused", ["told"])).length;
    }
  }
  return { emailed, waiting, uncertain };
}
