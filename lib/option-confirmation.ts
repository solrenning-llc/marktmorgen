import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** The option route acknowledges a completed write with its own exact boolean. */
export function confirmsOptionWrite(raw: unknown, httpOk: boolean): boolean {
  return httpOk === true && typeof raw === "object" && raw !== null
    && !Array.isArray(raw) && Object.hasOwn(raw, "ok")
    && (raw as { ok?: unknown }).ok === true && !Object.hasOwn(raw, "error");
}

/** Said when the option route did not confirm a change and gave no reason the studio can name. */
export const OPTION_NOT_CONFIRMED = "The price change was not confirmed. Reload to check its status before trying again.";

/**
 * The words for a refused price change: the block's own words first, then the
 * ones every studio form shares (lib/studio-messages.ts: a session let in
 * without its second step, a role, a store gone), never "not confirmed" for a
 * refusal the studio can name.
 */
export function optionRefusalWords(reason: string | null, own: Readonly<Record<string, string>>): string {
  if (reason === null) return OPTION_NOT_CONFIRMED;
  if (Object.hasOwn(own, reason)) return own[reason];
  if (Object.hasOwn(STUDIO_MESSAGES, reason)) return STUDIO_MESSAGES[reason];
  return OPTION_NOT_CONFIRMED;
}
