/**
 * What one member of a community wrote and did, by reference (619 [SZ3],
 * inbox C3-7): "p:<post>", "c:<post>:<comment>", "l:<post>",
 * "lc:<post>:<comment>", "r:<target>", "v:<post>". Written with each of
 * those (lib/community.ts, lib/community-polls.ts), so the copy of a
 * person's data reads what is theirs and never the whole community, and
 * deleted with the person (lib/community-erasure.ts). Each entry is counted
 * in the members' slot of the store's data room before it is written.
 *
 *   nl:cm:<community>:tr:<member>   set of references
 */
export const traceKey = (id: string, who: string) => `nl:cm:${id}:tr:${who}`;

/** One entry of a member's trace, in the members' slot of the store's data room. */
/** A member key in a set and Redis's own: lib/community.ts SET_ENTRY_BYTES (tests/person-copy-trace.test.ts holds them equal). */
export const TRACE_ENTRY = { slot: "cm:m", bytes: 96 } as const;

/**
 * From when every post, comment, like, report and vote is in its member's
 * trace, in seconds. A community with a post from before this is read whole
 * for a copy, as before the trace existed: set later than the day the trace
 * is published, so a copy never misses anything (it may only read more).
 */
export const TRACED_SINCE = Date.UTC(2026, 11, 1) / 1000;
