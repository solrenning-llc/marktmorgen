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
 *   - What a key added stops with it: the webhook endpoints it added
 *     (lib/webhooks.ts holdEndpointsOfKeys) are sent nothing while it is
 *     paused, start again when it is turned back on, and stop for good when
 *     it is revoked.
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
  holdKeys,
  isPaused,
  keyRecords,
  makerPrint,
  restoreHolds,
  revokeKey,
  rewriteMakers,
} from "@/lib/api-keys";
import { MAKER_FORMER, MAKER_UNRECORDED, type PauseLine, type PausePreview, type ShownKey } from "@/lib/api-key-rules";
import { NIMBUS_FROM, headerText, sendEmail } from "@/lib/email";
import type { Store } from "@/lib/store";
import { readTeam } from "@/lib/team";
import type { Role } from "@/lib/team-roles";
import { endpointsOfKeys, holdEndpointsOfKeys } from "@/lib/webhooks";
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
 * anyone but the owner, or by somebody never recorded, unless its maker
 * turned it back on with a second step.
 */
export function pausesUnderRule(key: Pick<KeyRecord, "maker" | "hold">, members: Map<string, string>): boolean {
  const whose = whoseOf(key.maker, members);
  if (whose.kind === "former") return true;
  if (key.hold === "vouched") return false;
  if (whose.kind === "unrecorded") return true;
  if (whose.kind === "owner") return false;
  return !key.maker?.step;
}

async function membersByPrint(store: Store): Promise<Map<string, string>> {
  const team = await readTeam(store.sid);
  return new Map(team.members.map((m) => [makerPrint(store.sid, m.email), m.email] as [string, string]).filter(([print]) => print !== ""));
}

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
  const endpoints = (await endpointsOfKeys(store, pausing.map((k) => k.id))).filter((e) => !e.held);
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

/** What one pause did, to be told about or undone. */
export type Paused = { key: KeyRecord; email: string | null; before: Hold | null }[];

/**
 * Pauses every key the rule pauses, and the endpoints they added, and
 * returns the keys this call paused. A key whose maker is on the team is
 * held "paused" until they are emailed (tellPaused); one with nobody to tell
 * is "told" at once. Run before the rule is saved and once more after, so a
 * key made in between is caught too.
 */
export async function pauseForRule(store: Store): Promise<Paused> {
  if (!store.sid) return [];
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const pausing = keys
    .filter((k) => !isPaused(k.hold) && pausesUnderRule(k, members))
    .map((key) => {
      const whose = whoseOf(key.maker, members);
      return { key, email: whose.kind === "member" ? whose.email : null, before: key.hold };
    });
  if (!pausing.length) return [];
  const toTell = pausing.filter((p) => p.email).map((p) => p.key.id);
  const nobody = pausing.filter((p) => !p.email).map((p) => p.key.id);
  const held = new Set([...(await holdKeys(store.sid, toTell, "paused")), ...(await holdKeys(store.sid, nobody, "told"))]);
  const done = pausing.filter((p) => held.has(p.key.id));
  await holdEndpointsOfKeys(store, done.map((p) => p.key.id), "paused");
  return done;
}

/** Undoes a pause whose rule could not be saved: each key's hold as it was, and its endpoints let go. */
export async function undoPause(store: Store, paused: Paused): Promise<void> {
  if (!store.sid || !paused.length) return;
  await restoreHolds(store.sid, paused.map((p) => ({ id: p.key.id, hold: p.before })));
  await holdEndpointsOfKeys(store, paused.map((p) => p.key.id), null);
}

/**
 * A key just made by a teammate without a second step, while the rule is on
 * (switched on in the moment between the studio letting them in and the key
 * being written): paused at once, as the switch would have. They are told in
 * the answer that made it, so it counts as told.
 */
export async function pauseIfRuleOn(store: Store, id: string, maker: KeyMaker): Promise<boolean> {
  if (!store.sid) return false;
  if (!(await readTeam(store.sid)).requireTwoStep) return false;
  if (!pausesUnderRule({ maker, hold: null }, await membersByPrint(store))) return false;
  return (await holdKeys(store.sid, [id], "told")).length > 0;
}

/**
 * A teammate left the team or was taken off it (lib/team.ts removeMember):
 * every key they made is paused, whatever the rule and however they logged
 * in, with the endpoints it added, and their fingerprint goes from those
 * keys. Returns how many keys.
 */
