/** Seven pure SSR locale groups plus explicit compatibility/security controls; no storage/provider IO. */
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Page, { generateMetadata } from '@/app/[handle]/form/[form]/page';
import { LANGUAGE_CODES } from '@/lib/store-language';
import { formWords } from '@/lib/buyer-words/form';
import { form } from '@/tests/form-response-fixture';
import { done, is, part } from '@/tests/check';
import { KnownNotFound, resetFeedback, shop, state } from './k-form-submit-feedback-world';

type Query = Record<string, string | string[] | undefined>;
const args = (query: Query = {}, id = form.id) => ({ params: Promise.resolve({ handle: '@feedbackshop', form: id }), searchParams: Promise.resolve(query) });
const escaped = (text: string) => renderToStaticMarkup(createElement(Fragment, null, text));
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://example.com'));
async function draw(query: Query, id = form.id) {
  try { return { html: renderToStaticMarkup(await Page(args(query, id))), error: null as unknown }; }
  catch (error) { return { html: '', error }; }
}

async function main() {
  for (const language of LANGUAGE_CODES) {
    part(`Pure SSR locale ${language}`); resetFeedback(); shop.language = language;
    const w = formWords(language);
    const query = { status: 'unavailable', p: 'page000001', f: 'funnel0001', r: 'ready0', j: '1', s: '999', c: 'catfoo-999' };
    const metadata = await generateMetadata(args(query));
    const title = typeof metadata.title === 'string' ? metadata.title : JSON.stringify(metadata.title) ?? '';
    const robots = typeof metadata.robots === 'object' ? metadata.robots : null;
    const drawn = await draw(query), html = drawn.html, links = hrefs(html);
    is(`${language}: metadata uses the existing localized error copy`, title.includes(w.errors.error), true);
    is(`${language}: metadata does not claim thanks`, title.includes(w.doneHeading), false);
    is(`${language}: metadata remains noindex`, robots?.index, false);
    is(`${language}: metadata remains nofollow`, robots?.follow, false);
    is(`${language}: feedback renders despite persistent definition failure`, drawn.error, null);
    is(`${language}: the central main landmark remains`, /<main\b[^>]*id="content"/.test(html), true);
    is(`${language}: feedback is an alert`, /\brole="alert"/.test(html), true);
    is(`${language}: body uses the exact existing localized error copy`, html.includes(escaped(w.errors.error)), true);
    is(`${language}: no thank-you or sent-answer copy`, html.includes(escaped(w.doneHeading)) || html.includes(escaped(w.doneBody(shop.name))), false);
    is(`${language}: forged result query does not show a result`, html.includes(escaped(w.result)), false);
    is(`${language}: forged joined query does not claim an email`, html.includes(escaped(w.confirmSent)), false);
    is(`${language}: forged score query does not show a score`, html.includes('data-quiz-score'), false);
    is(`${language}: feedback does not draw questions or a submit form`, html.includes('<form'), false);
    is(`${language}: definition is not read`, state.definitionReads, 0);
    is(`${language}: product is not read`, state.listingReads, 0);
    is(`${language}: funnel is not read`, state.funnelReads, 0);
    is(`${language}: a valid feedback route is not called missing`, state.notFound, 0);
    is(`${language}: all navigation stays inside the same store`, links.length > 0 && links.every(link => link.origin === 'https://example.com' && (link.pathname === `/@${shop.handle}` || link.pathname.startsWith(`/@${shop.handle}/`))), true);
    is(`${language}: known page, marker and form anchor are retained`, links.some(link => link.pathname === `/@${shop.handle}/apply` && link.searchParams.get('f') === 'funnel0001' && link.hash === `#form-${form.id}`), true);
    is(`${language}: return navigation uses existing localized copy`, html.includes(escaped(w.backTo(shop.name))), true);
  }

  part('Pure compatibility and navigation controls');
  resetFeedback(); state.mode = 'healthy';
  let drawn = await draw({});
  is('healthy: normal result page still renders', drawn.error, null);
  is('healthy: normal form-result marker remains', drawn.html.includes(`data-form-done="${form.id}"`), true);
  is('healthy: normal definition is read', state.definitionReads, 1);
  const normal = await generateMetadata(args());
  is('healthy: original metadata remains byte-for-byte', normal.title, `${formWords('en').doneHeading} — ${shop.name}`);

  resetFeedback(); state.mode = 'missing'; drawn = await draw({});
  is('confirmed missing without feedback marker: remains notFound', drawn.error instanceof KnownNotFound, true);
  is('confirmed missing: definition read is retained', state.definitionReads, 1);
  is('confirmed missing: no navigation lookup', state.funnelReads, 0);

  resetFeedback(); shop.suspended = 'Synthetic suspension'; drawn = await draw({ status: 'unavailable' });
  is('suspended: feedback cannot bypass notFound', drawn.error instanceof KnownNotFound, true);
  is('suspended: definition is not read', state.definitionReads, 0);
  is('suspended: product is not read', state.listingReads, 0);

  resetFeedback(); drawn = await draw({ status: 'unavailable' }, 'bad!');
  is('malformed form id: feedback cannot bypass notFound', drawn.error instanceof KnownNotFound, true);
  is('malformed form id: product is not read', state.listingReads, 0);
  is('malformed form id: funnel is not read', state.funnelReads, 0);

  for (const status of ['other-status', ['unavailable']] as const) {
    resetFeedback(); state.mode = 'healthy';
    drawn = await draw({ status: typeof status === 'string' ? status : [...status], r: 'ready0', j: '1' });
    is(`strict status ${JSON.stringify(status)}: normal page remains`, drawn.error, null);
    is(`strict status ${JSON.stringify(status)}: result is not converted to feedback`, drawn.html.includes(escaped(formWords('en').result)), true);
    is(`strict status ${JSON.stringify(status)}: normal joined message is preserved`, drawn.html.includes(escaped(formWords('en').confirmSent)), true);
  }

  resetFeedback(); drawn = await draw({ status: 'unavailable', p: 'https://outside.example/leave', f: '../../outside', r: 'ready0', j: '1' });
  let links = hrefs(drawn.html);
  is('untrusted navigation: feedback still renders', drawn.error, null);
  is('untrusted navigation: return is only the store root', links.length > 0 && links.every(link => link.origin === 'https://example.com' && link.pathname === `/@${shop.handle}` && !link.search && !link.hash), true);
  is('untrusted navigation: raw external target never appears', drawn.html.includes('outside.example'), false);
  is('untrusted navigation: definition is not read', state.definitionReads, 0);

  resetFeedback(); state.mode = 'missing'; drawn = await draw({ status: 'unavailable' }, 'unused0001');
  links = hrefs(drawn.html);
  is('well-formed unverified id: informational feedback is not an existence claim', drawn.error, null);
  is('well-formed unverified id: existence is not read', state.definitionReads, 0);
  is('well-formed unverified id: safe root navigation remains', links.length > 0 && links.every(link => link.pathname === `/@${shop.handle}`), true);
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
