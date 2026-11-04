/**
 * Discord access (added 11 October 2026): a creator's own Discord server,
 * opened by what buyers pay for on their store. Plain rules, browser-safe;
 * the calls to Discord are in lib/discord.ts, what is kept in
 * lib/discord-store.ts, and who is given what in lib/discord-access.ts.
 *
 * The creator adds Marktmorgen's bot to their server once, and picks for any
 * product up to MAX_PRODUCT_ROLES of the server's roles. A buyer presses
 * "Join the Discord", says yes on Discord's own page, and is put in the
 * server with those roles. While they hold the product — paid and not
 * refunded, a membership still running — they keep them; once they do not,
 * the roles are taken back at the next check, and if the creator asked for
 * it, they are taken out of the server too. The next check is CHECK_HOURS
 * after the last one, run by the half-hourly job (vercel.json), so it comes
 * about every CHECK_HOURS (sooner when a run ran out of time, lib/discord-
 * access.ts checkSoon); while Stripe or Discord cannot be asked, or Discord
 * refuses the bot a role, the person is kept and checked again CHECK_HOURS
 * later, so nothing is promised "within" a time.
 *
 * Nobody types a Discord name anywhere: who a buyer is on Discord is what
 * Discord says when they agree, and which products they hold is read from
 * the creator's own Stripe account, as every other door of the store reads
 * it (lib/community-access.ts).
 */

/** A Discord id: a server, a role, a person. */
export const SNOWFLAKE = /^\d{17,20}$/;
/** The roles one product may give. */
export const MAX_PRODUCT_ROLES = 3;
/** The products of one store that may give roles. */
export const MAX_DISCORD_PRODUCTS = 20;
/** Discord accounts one buyer's address may bring into one store's server. */
export const MAX_ACCOUNTS_PER_ADDRESS = 1;
/** How often everyone given roles is checked again, at most. */
export const CHECK_HOURS = 6;
/**
 * Times a removal from the server is tried again after Discord refused it,
 * one check apart, before the person is forgotten as before: the checks of
 * a person kept are not priced on their own, so the retries stay few.
 */
export const KICK_TRIES = 3;
/**
 * What the bot asks for when it is added to a server: Create Instant Invite
 * (1), which Discord needs to put a person in a server, Kick Members (2),
 * used only when the creator asks for people whose access ended to be taken
 * out, and Manage Roles (268435456), to give and take back the roles. Nothing
 * that reads or writes messages.
 */
export const BOT_PERMISSIONS = String(1 + 2 + 268_435_456);

/** The creator's server, as the store keeps it. */
export type DiscordServer = {
  id: string;
  name: string;
  /** When it was connected, in seconds. */
  at: number;
  /** Take people out of the server, not only their roles, once their access ends. */
  kick: boolean;
};

/** One role of the server, as the studio lists it. */
export type DiscordRole = { id: string; name: string; color: number; position: number; managed: boolean };

export function parseServer(raw: unknown): DiscordServer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !SNOWFLAKE.test(value.id)) return null;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name.slice(0, 100) : "",
    at: Number(value.at) || 0,
    kick: value.kick === true,
  };
}

/** The roles a product gives, cleaned: ids only, no repeats, MAX_PRODUCT_ROLES at most. */
export function cleanRoles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && SNOWFLAKE.test(id)))].slice(0, MAX_PRODUCT_ROLES);
}

/**
 * The roles the bot can give: not the one everybody has (its id is the
 * server's), not one an app manages, and below the bot's own highest role,
 * which is how Discord decides who may give what.
 */
export function assignable(roles: DiscordRole[], serverId: string, botTop: number): DiscordRole[] {
  return roles
    .filter((role) => role.id !== serverId && !role.managed && role.position < botTop)
    .sort((a, b) => b.position - a.position);
}

/** The roles a person should have, from the products they hold now. */
export function rolesFor(held: string[], byProduct: Map<string, string[]>): string[] {
  return [...new Set(held.flatMap((id) => byProduct.get(id) ?? []))];
}

/** What changes for a person, from what they were given to what they should have. */
export function rolesDiff(given: string[], wanted: string[]): { add: string[]; take: string[] } {
  const had = new Set(given);
  const want = new Set(wanted);
  return { add: wanted.filter((id) => !had.has(id)), take: given.filter((id) => !want.has(id)) };
}

/** A role's color, as CSS; Discord's 0 is "no color". */
export function roleColor(color: number): string | null {
  return color > 0 ? `#${color.toString(16).padStart(6, "0")}` : null;
}
