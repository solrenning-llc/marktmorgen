/**
 * Read-only SES rolling account usage. Request and response timestamps bound
 * latency; they do not establish an exact shared snapshot with Resend. This never authorizes sending; lib/ses.ts remains the only sender
 * admission source.
 */
import { signV4 } from "@/lib/aws-sign";
import { SES_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { sesConfig, sesCredentials } from "@/lib/ses";

export type SesProviderUsage =
  | {
      ok: true;
      sentLast24Hours: number;
      max24: number;
      rate: number;
      production: boolean;
      sending: boolean;
      enforcement: "HEALTHY" | "PROBATION" | "SHUTDOWN";
      requestedAt: string;
      observedAt: string;
    }
  | { ok: false; reason: "not_configured" | "unauthorized" | "provider" | "unknown" };

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

const whole = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const max24 = (value: unknown) =>
  value === -1 || typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value as number
    : null;

const rate = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;

/**
 * Bounds the provider observation between the request and response clocks and
 * returns the SES rolling-24-hour counter observed inside that interval. Unknown shape,
 * credentials or transport never becomes zero.
 */
export async function sesProviderUsage(
  now = Date.now(), clock: () => number = Date.now,
): Promise<SesProviderUsage> {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) return { ok: false, reason: "unknown" };
  const config = sesConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  let key: Awaited<ReturnType<typeof sesCredentials>>;
  try {
    key = await sesCredentials(config, now);
  } catch {
    return { ok: false, reason: "provider" };
  }
  if (!key) return { ok: false, reason: "unauthorized" };

  const url = `https://email.${config.region}.amazonaws.com/v2/email/account`;
  const signed = signV4({
    method: "GET",
    url,
    headers: {},
    region: config.region,
    service: "ses",
    key,
  });
  const { host: _host, ...headers } = signed;
  void _host;

  let result: { status: number; ok: boolean; raw: unknown; malformed: boolean };
  try {
    result = await timed(SES_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, { method: "GET", headers, cache: "no-store", signal });
      let raw: unknown = null;
      let malformed = false;
      if (response.ok) {
        try { raw = await response.json(); } catch { malformed = true; }
      }
      return { status: response.status, ok: response.ok, raw, malformed };
    });
  } catch {
    return { ok: false, reason: "provider" };
  }
  if (result.status === 401 || result.status === 403) return { ok: false, reason: "unauthorized" };
  if (!result.ok) return { ok: false, reason: "provider" };
  if (result.malformed) return { ok: false, reason: "unknown" };

  try {
    const account = dataRecord(result.raw);
    const quota = dataRecord(account?.SendQuota);
    const sent = whole(quota?.SentLast24Hours);
    const maximum = max24(quota?.Max24HourSend);
    const perSecond = rate(quota?.MaxSendRate);
    const enforcement = account?.EnforcementStatus;
    if (!account || !quota || sent === null || maximum === null || perSecond === null ||
        typeof account.ProductionAccessEnabled !== "boolean" ||
        typeof account.SendingEnabled !== "boolean" ||
        enforcement !== "HEALTHY" && enforcement !== "PROBATION" && enforcement !== "SHUTDOWN") {
      return { ok: false, reason: "unknown" };
    }
    const observed = clock();
    if (!Number.isSafeInteger(observed) || observed < now || observed > 8_640_000_000_000_000) return { ok: false, reason: "unknown" };
    return {
      ok: true,
      sentLast24Hours: sent,
      max24: maximum,
      rate: perSecond,
      production: account.ProductionAccessEnabled,
      sending: account.SendingEnabled,
      enforcement,
      requestedAt: new Date(now).toISOString(),
      observedAt: new Date(observed).toISOString(),
    };
  } catch {
    return { ok: false, reason: "unknown" };
  }
}
