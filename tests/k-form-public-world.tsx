/** Synthetic store/page services and renderers around the REAL public pages and form reader. */
import type { ReactNode } from 'react';
import type { Store } from '@/lib/store';
import type { FormDef } from '@/lib/forms';
import { parsePage } from '@/lib/sales-page';
import { DEFAULT_LOOK } from '@/lib/store-look';
import { ROOM } from './data-room';
import { form } from './form-response-fixture';

export const state = { withForm: true, notFound: 0 };
export const shop = {
  ...ROOM, statsId: 'public-form-fixture', handle: 'publicshop', name: 'Synthetic public shop',
  suspended: false, language: 'en', currency: 'USD', bio: '', photoId: null, domain: null,
  look: DEFAULT_LOOK, catalog: { items: [], head: [] },
  sitePages: [{ id: 'page000001', slug: 'apply', title: 'Apply', target: '' }],
} as unknown as Store;

export class KnownNotFound extends Error {}
export function notFound(): never { state.notFound++; throw new KnownNotFound('Confirmed missing'); }
export function redirect(url: string): never { throw Error('Unexpected redirect: ' + url); }
export async function headers() { return new Headers(); }
export function normaliseHandle(value: string) { return value.replace(/^@/, '').toLowerCase(); }
export async function storeForPage() { return shop; }
export async function readListing() { return null; }
export async function readPage() {
  return parsePage({ blocks: state.withForm
    ? [{ id: 'formblk001', kind: 'form', heading: 'Your answers', form: form.id }]
    : [{ id: 'textblk001', kind: 'text', heading: 'Known page', body: 'Known content' }],
  });
}
export function listOpen() { return false; }
export async function funnelHere() { return null; }
export function productPath() { return '/unused'; }
export function pricePill() { return ''; }
export function HeroView() { return null; }
export function PageSections({ ctx }: { ctx: { forms?: Record<string, FormDef> } }) {
  return <section data-known-form-ids={Object.keys(ctx.forms ?? {}).join(',')} />;
}
export function PlainText({ text, className }: { text: string; className?: string }) {
  return <span className={className}>{text}</span>;
}
export function PictureViewer() { return null; }
export function StoreTracking() { return null; }
export function StorePagesNav() { return null; }
export function FunnelBeacon() { return null; }
export default function Link({ href, children, ...props }: { href: string; children?: ReactNode; className?: string }) {
  return <a href={href} {...props}>{children}</a>;
}
