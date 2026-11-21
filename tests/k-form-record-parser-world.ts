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
