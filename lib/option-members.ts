/**
 * The studio's reading of how many members are on each price option
 * (642 [WG2]; app/api/store/option/route.ts, action "count"). Strict: the
 * reply's own fields only, each a safe whole number or null. Anything else,
 * or an option the reply does not name, reads as unknown (null), never 0, so
 * the studio never tells a creator nobody is on a price it could not count.
 */
export type OptionMembers = Readonly<Record<string, number | null>>;

export function readOptionMembers(raw: unknown): OptionMembers | null {
  return readCounts(raw, "members");
}

/**
 * The studio's reading of how many invitations to move here, not yet kept, name each price option (642 [WG2];
 * action "invited"), read exactly as readOptionMembers reads the members.
 */
export function readOptionInvited(raw: unknown): OptionMembers | null {
  return readCounts(raw, "invited");
}

function readCounts(raw: unknown, field: "members" | "invited"): OptionMembers | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const ok = Object.getOwnPropertyDescriptor(raw, "ok");
  const members = Object.getOwnPropertyDescriptor(raw, field);
  if (!ok || !Object.hasOwn(ok, "value") || ok.value !== true || !members || !Object.hasOwn(members, "value")) return null;
  const table: unknown = members.value;
  if (typeof table !== "object" || table === null || Array.isArray(table)) return null;
  const read: Record<string, number | null> = Object.create(null) as Record<string, number | null>;
  for (const key of Object.keys(table)) {
    const field = Object.getOwnPropertyDescriptor(table, key);
    const value: unknown = field && Object.hasOwn(field, "value") ? field.value : undefined;
    read[key] = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return read;
}

/** How many members `members` counts on `optionId`: null when unknown (no reading, or not named in it). */
export function membersOn(members: OptionMembers | null, optionId: string): number | null {
  if (!members || !Object.hasOwn(members, optionId)) return null;
  return members[optionId] ?? null;
}
