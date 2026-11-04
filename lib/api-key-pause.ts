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
  type KeyMaker,
  type KeyRecord,
  NOT_LEFT,
  isPaused,
  keyRecords,
  makerPrint,
  makerPrints,
  revokeKey,
  rewriteMakers,
  swapHolds,
} from "@/lib/api-keys";
import { MAKER_FORMER, MAKER_UNRECORDED, type PauseLine, type PausePreview, type ShownKey } from "@/lib/api-key-rules";
import { NIMBUS_FROM, headerText, sendEmail } from "@/lib/email";
import type { Store } from "@/lib/store";
import { readTeam, roleIn } from "@/lib/team";
import { type Role, can } from "@/lib/team-roles";
import { endpointsOfKeys } from "@/lib/webhooks";
export type { PauseLine, PausePreview };

/** Who is making a key now, as its record keeps it: the owner, or a teammate's fingerprint on this store; and whether the session has a second step. */
export function makerFor(sid: string, role: Role, email: string, step: boolean): KeyMaker {
  return role === "owner" ? { owner: true, by: "", step } : { owner: false, by: makerPrint(sid, email), step };
}

type Whose = { kind: "member"; email: string } | { kind: "former" } | { kind: "unrecorded" } | { kind: "owner" };

function whoseOf(maker: KeyMaker | null, members: Map<string, string>): Whose {
  if (!maker) return { kind: "unrecorded" };
  if (maker.owner) return { kind: "owner" };
  if (maker.left || !maker.by) return { kind: "former" };
  const email = members.get(maker.by);
  return email ? { kind: "member", email } : { kind: "former" };
}

/**
 * Whether a key is paused when the team's rule is on: one whose maker is not
 * on the team, vouched for or not; else one made without a second step by
 * anyone but the owner, or by somebody never recorded, unless it was turned
 * back on with a second step.
 */
