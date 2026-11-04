/** Synthetic orchestration boundary; provider reader tests exercise real HTTP contracts. */
import { timeLeft } from "@/lib/fetch-timeout";
export type Check = { check: string; ok: boolean; detail: string };
export const NIMBUS_FROM = "Marktmorgen <checks@example.test>";
export const control = {
  allowed: true, sender: true, deliveryOk: true, throwLoop: false, throwAccount: false,
  usage: {
    basis: "provider_reported_counters",
    window: { from: "2026-10-31T12:00:00.000Z", through: "2026-11-01T12:00:00.000Z" },
    ses: { ok: false, reason: "provider" },
    resend: { ok: false, reason: "unauthorized" },
    resendAccount: { ok: false, reason: "unknown" },
    alignment: { anchor: "collector_start_utc", exactSameWindow: false, billingUnitsComparable: false },
  },
  calls: [] as string[], notices: [] as { subject: string; text: string }[],
  deadlines: [] as number[], cutoffRoom: [] as number[],
  afterAccount: null as (() => void | Promise<void>) | null,
  afterUsage: null as (() => void | Promise<void>) | null,
};
export async function cronAllowed() { control.calls.push("authorize"); return control.allowed; }
export function isSenderConfigured() { return control.sender; }
export async function sendEmail(message: { subject: string; text: string }) {
  control.calls.push("notice"); control.notices.push(message); return "sent";
}
export async function verifyProviderUsage() {
  control.calls.push("usage");
  await Promise.resolve();
  await control.afterUsage?.();
  return control.usage;
}
export function verifyHostToken(): Check[] {
  control.calls.push("token"); return [{ check: "synthetic token", ok: true, detail: "checked" }];
}
export async function verifyAmazonAccount(): Promise<Check[]> {
  control.calls.push("account");
  await control.afterAccount?.();
  if (control.throwAccount) throw new Error("synthetic account failure");
  return [{ check: "synthetic account", ok: true, detail: "checked" }];
}
export async function verifyMailLoop(deadline: number): Promise<Check[]> {
  control.calls.push("loop"); control.deadlines.push(deadline);
  control.cutoffRoom.push(timeLeft());
  if (control.throwLoop) throw new Error("synthetic loop failure");
  return [{ check: "synthetic delivery loop", ok: control.deliveryOk, detail: "checked" }];
}
