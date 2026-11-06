/** SSR service boundaries only: the page/metadata and seven language dictionaries remain REAL. */
import type { ReactNode } from 'react';
import type { Store } from '@/lib/store';
import { FORM_ID } from '@/lib/forms';
import { DEFAULT_LOOK } from '@/lib/store-look';
import { form } from './form-response-fixture';

export const state = { mode: 'unavailable' as 'unavailable' | 'healthy' | 'missing', storeMissing: false, storeReads: 0, definitionReads: 0, listingReads: 0, funnelReads: 0, notFound: 0 };
export const shop = {
  sid: 'feedback-render-store', statsId: 'feedback-render-stats', handle: 'feedbackshop', name: 'Synthetic feedback shop',
  suspended: false, currency: 'USD', language: 'en', look: DEFAULT_LOOK,
  sitePages: [{ id: 'page000001', slug: 'apply', title: 'Apply', target: '' }],
} as unknown as Store;
export class KnownNotFound extends Error {}
export function resetFeedback() {
  state.mode = 'unavailable'; state.storeMissing = false; state.storeReads = 0; state.definitionReads = 0;
  state.listingReads = 0; state.funnelReads = 0; state.notFound = 0;
  shop.suspended = false; shop.language = 'en';
}
export function normaliseHandle(value: string) { return value.replace(/^@/, '').toLowerCase(); }
export async function storeForPage(handle: string) { state.storeReads++; return !state.storeMissing && handle === shop.handle ? shop : null; }
export function notFound(): never { state.notFound++; throw new KnownNotFound('Confirmed unavailable route'); }
export async function readForm(_statsId: string | null, id: string) {
  state.definitionReads++;
  if (!FORM_ID.test(id) || state.mode === 'missing') return null;
  if (state.mode === 'unavailable') throw Error('Persistent synthetic form-definition outage');
  return form;
}
export async function readListing() { state.listingReads++; return null; }
export async function funnelHere() { state.funnelReads++; return null; }
export function productPath() { return '/unused-product'; }
export function PlainText({ text, className }: { text: string; className?: string }) { return <span className={className}>{text}</span>; }
export default function Link({ href, children, ...props }: { href: string; children?: ReactNode; className?: string }) {
  return <a href={href} {...props}>{children}</a>;
}
