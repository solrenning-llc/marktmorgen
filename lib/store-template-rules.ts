/** 379 [TB5], unit 1: stub for the failing test; the rules come in the next commit. */
export type ScrubKind = "link" | "key" | "email" | "phone";
export const TEMPLATE_FIELD_MAX_CHARS = 0;
export const TEMPLATE_MARKS: Record<ScrubKind, string> = { link: "", key: "", email: "", phone: "" };
export type ScrubCounts = Record<ScrubKind, number>;
export type Scrubbed = { ok: true; text: string; removed: ScrubCounts } | { ok: false; why: "not_text" | "too_long" | "unchecked" };
export function scrubTemplateText(text: string): Scrubbed {
  void text;
  return { ok: false, why: "unchecked" };
}
export function scrubTemplateUrl(url: string): { ok: true; url: string | null } | { ok: false; why: "not_text" } {
  void url;
  return { ok: false, why: "not_text" };
}
export function templateScrubSummary(removed: ScrubCounts): string {
  void removed;
  return "";
}
