import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaxEditor } from '@/components/tax-editor';
import { StudioStorePin } from '@/components/studio-store-pin';
import { is, done } from './check';
const sid = 'a'.repeat(32);
const view = (connected: boolean, status: 'active'|'pending'|'unknown', pinned: boolean) => {
  const editor = createElement(TaxEditor, {tax:{enabled:false,included:false,ids:false,invoices:false},status,connected});
  return renderToStaticMarkup(pinned ? <StudioStorePin sid={sid}>{editor}</StudioStorePin> : editor);
};
const href = (html:string) => html.match(/<a[^>]*href="([^"]*\/studio\/tax[^"]*)"/)?.[1];
for (const status of ['active','pending','unknown'] as const)
  is(`store A context stays in the tax-registration link (${status})`, href(view(true,status,true)), `/studio/tax?store=${sid}`);
is('outside a store context the destination remains usable',href(view(true,'unknown',false)),'/studio/tax');
is('disconnected store has no registration link',href(view(false,'unknown',true)),undefined);
done();
