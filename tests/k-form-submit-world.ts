/** Synthetic service/auth/admission edges around the real POST, form store and data room. */
import type { Store } from '@/lib/store';
import { ROOM } from './data-room';

export const effects = { admission: 0, enroll: 0, funnel: 0, funnelReads: 0, joins: 0 };
export const shop = {
  ...ROOM,
  statsId: 'submit-stats',
  handle: 'submitshop',
  suspended: false,
  sitePages: [{ id: 'page000001', slug: 'apply' }],
} as unknown as Store;

export async function withinStore() { effects.admission++; return true; }
export function originFrom() { return 'https://example.com'; }
export function linkOrigin() { return 'https://example.com'; }
export function clientAddress() { return '127.0.0.1'; }
export function fromAnotherSite() { return false; }
export async function limited(request: Request) { return request; }
export function normaliseHandle(value: string) { return value; }
export async function storeForHandle(handle: string) { return handle === shop.handle ? shop : null; }
export async function enroll() { effects.enroll++; }
export async function askToJoin() { effects.joins++; return 'sent'; }
export async function leadAffiliate() { return null; }
export function visitCookies() { return new Map(); }
export async function funnelHere() {
  effects.funnelReads++;
  return { funnel: { id: 'funnel0001' }, index: 0, next: null };
}
export function funnelVisitor() { return 'synthetic-visitor'; }
export async function countFunnelDone() { effects.funnel++; }
export async function isStorePeople() { return false; }
