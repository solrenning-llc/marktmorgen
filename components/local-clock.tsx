"use client";

import { useSyncExternalStore } from "react";
import { clockWords, utcAndLocal } from "@/lib/local-clock";

const noop = () => () => {};
const ownZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

/** The reader's time zone once the page runs in the browser; "" before (the server's drawing says UTC). */
export function useOwnZone(): string {
  return useSyncExternalStore(noop, ownZone, () => "");
}

/** A time on the reader's own clock, "3:42 PM"; "15:42 UTC" before the page runs. */
export function LocalClock({ ms }: { ms: number }) {
  const zone = useOwnZone();
  return <time dateTime={new Date(ms).toISOString()}>{clockWords(ms, zone || undefined)}</time>;
}

/** "00:00 UTC (9:00 PM your time)": when something comes back, in UTC and on the reader's clock. */
export function UtcAndLocal({ ms }: { ms: number }) {
  const zone = useOwnZone();
  return <time dateTime={new Date(ms).toISOString()}>{utcAndLocal(ms, zone || undefined)}</time>;
}