export async function leftTeam(store: Store, email: string): Promise<number> {
  if (!store.sid) return 0;
  const print = makerPrint(store.sid, email);
  if (!print) return 0;
  const theirs = (await keyRecords(store.sid)).filter((k) => k.maker && !k.maker.owner && k.maker.by === print).map((k) => k.id);
  if (!theirs.length) return 0;
  // Paused first, so the key opens nothing from this moment, whatever happens to the rest.
  await holdKeys(store.sid, theirs, "told");
  await holdEndpointsOfKeys(store, theirs, "paused");
  await rewriteMakers(store.sid, (maker) => (!maker.owner && maker.by === print ? { owner: false, by: "", step: maker.step, left: true } : null));
  return theirs.length;
}

/** A teammate moved their sign-in address (lib/team.ts moveMemberships): their keys follow them. */
export async function movedMaker(sid: string, from: string, to: string): Promise<void> {
  const before = makerPrint(sid, from);
  const after = makerPrint(sid, to);
  if (!before || !after || before === after) return;
  await rewriteMakers(sid, (maker) => (!maker.owner && maker.by === before ? { ...maker, by: after } : null));
}

/** The key list as the studio's panel shows it to this person, newest first. */
export async function shownKeys(store: Store, email: string, role: Role): Promise<ShownKey[]> {
  if (!store.sid) return [];
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const mine = makerPrint(store.sid, email);
  return keys
    .map((k): ShownKey => {
      const whose = whoseOf(k.maker, members);
      const byMe = role === "owner" ? whose.kind === "owner" : whose.kind === "member" && mine !== "" && k.maker?.by === mine;
      const maker = byMe ? "you" : whose.kind === "owner" ? "the owner" : whoWords(whose);
      const paused = isPaused(k.hold);
      const mayTurnOn = paused && whose.kind !== "former" && (byMe || (whose.kind === "unrecorded" && role === "owner"));
      const mayRevoke = whose.kind !== "former" || role === "owner";
      return { id: k.id, name: k.name, hint: k.hint, madeAt: k.madeAt, usedAt: k.usedAt, write: k.write, agent: k.agent, paused, maker, mayTurnOn, mayRevoke };
    })
    .sort((a, b) => b.madeAt - a.madeAt);
}

export type TurnOn = "ok" | "unknown" | "not_paused" | "not_yours";

/**
 * Turns a paused key back on, for its maker while they are on the team, or
 * for the owner when nobody was recorded as its maker; never one whose maker
 * left. The route has already checked the session's second step. Marked
 * vouched for, so no later switch pauses it again, and the endpoints it
 * added are sent to again.
 */
export async function turnKeyOn(store: Store, email: string, role: Role, id: string): Promise<TurnOn> {
  if (!store.sid) return "unknown";
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const key = keys.find((k) => k.id === id);
  if (!key) return "unknown";
  if (!isPaused(key.hold)) return "not_paused";
  const whose = whoseOf(key.maker, members);
  const mine = makerPrint(store.sid, email);
  const yours = whose.kind === "member" ? role !== "owner" && mine !== "" && key.maker?.by === mine : whose.kind === "unrecorded" && role === "owner";
  if (!yours) return "not_yours";
  if (!(await holdKeys(store.sid, [id], "vouched")).length) return "unknown";
  await holdEndpointsOfKeys(store, [id], null);
  return "ok";
}

export type Revoke = "ok" | "unknown" | "owner_only";

/**
 * Revokes a key, and stops for good the endpoints it added (held first, so
 * nothing more is sent to them whatever happens to the revocation). A key
 * whose maker left the team is the owner's alone to revoke.
 */
export async function revokeWithEndpoints(store: Store, role: Role, id: string): Promise<Revoke> {
  if (!store.sid) return "unknown";
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const key = keys.find((k) => k.id === id);
  if (!key) return "unknown";
  if (whoseOf(key.maker, members).kind === "former" && role !== "owner") return "owner_only";
  await holdEndpointsOfKeys(store, [id], "revoked");
  return (await revokeKey(store.sid, id)) ? "ok" : "unknown";
}

/**
 * One short email to each teammate whose keys are paused and who was not told
 * yet, however many keys, saying how to turn them back on; each key is marked
 * told once its email went. Returns who was written to and how many keys
 * still wait for theirs (an email that could not go is tried at the next press).
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
  if (nobody.length) await holdKeys(store.sid, nobody, "told");
  const emailed: string[] = [];
  let waiting = 0;
  for (const [email, theirs] of byPerson) {
    const names = theirs.map((k) => k.name);
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
    if (ok) {
      emailed.push(email);
      await holdKeys(store.sid, theirs.map((k) => k.id), "told");
    } else waiting += theirs.length;
  }
  return { emailed, waiting };
}
