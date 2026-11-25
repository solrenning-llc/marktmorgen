/** Synthetic CSV export owner boundary for tests/k-form-record-parser.test.ts (same as the K2 proof's virtual module). */
import type { Store } from '@/lib/store';

type ExportBoundary = { store: Store; calls: number; permission: string };
const fixtureGlobal = globalThis as typeof globalThis & { __k2FormRecord?: ExportBoundary };

export async function creatorFrom(_request: unknown, permission: string) {
  const boundary = fixtureGlobal.__k2FormRecord;
  if (!boundary) throw new Error('Synthetic export owner boundary is missing');
  boundary.calls++;
  boundary.permission = permission;
  return { store: boundary.store };
}

/**
 * lib/flow-versions.ts (main, merged into #2857) imports countStudio from this module; the record parser's test never
 * reaches a studio request, so any call here is a test bug and throws instead of answering on a guess.
 */
export async function countStudio(): Promise<never> {
  throw new Error('Synthetic export owner boundary: countStudio is not expected in this test');
}

/**
 * The answers file holds the studio units of reading its answers before reading them (#5010 row 145): this
 * boundary keeps the record parser's test on its own subject, the figure always having the units.
 */
export async function holdStudio() {
  return { ok: true as const, give: async () => {}, force: async () => {} };
}
