/**
 * The unit a download is counted at (lib/store-export.ts, which says why: one
 * studio unit is twenty commands and fifty kilobytes through the database at a
 * studio request's time; a download's reads are counted at fewer commands, and
 * at a megabyte of what they move, which costs about half a unit, the bytes
 * moved and the time to write them out; tests/closing-cost.test.ts holds it).
 * Kept here, with nothing imported, so a route that only needs the unit does
 * not load an export's readers.
 */
export const EXPORT_COMMANDS_PER_UNIT = 16;
export const EXPORT_BYTES_PER_UNIT = 1_000_000;

/** The studio units past the request itself that `commands` commands moving `bytes` bytes take, at that unit. */
export function exportUnitsPast(commands: number, bytes: number): number {
  return Math.ceil(Math.max(0, Math.ceil(commands)) / EXPORT_COMMANDS_PER_UNIT) + Math.ceil(Math.max(0, Math.ceil(bytes)) / EXPORT_BYTES_PER_UNIT);
}
