/** Same synthetic owner boundary as the immutable identity proof's virtual module. */
import type { Store } from '@/lib/store';

type Boundary = { body: Record<string, unknown>; shop: Store; guardCalls: number; permission: string };
const fixtureGlobal = globalThis as typeof globalThis & { __k2FormIdentity?: Boundary };

export async function guardStoreWrite(_request: unknown, permission: string) {
  const state = fixtureGlobal.__k2FormIdentity;
  if (!state) throw new Error('Synthetic owner boundary is missing');
  state.guardCalls++;
  state.permission = permission;
  return { ok: true, body: state.body, store: state.shop, ref: 'synthetic-owner@example.com' };
}

export function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export async function setSitePages() {
  throw new Error('Unexpected creation of store stats');
}

// Merged with main of 15 November 2026 (Claude 1 cloud O): main's forms route gives a store with no stats id its id
// through ensureStatsId (no longer setSitePages); the synthetic store here has one, so that path is never expected.
export async function ensureStatsId() {
  throw new Error('Unexpected creation of store stats');
}
