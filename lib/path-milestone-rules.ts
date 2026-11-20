/**
 * 654 [WG14], part (b1): a sober milestone for each step on the Path that the
 * store's own records show done (lib/path-rules.ts missions, recomputed from
 * lib/path-facts.ts on every visit, so a sale fully refunded is no longer a
 * done mission and gets no card). Each is shown once, one at a time, and can
 * be dismissed; which ones were seen is kept only in this browser, under the
 * store's own key, so it adds no read, no write and no key on our side. A
 * value changed on the device is not trusted: nothing is shown, rather than
 * the same card again and again.
 */
export const MILESTONE_PREFIX = "mm:pm:";
/** The most step ids kept as seen; the oldest are dropped first (a Path has about a dozen). */
export const MILESTONE_SEEN_MOST = 64;
const SEEN_RAW_MOST = 4000;
const STORE_ID = /^[0-9a-f]{32}$/;
const MISSION_ID = /^[a-z0-9-]{1,40}$/;

export type Milestone = { id: string; title: string };

/** The browser key of one store's seen milestones; null when the id is not one we make. */
export function milestoneKey(sid: string): string | null {
  return STORE_ID.test(sid) ? `${MILESTONE_PREFIX}${sid}` : null;
}

/** The step ids seen: [] when nothing is kept, null when what is kept is not what we write. */
export function readSeen(raw: string | null): string[] | null {
  if (raw === null) return [];
  if (typeof raw !== "string" || raw.length > SEEN_RAW_MOST) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > MILESTONE_SEEN_MOST || !value.every((id) => typeof id === "string" && MISSION_ID.test(id))) return null;
  return value as string[];
}

/** The first recorded step not seen yet, or null (nothing new, or what was seen could not be read). */
export function nextMilestone(done: readonly Milestone[], seen: readonly string[] | null): Milestone | null {
  if (!seen) return null;
  return done.find((step) => MISSION_ID.test(step.id) && !seen.includes(step.id)) ?? null;
}

/** What is written once a step was seen: the list with it, the newest MILESTONE_SEEN_MOST kept. */
export function markSeen(seen: readonly string[], id: string): string {
  const next = seen.includes(id) ? [...seen] : [...seen, id];
  return JSON.stringify(next.slice(-MILESTONE_SEEN_MOST));
}
