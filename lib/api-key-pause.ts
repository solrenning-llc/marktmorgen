/**
 * What the team's two-step rule does to API keys (owner C3-100, 4 November
 * 2026).
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
 *     it, may turn it back on with a second step. The owner sees it named so
 *     before saving the switch.
 *   - A key whose maker has left the team pauses and can only be revoked.
 *   - Turning the rule off again does not turn any key back on: a key paused
 *     because nobody proved who made it stays paused until its maker does.
 *
 * Before the switch is saved, the owner's page shows how many keys will pause
 * and whose (pausePreview), and the save is refused when that number changed
 * meanwhile, so what was reviewed is what happens (WCAG 3.3.6). Each teammate
 * whose keys paused gets one short email saying how to turn them back on.
 *
 * Who made a key is kept on the key's record as a one-way fingerprint of the
 * teammate's sign-in address (makerPrint), never the address: it is matched
 * against the team as it is now each time it is shown.
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { type KeyMaker, type KeyRecord, holdKeys, keyRecords } from "@/lib/api-keys";
import { MAKER_FORMER, MAKER_UNRECORDED, type PauseLine, type PausePreview, type ShownKey } from "@/lib/api-key-rules";
export type { PauseLine, PausePreview };
import { NIMBUS_FROM, headerText, sendEmail } from "@/lib/email";
import type { Store } from "@/lib/store";
import { readTeam } from "@/lib/team";
import type { Role } from "@/lib/team-roles";

/** A one-way fingerprint of a teammate's sign-in address, as a key's record keeps it. */
export const makerPrint = (email: string): string =>
  createHash("sha256").update(`nimbus-api-key-by:${normaliseEmail(email)}`).digest("hex").slice(0, 40);

/** Who is making a key now, as its record keeps it: the owner, or a teammate's fingerprint; and whether the session has a second step. */
export function makerFor(role: Role, email: string, step: boolean): KeyMaker {
  return role === "owner" ? { owner: true, by: "", step } : { owner: false, by: makerPrint(email), step };
}

/**
 * Whether a key is paused when the team's rule is on: made without a second
 * step by anyone but the owner, or by somebody never recorded; never one its
 * maker turned back on with a second step.
 */
export function pausesUnderRule(key: Pick<KeyRecord, "maker" | "hold">): boolean {
  if (key.hold === "vouched") return false;
  if (!key.maker) return true;
  if (key.maker.owner) return false;
  return !key.maker.step;
}

type Whose = { kind: "member"; email: string } | { kind: "former" } | { kind: "unrecorded" } | { kind: "owner" };

function whoseOf(key: KeyRecord, members: Map<string, string>): Whose {
  if (!key.maker) return { kind: "unrecorded" };
  if (key.maker.owner) return { kind: "owner" };
  const email = members.get(key.maker.by);
  return email ? { kind: "member", email } : { kind: "former" };
}

async function membersByPrint(store: Store): Promise<Map<string, string>> {
  const team = await readTeam(store.sid);
  return new Map(team.members.map((m) => [makerPrint(m.email), m.email]));
}


function linesOf(keys: KeyRecord[], members: Map<string, string>): PauseLine[] {
  const lines = new Map<string, PauseLine>();
  for (const key of keys) {
    const whose = whoseOf(key, members);
    const who = whose.kind === "member" ? whose.email : whose.kind === "former" ? MAKER_FORMER : MAKER_UNRECORDED;
    const line = lines.get(who) ?? { who, count: 0, emailed: whose.kind === "member" };
    line.count += 1;
    lines.set(who, line);
  }
  return [...lines.values()];
}

/** The keys that would pause if the team's rule were switched on now, and whose they are. Keys already paused are not counted again. */
export async function pausePreview(store: Store): Promise<PausePreview> {
  if (!store.sid) return { total: 0, people: [] };
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const pausing = keys.filter((k) => k.hold !== "paused" && pausesUnderRule(k));
  return { total: pausing.length, people: linesOf(pausing, members) };
}

