import { REPORT_PROBLEMS } from "@/lib/takedown-rules";

/** `kept`: the notice is saved, but the server could not confirm it reached the team (lib/takedown.ts, "unsure"). */
export type ReportAnswer = { ok: true; kept?: true } | { ok: false; message: string };
const UNCONFIRMED = "It could not be sent just now. Try again in a moment, or email support@marktmorgen.com.";

/** Only confirmed receipt may replace the person's notice with a success screen. */
export function reportAnswer(httpOK: boolean, raw: unknown): ReportAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: UNCONFIRMED };
  const data = raw as Record<string, unknown>;
  if (httpOK && data.ok === true && data.error === undefined && data.problem === undefined) return data.kept === true ? { ok: true, kept: true } : { ok: true };
  if (data.ok === false && data.error === "problem" && typeof data.problem === "string" && Object.hasOwn(REPORT_PROBLEMS, data.problem)) {
    return { ok: false, message: REPORT_PROBLEMS[data.problem as keyof typeof REPORT_PROBLEMS] };
  }
  if (data.ok === false && data.error === "limited" && data.problem === undefined) {
    return { ok: false, message: "Too many notices from this connection in the last hour. Try again later, or email support@marktmorgen.com." };
  }
  return { ok: false, message: UNCONFIRMED };
}
