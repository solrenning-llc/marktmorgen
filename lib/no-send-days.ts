/**
 * Days without automated marketing emails (383 [TB9], unit 1). Stub for the
 * failing test; the rules come in the next commit.
 */
import { isTimeZone } from "@/lib/call-setup";

export const MAX_NO_SEND_DATES = 60;
export const MAX_WAIT_DAYS = 14;
export type NoSendDays = { timeZone: string; weekdays: number[]; dates: string[] };
export type NoSendProblem = "shape" | "time_zone" | "weekdays" | "dates" | "too_many_dates" | "too_long";
export type NoSendRead = { ok: true; rule: NoSendDays } | { ok: false; why: Exclude<NoSendProblem, "too_long"> } | { ok: false; why: "too_long"; from: string };
export type SendDecision = { send: "now" } | { send: "later"; at: number; day: string } | { send: "unknown" };

export const NO_SEND_PROBLEMS = {
  shape: "",
  time_zone: "",
  weekdays: "",
  dates: "",
  too_many_dates: "",
  too_long: (from: string) => from,
};

export function readNoSendDays(raw: unknown, now: number): NoSendRead {
  void raw;
  void now;
  return { ok: false, why: isTimeZone("UTC") ? "shape" : "time_zone" };
}

export function whenToSend(rule: NoSendDays | "none" | "unknown", purpose: "marketing" | "service", due: number): SendDecision {
  void rule;
  void purpose;
  void due;
  return { send: "now" };
}

export function noSendDaysWords(rule: NoSendDays): string {
  return rule.timeZone;
}
