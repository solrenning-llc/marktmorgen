/**
 * What a studio screen read of a setting before asking to change it (752
 * [CD3], unit 3). The setting's route compares it with what is saved, with
 * the store's write lock held (lib/store.ts, setRecovery, setNextOffer), and
 * refuses with "changed" when another tab, another person or another screen
 * changed it since: the newer value is never written over.
 *
 * Absent (a caller from before this) means no comparison; present but not
 * exactly a setting is not a request ("invalid"). Pure and browser-safe.
 */
export type RecoveryExpect = { enabled: boolean; address: string };
export type NextExpect = { on: boolean; email: boolean };

const record = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;

/** The checkout reminder as the page read it: { enabled, address }. */
export function readRecoveryExpect(raw: unknown): RecoveryExpect | null | "invalid" {
  if (raw === undefined) return null;
  const value = record(raw);
  return value && typeof value.enabled === "boolean" && typeof value.address === "string" ? { enabled: value.enabled, address: value.address } : "invalid";
}

/** The next offer as the page read it: { on, email }. */
export function readNextExpect(raw: unknown): NextExpect | null | "invalid" {
  if (raw === undefined) return null;
  const value = record(raw);
  return value && typeof value.on === "boolean" && typeof value.email === "boolean" ? { on: value.on, email: value.email } : "invalid";
}
