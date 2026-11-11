const DAY_MS = 24 * 60 * 60 * 1_000;
const MIN_SEND_TIME_SIGNALS = 3;

export const SEND_TIME_LOOKBACK_DAYS = 90;
export const MAX_SEND_TIME_SIGNALS = 100;

export type SendTimeSignal = {
  at: number;
  kind: "link" | "purchase";
};

export type SendTimeSuggestion = {
  hour: number;
  samples: number;
};

type KnownSignal = SendTimeSignal & { hour: number };

/**
 * Suggests an observed local hour from consented link-use and purchase
 * moments. This rule is deliberately pure: it performs no reads, writes or
 * delivery work, and an insufficient or unreadable sample stays unknown.
 */
export function suggestedSendHour(
  signals: readonly SendTimeSignal[],
  timeZone: string,
  now: number,
): SendTimeSuggestion | null {
  if (!Array.isArray(signals) || !Number.isFinite(now)) return null;
  // Intl uses the host zone for undefined; a person's zone must be explicit.
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) return null;

  let hourFormatter: Intl.DateTimeFormat;
  try {
    hourFormatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
  } catch {
    return null;
  }

  const oldest = now - SEND_TIME_LOOKBACK_DAYS * DAY_MS;
  const known = signals
    .filter((signal): signal is SendTimeSignal => {
      if (!signal || typeof signal !== "object") return false;
      if (signal.kind !== "link" && signal.kind !== "purchase") return false;
      return Number.isFinite(signal.at) && signal.at >= oldest && signal.at <= now;
    })
    .sort((left, right) => right.at - left.at)
    .slice(0, MAX_SEND_TIME_SIGNALS);

  if (known.length < MIN_SEND_TIME_SIGNALS) return null;

  const local: KnownSignal[] = [];
  try {
    for (const signal of known) {
      const hourPart = hourFormatter.formatToParts(new Date(signal.at)).find((part) => part.type === "hour")?.value;
      const hour = Number(hourPart);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
      local.push({ ...signal, hour });
    }
  } catch {
    return null;
  }

  const counts = new Map<number, number>();
  for (const signal of local) counts.set(signal.hour, (counts.get(signal.hour) ?? 0) + 1);

  let bestHour = local[0].hour;
  let bestCount = counts.get(bestHour) ?? 0;
  for (const signal of local) {
    const count = counts.get(signal.hour) ?? 0;
    if (count > bestCount) {
      bestHour = signal.hour;
      bestCount = count;
    }
  }

  return { hour: bestHour, samples: local.length };
}