/**
 * Pauses every key the rule pauses and returns the ones this call paused, with
 * whose they are. Run before the rule is saved and once more after, so a key
 * made in between is caught too; the second run finds nothing in the usual case.
 */
export async function pauseForRule(store: Store): Promise<{ key: KeyRecord; email: string | null }[]> {
  if (!store.sid) return [];
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const pausing = keys.filter((k) => k.hold !== "paused" && pausesUnderRule(k));
  const held = new Set(await holdKeys(store.sid, pausing.map((k) => k.id), "paused"));
  return pausing.filter((k) => held.has(k.id)).map((key) => {
    const whose = whoseOf(key, members);
    return { key, email: whose.kind === "member" ? whose.email : null };
  });
}

/**
 * A key just made by a teammate without a second step, while the rule is on
 * (switched on in the moment between the studio letting them in and the key
 * being written): paused at once, as the switch would have.
 */
export async function pauseIfRuleOn(store: Store, id: string, maker: KeyMaker): Promise<boolean> {
  if (!store.sid || !pausesUnderRule({ maker, hold: null })) return false;
  if (!(await readTeam(store.sid)).requireTwoStep) return false;
  return (await holdKeys(store.sid, [id], "paused")).length > 0;
}

/** The key list as the studio's panel shows it to this person, newest first. */
export async function shownKeys(store: Store, email: string, role: Role): Promise<ShownKey[]> {
  if (!store.sid) return [];
  const [keys, members] = await Promise.all([keyRecords(store.sid), membersByPrint(store)]);
  const mine = makerPrint(email);
  return keys
    .map((k): ShownKey => {
      const whose = whoseOf(k, members);
      const byMe = role === "owner" ? whose.kind === "owner" : k.maker !== null && !k.maker.owner && k.maker.by === mine;
      const maker = byMe
        ? "you"
        : whose.kind === "owner"
          ? "the owner"
          : whose.kind === "member"
            ? whose.email
            : whose.kind === "former"
              ? MAKER_FORMER
              : MAKER_UNRECORDED;
      const paused = k.hold === "paused";
      const mayTurnOn = paused && (byMe || (whose.kind === "unrecorded" && role === "owner"));
      return { id: k.id, name: k.name, hint: k.hint, madeAt: k.madeAt, usedAt: k.usedAt, write: k.write, agent: k.agent, paused, maker, mayTurnOn };
    })
    .sort((a, b) => b.madeAt - a.madeAt);
}

export type TurnOn = "ok" | "unknown" | "not_paused" | "not_yours";

/**
 * Turns a paused key back on, for its maker, or for the owner when nobody was
 * recorded as its maker. The route has already checked the session's second
 * step. Marked vouched for, so no later switch pauses it again.
 */
export async function turnKeyOn(store: Store, email: string, role: Role, id: string): Promise<TurnOn> {
  if (!store.sid) return "unknown";
  const key = (await keyRecords(store.sid)).find((k) => k.id === id);
  if (!key) return "unknown";
  if (key.hold !== "paused") return "not_paused";
  const yours = key.maker ? !key.maker.owner && key.maker.by === makerPrint(email) && role !== "owner" : role === "owner";
  if (!yours) return "not_yours";
  return (await holdKeys(store.sid, [id], "vouched")).length > 0 ? "ok" : "unknown";
}

/**
 * One short email to each teammate whose keys this switch paused, however many
 * keys, saying how to turn them back on. Returns the addresses written to.
 */
export async function tellPaused(store: Store, paused: { key: KeyRecord; email: string | null }[], origin: string): Promise<string[]> {
  const byPerson = new Map<string, string[]>();
  for (const { key, email } of paused) {
    if (!email) continue;
    byPerson.set(email, [...(byPerson.get(email) ?? []), key.name]);
  }
  const sent: string[] = [];
  for (const [email, names] of byPerson) {
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
        `You made ${one ? "this API key" : `these ${names.length} API keys`} while logged in without one, so ${one ? "it is" : "they are"} paused. Anything using ${one ? "it" : "them"} is refused until you turn ${one ? "it" : "them"} back on. Nothing was deleted.`,
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
    if (ok) sent.push(email);
  }
  return sent;
}
