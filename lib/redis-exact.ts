/**
 * Redis replies read exactly (added 5 November 2026, after Codex G's reviews
 * of #2576 and #2584).
 *
 * A deletion that gives room back, or removes the references that find a
 * record, may act only on what Redis confirmed. A pipeline that answered
 * fewer or more replies than it was sent, or a reply of another shape (a
 * hole, a getter, an array-like object, a number where a list was asked),
 * leaves what the command did unknown: it is never read as "nothing was
 * there". The caller throws UnknownReply on, so a person's deletion
 * (lib/person-erasure.ts) reports its module as incomplete and can be run
 * again, with nothing taken for gone and no room given back for it.
 */

import { listSlots } from "@/lib/redis-reply";

/** A reply that is not exactly what was asked for: what the command did is unknown. */
export class UnknownReply extends Error {
  constructor(what: string) {
    super(`Redis answered ${what} with a reply it was not asked for; its outcome is unknown`);
    this.name = "UnknownReply";
  }
}

/**
 * A list as Redis's JSON answers it: a real array whose every place holds a
 * plain value, read without running a getter; null for anything else.
 */
export function plainList(raw: unknown): unknown[] | null {
  // listSlots refuses a Proxy before any reflection, so none of its traps runs (input fuzz, Claude 7): reading its
  // descriptors here ran getOwnPropertyDescriptor, which could answer differently from what a later read sees.
  return listSlots(raw);
}

/** The pipeline's replies, exactly `count` of them, each a plain value, or UnknownReply. */
export function exactReplies(replies: unknown, count: number, what: string): unknown[] {
  const list = plainList(replies);
  if (!list || list.length !== count) throw new UnknownReply(what);
  return list;
}

/** A count Redis answered (DEL, HDEL, SREM and the like): a whole number from zero, or UnknownReply. */
export function replyCount(raw: unknown, what: string): number {
  // Number.isInteger(1e300) is true: past the safe range a count is not exact (input fuzz, Claude 7), as countOf reads it.
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new UnknownReply(what);
  return raw;
}
