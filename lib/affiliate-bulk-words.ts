/**
 * What the studio says about the people a change in bulk left out (#2995 follow-up): approving several applications
 * at once (lib/affiliates.ts decideMany), or changing several affiliates' shares at once (setRatesMany). One plain
 * sentence each, in US English, with what to do next, so nobody is left out in silence behind a count.
 *
 * "cap": the change would let partners and the affiliate commission together pass the 90% cap on one sale
 * (lib/partner-share.ts MAX_COMMITTED_SHARE). "crowded": approving them would give a product more partners than it
 * may have (MAX_PARTNERS_PER_PRODUCT). "unavailable": it could not be checked or written just now; nothing was saved
 * for that person. "gone": they are no longer on the list. "used": the studio requests the change needs were not
 * taken (used up, or not counted just now), so nothing was read or written for them.
 */
import { MAX_COMMITTED_SHARE, MAX_PARTNERS_PER_PRODUCT } from "@/lib/partner-share";

export type HeldWhy = "cap" | "crowded" | "unavailable" | "gone" | "used";
/** `email` is empty when the server could not read who it is: the studio names them from its own list (readHeld). */
export type HeldOne = { id: string; email: string; why: HeldWhy };

const WHYS: readonly HeldWhy[] = ["cap", "crowded", "unavailable", "gone", "used"];
const TOO_MUCH = `would let partners and affiliates together take more than ${MAX_COMMITTED_SHARE}% of a sale.`;
const NOT_NOW = "We could not check it just now. Try again in a moment.";
const NOT_PAID = "This change needs more of your studio requests than are left, or they could not be counted just now, so nothing was changed for them.";

/** One sentence for each person left out, in the order given; none when nobody was. */
export function heldLines(held: readonly HeldOne[], what: "approve" | "rate"): string[] {
  return held.map((one) => {
    const who = one.email || (what === "approve" ? "One application" : "One affiliate");
    if (one.why === "gone") return `${who} is no longer on your list, so nothing was changed for them.`;
    if (what === "approve") {
      if (one.why === "cap") return `${who} is still waiting. Approving them ${TOO_MUCH} Lower a partner's share or the commission first, then approve them.`;
      if (one.why === "crowded") return `${who} is still waiting. Approving them would give a product more than ${MAX_PARTNERS_PER_PRODUCT} partners. Lower the number of partners on it first, then approve them.`;
      return `${who} is still waiting. ${one.why === "used" ? NOT_PAID : NOT_NOW}`;
    }
    if (one.why === "cap" || one.why === "crowded") return `${who} keeps their share. The new one ${TOO_MUCH} Lower a partner's share first.`;
    return `${who} keeps their share. ${one.why === "used" ? NOT_PAID : NOT_NOW}`;
  });
}

/**
 * Whatever came back from the route as a list of people left out, made safe to show, or an empty list. One the server
 * could not name (an empty address) is named from `known`, the people the studio itself listed.
 */
export function readHeld(raw: unknown, known: readonly { id: string; email: string }[] = []): HeldOne[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap((value: unknown) => {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const why = WHYS.find((one) => one === v.why) ?? null;
    if (typeof v.id !== "string" || typeof v.email !== "string" || !why) return [];
    const id = v.id;
    return [{ id, email: v.email || known.find((one) => one.id === id)?.email || "", why }];
  });
}

/**
 * What an undo in bulk says it did: only those really put back, and how many could not be just now (the Undo stays
 * for them). `what`: "approve" for applications, "rate" for shares.
 */
export function undoWords(undone: number, left: number, what: "approve" | "rate"): string {
  const thing = (n: number) => (what === "approve" ? (n === 1 ? "application" : "applications") : n === 1 ? "share" : "shares");
  const back = undone
    ? `${undone} ${thing(undone)} put back as ${undone === 1 ? "it was" : "they were"}.`
    : left
      ? "Nothing was put back yet."
      : "Nothing to put back: each was changed since.";
  const rest = left ? ` ${left} could not be put back just now. Press Undo again to try once more.` : "";
  return back + rest;
}
