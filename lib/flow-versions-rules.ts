/** How many earlier versions of one workflow are kept (lib/flow-versions.ts); browser-safe, for the studio's words. */
export const MAX_FLOW_VERSIONS = 10;

/**
 * A workflow keeps at most one earlier version in each pause of this long
 * (Claude 5 on #1927, the coordinator's decision B): the first save that
 * changes what it does keeps the version before it and marks the pause; an
 * autosave inside the pause reads and writes no version, so it moves what a
 * save moved before versions were kept.
 */
export const FLOW_VERSION_PAUSE_SECONDS = 600;

/**
 * What one studio request pays to move through the database: the fifty
 * kilobytes of UNIT_COST.studio (tests/plan-cost-registry.ts, held there).
 */
export const STUDIO_REQUEST_BYTES = 50_000;

/** What a history request moves besides the texts it measured: its scripts, keys, timestamps and framing. */
export const FLOW_HISTORY_OVERHEAD_BYTES = 4_096;

/**
 * What a workflow's history weighs, measured in Redis before any of it is
 * read (lib/flow-versions.ts, FLOW_HISTORY_SIZE), in bytes as Redis keeps
 * them: the store's workflows (STRLEN), its kept versions in all, and the
 * longest one.
 */
export type FlowHistorySize = { flows: number; versions: number; largest: number };

/** Studio requests for `bytes` moved, taken before any of it is read, on top of the request's own. */
export function flowHistoryUnits(bytes: number): number {
  return Math.max(1, Math.ceil(Math.max(0, bytes) / STUDIO_REQUEST_BYTES));
}

/** Listing the versions: the workflows read to find this one, and its versions. */
export function listVersionsBytes(size: FlowHistorySize): number {
  return size.flows + size.versions + FLOW_HISTORY_OVERHEAD_BYTES;
}

/**
 * One try of putting a version back (lib/flows.ts saveFlow, restoring): the
 * workflows read; the versions read, the newest sent back as what the push is
 * counted from, and the workflow it replaces sent as the version kept
 * (KEEP_FLOW_VERSION); and the workflows written with the version in its
 * place (WRITE_FLOWS_IF, which sends a hash of what they were read as, never
 * a copy).
 */
export function restoreTryBytes(size: FlowHistorySize): number {
  return size.flows + (size.versions + size.largest + size.flows) + (size.flows + size.largest) + FLOW_HISTORY_OVERHEAD_BYTES;
}

/** Putting a version back: its first reads (the workflow and its versions) and its first try; a try again pays again. */
export function restoreBytes(size: FlowHistorySize): number {
  return size.flows + size.versions + restoreTryBytes(size);
}

/** The save that keeps a version: the versions read, the newest sent back, and the one kept (`entry` bytes). */
export function keepVersionBytes(size: FlowHistorySize, entry: number): number {
  return size.versions + size.largest + entry + FLOW_HISTORY_OVERHEAD_BYTES;
}
