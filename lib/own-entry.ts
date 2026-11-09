/**
 * The entry of a table that a word from the address names, read only from the
 * table's own keys. A bare index reads Object's prototype too:
 * "?link=constructor" finds Object's own constructor, a function, and a page
 * then shows it as a notice, or a `??` chain stops there before its fallback.
 * Anything but a string (a missing or repeated query parameter) names nothing.
 */
export function ownEntry<O extends object>(table: O, key: unknown): O[keyof O] | undefined {
  return typeof key === "string" && Object.hasOwn(table, key) ? (table as Record<string, O[keyof O]>)[key] : undefined;
}
