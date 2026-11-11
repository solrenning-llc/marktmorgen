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
