/**
 * A time as the reader's own clock says it (inbox C4-33): "3:42 PM" in the
 * browser's zone, or, where no zone is known (the server's first drawing),
 * "15:42 UTC". Pure; the page decides when it runs in the browser.
 */
export function clockWords(ms: number, zone?: string, locale = "en-US"): string {
  if (!zone) {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  }
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(ms));
  } catch {
    return clockWords(ms);
  }
}

/** "00:00 UTC (9:00 PM your time)", or only "00:00 UTC" when the reader's zone is UTC or unknown. */
export function utcAndLocal(ms: number, zone?: string, locale = "en-US"): string {
  const utc = clockWords(ms);
  if (!zone || zone === "UTC" || zone === "Etc/UTC") return utc;
  return `${utc} (${clockWords(ms, zone, locale)} your time)`;
}

/** The next 00:00 UTC after `now`, in milliseconds: when a UTC day's counts come back. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** The reader's own time zone in a browser, or undefined. */
export function browserZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
