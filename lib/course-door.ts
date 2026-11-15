/**
 * What a course's pages show a signed-in student or a visitor the course is not open to (lib/learn.ts, courseAccess).
 *
 * "unknown" is a student whose access could not be checked just now (Stripe's answer could not be had whole, CX-123
 * rule 24): the course stays shut, and the page says it could not check, with a link that loads it again, never the
 * checkout, the PayPal button, the free preview's pitch or the "already bought" form, which would tell somebody who
 * paid that they have not (owner's approval of this state, 12 November 2026).
 */

type Access = { state: string; learner: { owner: boolean } | null };

/** What the course's front door offers in place of its lessons. */
export type ClosedDoor = "unchecked" | "checkout" | "paypal" | "none";

export function closedDoor(access: Access, selling: boolean, paypal: boolean): ClosedDoor {
  if (access.state === "unknown") return "unchecked";
  return selling ? "checkout" : paypal ? "paypal" : "none";
}

/**
 * Whether a signed-in student's places in this course's videos, and the last lesson kept for their library, go from
 * their device (650 [WG10]): only once their access is known not to be open (a refund, a lost dispute, an ended
 * membership, taken off), never while it could not be checked, nor for the creator.
 */
export function forgetsOnDevice(access: Access): boolean {
  return access.state !== "open" && access.state !== "unknown" && Boolean(access.learner) && !access.learner!.owner;
}
