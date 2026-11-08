/** An expiry classification alone does not establish course access permission. */
export type CourseAccessExpiryState = "unspecified" | "active" | "expired" | "invalid";

function isTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && Math.abs(value) <= 8_640_000_000_000_000;
}

/** Classify an optional expiry against an explicit clock, without coercion or IO. */
export function courseAccessExpiryState(expiresAt: unknown, now: unknown): CourseAccessExpiryState {
  if (!isTimestamp(now)) return "invalid";
  if (expiresAt === undefined || expiresAt === null) return "unspecified";
  if (!isTimestamp(expiresAt)) return "invalid";
  return now < expiresAt ? "active" : "expired";
}