export function pausesUnderRule(key: Pick<KeyRecord, "maker" | "hold">, members: Map<string, string>): boolean {
  const whose = whoseOf(key.maker, members);
  if (whose.kind === "former") return true;
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

const whoWords = (whose: Whose): string => (whose.kind === "member" ? whose.email : whose.kind === "unrecorded" ? MAKER_UNRECORDED : MAKER_FORMER);

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
export type PausePlan = { id: string; to: Hold; before: Hold | null }[];

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
  const out = new Map<string, { to: Hold; before: Hold | null; ids: string[] }>();
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
  for (const g of groups(plan)) await swapHolds(store.sid, g.ids, g.before, [g.to]);
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

/**
 * A teammate left the team or was taken off it (lib/team.ts removeMember,
 * which runs this before and after the team is written): every key they made
 * is held "left", whatever the rule and however they logged in, and their
 * fingerprint goes from those keys; every key whose maker was never recorded
 * is paused too, as it may be theirs (the owner may turn it back on). Returns
 * how many keys.
 */
export async function leftTeam(store: Store, email: string): Promise<number> {
  if (!store.sid) return 0;
  const prints = makerPrints(store.sid, email);
  const keys = await keyRecords(store.sid);
  const theirs = keys.filter((k) => madeBy(k, prints)).map((k) => k.id);
  const unrecorded = keys.filter((k) => !k.maker && k.hold === null).map((k) => k.id);
  // Held first, so the key opens nothing from this moment, whatever happens to the rest.
  const held = await swapHolds(store.sid, theirs, "left", NOT_LEFT);
  const paused = await swapHolds(store.sid, unrecorded, "told", [null]);
  if (theirs.length) await rewriteMakers(store.sid, (maker) => (!maker.owner && !maker.left && prints.includes(maker.by) ? { owner: false, by: "", step: maker.step, left: true } : null));
  return held.length + paused.length;
}

/**
 * A teammate's role changed (lib/team.ts setMemberRole): keys their new role
 * may not hand out (any key without "export", one that writes without
 * "import", lib/team-roles.ts) are held "role" until the owner turns them
 * back on. Returns how many.
 */
export async function roleChanged(store: Store, email: string, role: Role): Promise<number> {
  if (!store.sid || role === "owner") return 0;
  const prints = makerPrints(store.sid, email);
  const over = (await keyRecords(store.sid)).filter((k) => madeBy(k, prints) && (!can(role, "export") || (k.write && !can(role, "import")))).map((k) => k.id);
  return (await swapHolds(store.sid, over, "role", [null, "paused", "told", "vouched"])).length;
}

/** A teammate moved their sign-in address (lib/team.ts moveMemberships): their keys follow them. Throws when that could not be written. */
export async function movedMaker(sid: string, from: string, to: string): Promise<void> {
  const before = makerPrints(sid, from);
  const after = makerPrint(sid, to);
  if (!before.length || !after) return;
  await rewriteMakers(sid, (maker) => (!maker.owner && !maker.left && before.includes(maker.by) && maker.by !== after ? { ...maker, by: after } : null));
}

/** Who may turn a paused key back on: its maker, on the team; the owner, for one whose maker is not recorded or that the role paused; nobody, for one whose maker left. */
function mayTurnOnAs(key: KeyRecord, whose: Whose, mine: string[], role: Role): boolean {
  if (!isPaused(key.hold) || key.hold === "left" || whose.kind === "former") return false;
  if (key.hold === "role") return role === "owner";
  if (whose.kind === "unrecorded") return role === "owner";
  return whose.kind === "member" && role !== "owner" && madeBy(key, mine);
}

/** The key list as the studio's panel shows it to this person, newest first. */
export async function shownKeys(store: Store, email: string, role: Role): Promise<ShownKey[]> {
  if (!store.sid) return [];
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const mine = makerPrints(store.sid, email);
  return keys
    .map((k): ShownKey => {
      const whose = whoseOf(k.maker, members);
      const byMe = role === "owner" ? whose.kind === "owner" : whose.kind === "member" && madeBy(k, mine);
      const maker = byMe ? "you" : whose.kind === "owner" ? "the owner" : whoWords(whose);
      const paused = isPaused(k.hold) || Boolean(k.maker?.left);
      const mayTurnOn = mayTurnOnAs(k, whose, mine, role);
      const mayRevoke = whose.kind !== "former" || role === "owner";
      return { id: k.id, name: k.name, hint: k.hint, madeAt: k.madeAt, usedAt: k.usedAt, write: k.write, agent: k.agent, paused, maker, mayTurnOn, mayRevoke };
    })
    .sort((a, b) => b.madeAt - a.madeAt);
}

export type TurnOn = "ok" | "unknown" | "not_paused" | "not_yours";

/**
 * Turns a paused key back on, by who may (mayTurnOnAs). The route has already
 * checked the session's second step. Marked vouched for, only from the hold
 * it was read with, so a teammate leaving at that instant wins. The endpoints
 * it added are sent to again from then on (read at every send).
 */
export async function turnKeyOn(store: Store, email: string, role: Role, id: string): Promise<TurnOn> {
  if (!store.sid) return "unknown";
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const key = keys.find((k) => k.id === id);
  if (!key) return "unknown";
  if (!isPaused(key.hold) && !key.maker?.left) return "not_paused";
  if (!mayTurnOnAs(key, whoseOf(key.maker, members), makerPrints(store.sid, email), role)) return "not_yours";
  return (await swapHolds(store.sid, [id], "vouched", [key.hold])).length ? "ok" : "not_paused";
}

export type Revoke = "ok" | "unknown" | "owner_only";

/** Revokes a key; the endpoints it added stop with it (read at every send). A key whose maker left the team is the owner's alone to revoke. */
export async function revokeChecked(store: Store, role: Role, id: string): Promise<Revoke> {
  if (!store.sid) return "unknown";
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const key = keys.find((k) => k.id === id);
  if (!key) return "unknown";
  if (whoseOf(key.maker, members).kind === "former" && role !== "owner") return "owner_only";
  return (await revokeKey(store.sid, id)) ? "ok" : "unknown";
}

/**
 * One short email to each teammate whose keys are paused and who was not told
 * yet, however many keys, saying how to turn them back on. A person's keys
 * are claimed together, in one step, before the email (paused to told), so
 * two presses at once never email anybody twice, and never mark a key told
 * that was turned back on or left meanwhile; when the email cannot go, they
 * are put back for the next press. Returns who was written to and how many
 * keys still wait for theirs.
 */
export async function tellPaused(store: Store, origin: string): Promise<{ emailed: string[]; waiting: number }> {
  if (!store.sid) return { emailed: [], waiting: 0 };
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
  for (const [email, theirs] of byPerson) {
    const claimed = new Set(await swapHolds(store.sid, theirs.map((k) => k.id), "told", ["paused"]));
    const names = theirs.filter((k) => claimed.has(k.id)).map((k) => k.name);
    if (!names.length) continue;
    const one = names.length === 1;
    const ok = await sendEmail({
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
    }).catch(() => false);
    if (ok) emailed.push(email);
    else {
      // Put back for the next press, only where still told by this one.
      waiting += (await swapHolds(store.sid, [...claimed], "paused", ["told"])).length;
    }
  }
  return { emailed, waiting };
}
