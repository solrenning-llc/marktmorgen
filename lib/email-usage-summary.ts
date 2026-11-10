/** A displayable counter, never a guessed zero or extra sending capacity. */
export function confirmedEmailUsage(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
