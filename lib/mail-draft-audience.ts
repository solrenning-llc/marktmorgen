import { readNarrow, type Narrow, sameNarrow } from "@/lib/segments-rules";
import { readTags } from "@/lib/contact-rules";
/** `label`: only people who carry it (99 [E2-TAG-BROADCAST]); absent for none, as on every draft saved before it. */
export type DraftAudience = { who: "all" | "buyers" | "leads"; notProductId: string | null; narrow: Narrow | null; label?: string };
/** Audience restrictions are explicit; malformed values must never become a broader group. */
export function readDraftAudience(raw: unknown): DraftAudience | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.who !== "all" && value.who !== "buyers" && value.who !== "leads") return null;
  if (!(value.notProductId === null || typeof value.notProductId === "string" && value.notProductId.length > 0)) return null;
  let narrow: Narrow | null = null;
  if (value.narrow !== null) {
    if (!value.narrow || typeof value.narrow !== "object" || Array.isArray(value.narrow)) return null;
    const n = value.narrow as Record<string, unknown>;
    narrow = readNarrow(n);
    if (!sameNarrow(n, narrow)) return null;
  }
  // Absent (or null) for none; otherwise a label exactly as an email keeps one.
  if (value.label !== undefined && value.label !== null && (typeof value.label !== "string" || readTags([value.label])[0] !== value.label)) return null;
  const label = typeof value.label === "string" ? value.label : "";
  return { who: value.who, notProductId: value.notProductId, narrow, ...(label ? { label } : {}) };
}
export function sameDraftAudience(left: unknown, right: unknown): boolean {
  const a = readDraftAudience(left), b = readDraftAudience(right);
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}
