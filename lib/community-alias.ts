/**
 * The name a member is known by to the other members: a public alias, never
 * their key (audit N2, 9 November 2026).
 *
 * A member's key is lib/learn.ts emailKey, an unsalted sha256 of a fixed
 * prefix and their address, the same in every store, and it is what their
 * posts, messages and points are stored under. Handed to other members (in a
 * link, a form, a React key or a client component's props), anybody who knows
 * an address could work it out and confirm that person is a member, follow
 * them from one community to the next, and keep tying their posts to the
 * address after an erasure.
 *
 * So every page and every answer a member's browser gets carries the alias:
 * the key run through AES-256 under a key derived from the deployment's secret
 * and this community's id (one 16-byte block, a keyed permutation). It is:
 *
 *   - the same for one member every time in one community, so a link to them
 *     keeps working and the room can tell who said what;
 *   - different in every community, so two of them cannot be lined up;
 *   - not computable from an address without the server's secret;
 *   - turned back into the key on the server alone, with nothing stored and
 *     nothing read: no new data to keep, copy or erase, and no migration.
 *
 * Unknown fails closed: without the deployment's secret, or for anything that
 * is not a member key or an alias of this community's form, the answer is ""
 * (no link drawn, nobody written to). The creator is "creator" both ways, as
 * everywhere else.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { CREATOR } from "@/lib/community";
import { COMMUNITY_ID } from "@/lib/community-text";
import { deriveKey } from "@/lib/secret-box";

/** A member key as lib/learn.ts emailKey makes it. */
const MEMBER_KEY = /^[0-9a-f]{32}$/;
/** An alias: "m" and 32 hex, so it can never be mistaken for a key. */
export const MEMBER_ALIAS = /^m[0-9a-f]{32}$/;

function cipherKey(id: string): Buffer | null {
  if (!COMMUNITY_ID.test(id)) return null;
  return deriveKey(`community-member-alias/v1/${id}`);
}

/** The alias this community's other members know a member by; CREATOR for the creator; "" when there is none. */
export function aliasOf(id: string, who: string): string {
  if (who === CREATOR) return CREATOR;
  const key = cipherKey(id);
  if (!key || !MEMBER_KEY.test(who)) return "";
  const cipher = createCipheriv("aes-256-ecb", key, null).setAutoPadding(false);
  return `m${Buffer.concat([cipher.update(Buffer.from(who, "hex")), cipher.final()]).toString("hex")}`;
}

/** The member key behind an alias of this community; CREATOR for "creator"; "" for anything else. */
export function memberOfAlias(id: string, alias: string): string {
  if (alias === CREATOR) return CREATOR;
  const key = cipherKey(id);
  if (!key || typeof alias !== "string" || !MEMBER_ALIAS.test(alias)) return "";
  const decipher = createDecipheriv("aes-256-ecb", key, null).setAutoPadding(false);
  return Buffer.concat([decipher.update(Buffer.from(alias.slice(1), "hex")), decipher.final()]).toString("hex");
}

/** Messages of the live room as a member's browser may get them: each author by their alias. */
export function withAliases<T extends { a: string }>(id: string, messages: T[]): T[] {
  return messages.map((message) => ({ ...message, a: aliasOf(id, message.a) }));
}

/** A map keyed by author (names in the live room), keyed by alias instead. */
export function aliasKeyed<V>(id: string, byAuthor: Record<string, V>): Record<string, V> {
  return Object.fromEntries(Object.entries(byAuthor).map(([who, value]) => [aliasOf(id, who), value]));
}
