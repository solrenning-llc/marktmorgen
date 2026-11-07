/**
 * What the studio says about the people a change in bulk left out (#2995 follow-up): approving several applications
 * at once (lib/affiliates.ts decideMany), or changing several affiliates' shares at once (setRatesMany). One plain
 * sentence each, in US English, with what to do next, so nobody is left out in silence behind a count.
 *
 * "cap": the change would let partners and the affiliate commission together pass the 90% cap on one sale
 * (lib/partner-share.ts MAX_COMMITTED_SHARE). "unavailable": it could not be checked or written just now; nothing
 * was saved for that person.
 */
import { MAX_COMMITTED_SHARE } from "@/lib/partner-share";

export type HeldWhy = "cap" | "unavailable";
export type HeldOne = { id: string; email: string; why: HeldWhy };

const TOO_MUCH = `would let partners and affiliates together take more than ${MAX_COMMITTED_SHARE}% of a sale.`;
const NOT_NOW = "We could not check it just now. Try again in a moment.";

/** One sentence for each person left out, in the order given; none when nobody was. */
export function heldLines(held: readonly HeldOne[], what: "approve" | "rate"): string[] {
  return held.map((one) =>
    what === "approve"
      ? one.why === "cap"
        ? `${one.email} is still waiting. Approving them ${TOO_MUCH} Lower a partner's share or the commission first, then approve them.`
        : `${one.email} is still waiting. ${NOT_NOW}`
      : one.why === "cap"
        ? `${one.email} keeps their share. The new one ${TOO_MUCH} Lower a partner's share first.`
        : `${one.email} keeps their share. ${NOT_NOW}`,
  );
}

/** Whatever came back from the route as a list of people left out, made safe to show, or an empty list. */
export function readHeld(raw: unknown): HeldOne[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap((value: unknown) => {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const why = v.why === "cap" || v.why === "unavailable" ? v.why : null;
    return typeof v.id === "string" && typeof v.email === "string" && why ? [{ id: v.id, email: v.email, why }] : [];
  });
}
