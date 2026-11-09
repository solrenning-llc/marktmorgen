import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";
import { ERASE_TOKEN, MAX_ERASE_STORES } from "@/lib/erasure-rules";

/**
 * Display evidence only: never grants permission to erase or contact anyone.
 * `scheduled` and `by`, when some stores' deletions were scheduled because the month's rights budget is used up
 * (lib/erasure-request.ts, EraseDone.scheduled): how many, and the date (ms) by which they are done by themselves,
 * their legal deadline, so the page says the true date and nothing to press (VR item 2). Absent otherwise.
 */
export type ErasureReceipt = { state: "done" | "more"; count: number; scheduled?: number; by?: number };
const COUNT = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_ERASE_STORES;
/** A deadline a receipt may carry: after the press, and within one month of it (lib/rights-budget-rules.ts, legalDeadline). */
const DEADLINE = (by: unknown, at: number): by is number => Number.isSafeInteger(by) && (by as number) > at && (by as number) <= at + 32 * 86_400_000;
const LIFE_MS = 10 * 60 * 1000;
const binding = (token: string) => createHash("sha256").update(token).digest("hex");
function signature(payload: string): string {
  const key = deriveKey("erasure-result-receipt/v1");
  return key ? createHmac("sha256", key).update(payload).digest("base64url") : "";
}
export function makeErasureReceipt(state: "done" | "more", count: number, token: string, now = Date.now(), waiting: { scheduled: number; by: number } = { scheduled: 0, by: 0 }): string {
  if (!ERASE_TOKEN.test(token) || !Number.isInteger(count) || count < 0 || count > MAX_ERASE_STORES || !Number.isSafeInteger(now) || now < 0) return "";
  const { scheduled, by } = waiting;
  if (!COUNT(scheduled) || (scheduled > 0 && !DEADLINE(by, now)) || (scheduled === 0 && by !== 0)) return "";
  const payload = Buffer.from(JSON.stringify({ state, count, at: now, grant: binding(token), ...(scheduled ? { scheduled, by } : {}) })).toString("base64url");
  const sign = signature(payload);
  return sign ? payload + "." + sign : "";
}
export function readErasureReceipt(raw: unknown, token = "", now = Date.now()): ErasureReceipt | null {
  if (typeof raw !== "string" || raw.length > 512 || !Number.isSafeInteger(now)) return null;
  const parts = raw.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const sign = signature(parts[0]);
  if (!sign || !timingSafeEqual(Buffer.from(sign), Buffer.from(parts[1]))) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!value || (value.state !== "done" && value.state !== "more") || !Number.isInteger(value.count) || value.count < 0 || value.count > MAX_ERASE_STORES ||
        !Number.isSafeInteger(value.at) || value.at < 0 || value.at > now || now - value.at >= LIFE_MS ||
        typeof value.grant !== "string" || !/^[0-9a-f]{64}$/.test(value.grant)) return null;
    if (value.state === "more" && (!ERASE_TOKEN.test(token) || value.grant !== binding(token))) return null;
    const waiting = "scheduled" in value || "by" in value;
    if (waiting && (!COUNT(value.scheduled) || value.scheduled < 1 || !DEADLINE(value.by, value.at))) return null;
    return { state: value.state, count: value.count, ...(waiting ? { scheduled: value.scheduled, by: value.by } : {}) };
  } catch { return null; }
}
