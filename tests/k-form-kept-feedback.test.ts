/** RED from K2 proof 3e53fa66 (kept feedback 79/7): REAL POST/KEEP/MemoryRedis/BlockView; loss of a receipt is not proof that nothing was kept. */
import type { NextRequest } from 'next/server';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { POST } from '@/app/api/store/form/route';
import { KEEP_FORM_RESPONSE, SAVE_FORM, writeForm } from '@/lib/form-store';
import { BlockView, type BlockContext } from '@/components/sales-blocks';
import { formWords } from '@/lib/buyer-words/form';
import { LANGUAGE_CODES, type LanguageCode } from '@/lib/store-language';
import { store as redis } from '@/tests/redis-stub';
import { form } from '@/tests/form-response-fixture';
import { effects, shop } from '@/tests/k-form-submit-world';
import { done, is, part } from '@/tests/check';

// Frozen explicit absence claims from the reserved source. A future neutral translation
// must not be rejected merely because it occupies the same dictionary key.
const NOT_SENT: Record<LanguageCode, string> = {
  en: 'Something went wrong, and nothing was sent. Please try again.',
  es: 'Algo salió mal y no se envió nada. Inténtalo de nuevo.',
  fr: "Une erreur s'est produite et rien n'a été envoyé. Réessayez.",
  de: 'Etwas ist schiefgegangen, und es wurde nichts gesendet. Bitte versuchen Sie es erneut.',
  it: 'Qualcosa è andato storto e non è stato inviato nulla. Riprova.',
  nl: 'Er ging iets mis en er is niets verstuurd. Probeer het opnieuw.',
  pt: 'Algo correu mal e nada foi enviado. Tente novamente.',
};
const escaped = (text: string) => renderToStaticMarkup(createElement(Fragment, null, text));

async function main() {
  const native = redis.pipeline.bind(redis), fetchBefore = globalThis.fetch;
  const deadline = Date.now() + 120_000;
  const stored = { ...form, offerList: false }, storedBytes = JSON.stringify(stored);
  const formsKey = `nl:forms:${shop.statsId}`, answersKey = `nl:form:r:${shop.statsId}:${form.id}`;
  let providerCalls = 0, aggregateCommands = 0, localCommands = 0, localReservedBytes = 0, localActualBytes = 0;
  if (Buffer.byteLength(storedBytes) > 4096) throw Error('Fixture form exceeds its admitted four KiB');
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider IO is permitted'); }) as typeof fetch;
  const withinDeadline = () => { if (Date.now() > deadline) throw Error('The 120-second proof deadline was reached'); };
  // Reservations precede native setup/inspection. LRANGE reads only one response; fixture
  // form/body sizes bound each inspection below its reserved 32 KiB, at most 98,496 bytes total.
  const local = async (batch: (string | number)[][], reservedBytes: number) => {
    withinDeadline();
    if (localCommands + batch.length > 40 || localReservedBytes + reservedBytes > 128 * 1024) throw Error('Setup/inspection admission exceeded');
    localCommands += batch.length; localReservedBytes += reservedBytes;
    const reply = await native(batch), bytes = Buffer.byteLength(JSON.stringify(reply));
    localActualBytes += bytes;
    if (bytes > reservedBytes) throw Error('A native fixture reply exceeded its pre-admitted bytes');
    return reply;
  };
  console.log('KEPT_FEEDBACK_BOUNDS', JSON.stringify({ postCases: 3, appCommandsPerCase: 40, appCommandsAggregate: 120, setupInspectionCommands: 40, setupInspectionBytes: 128 * 1024, requestBytes: 4096, deadlineMs: 120_000, providerCallsAllowed: 0 }));
  try {
    for (const mode of ['healthy', 'not-applied-unknown', 'applied-unknown'] as const) {
      part(mode); redis.clear();
      for (const key of Object.keys(effects) as (keyof typeof effects)[]) effects[key] = 0;
      redis.pipeline = async batch => {
        if (batch.length !== 1 || batch[0][0] !== 'EVAL' || batch[0][1] !== SAVE_FORM) throw Error('Unexpected setup command');
        return local(batch, 64);
      };
      await writeForm(shop.statsId!, stored);
      const body = new URLSearchParams({ handle: shop.handle, form: form.id, page: 'page000001', f: 'funnel0001', q_name00: 'Synthetic', q_email0: 'person@example.test' });
      if (Buffer.byteLength(body.toString()) > 4096) throw Error('The POST body exceeds four KiB');
      let commands = 0, injections = 0, keepDispatches = 0, nativeKeepCompletions = 0, afterUnknown = 0;
      let nativeKeepReceipt: unknown = null;
      redis.pipeline = async batch => {
        withinDeadline();
        if (commands + batch.length > 40 || aggregateCommands + batch.length > 120) throw Error('Application command admission exceeded');
        commands += batch.length; aggregateCommands += batch.length;
        if (injections) afterUnknown += batch.length;
        const keep = batch.length === 1 && batch[0][0] === 'EVAL' && batch[0][1] === KEEP_FORM_RESPONSE && batch[0][2] === 1 && batch[0][3] === answersKey;
        if (!keep) return native(batch);
        keepDispatches++;
        if (mode === 'not-applied-unknown') { injections++; return [null]; }
        // The decisive ordering: execute the REAL KEEP first. Only its ACK is replaced.
        const receipt = await native(batch);
        nativeKeepCompletions++; nativeKeepReceipt = receipt;
        if (mode === 'applied-unknown') { injections++; return [null]; }
        return receipt;
      };
      const response = await POST(new Request('https://example.com/api/store/form', { method: 'POST', body }) as NextRequest);
      const location = response.headers.get('location'), target = location ? new URL(location) : null;
      const [count, rawRows, definition] = await local([['LLEN', answersKey], ['LRANGE', answersKey, 0, 0], ['HGET', formsKey, form.id]], 32_768);
      const rows = Array.isArray(rawRows) ? rawRows : [];
      const first = typeof rows[0] === 'string' ? JSON.parse(rows[0]) as { id?: string; answers?: Record<string, unknown> } : null;
      const healthy = mode === 'healthy', applied = mode !== 'not-applied-unknown';
      const success = target?.pathname === `/@${shop.handle}/form/${form.id}` && !target.searchParams.has('status');
      is(`${mode}: POST returns a no-store redirect`, [response.status, response.headers.get('cache-control')], [303, 'no-store']);
      is(`${mode}: destination remains on the request origin`, target?.origin, 'https://example.com');
      is(`${mode}: exactly one real KEEP command is selected`, keepDispatches, 1);
      is(`${mode}: actual native KEEP completion count`, nativeKeepCompletions, applied ? 1 : 0);
      is(`${mode}: original native receipt, before any override`, nativeKeepReceipt, applied ? [[]] : null);
      is(`${mode}: only unknown scenarios replace the ACK`, injections, healthy ? 0 : 1);
      is(`${mode}: native LLEN confirms actual persistence`, count, applied ? 1 : 0);
      is(`${mode}: bounded native LRANGE agrees`, rows.length, applied ? 1 : 0);
      is(`${mode}: persisted answers came from the actual POST`, first?.answers ?? null, applied ? { name00: 'Synthetic', email0: 'person@example.test' } : null);
      is(`${mode}: the actual stored response id is native`, applied ? /^[a-f0-9]{32}$/.test(first?.id ?? '') : first === null, true);
      is(`${mode}: definition bytes remain unchanged`, definition, storedBytes);
      is(`${mode}: receipt uncertainty is not a success redirect`, success, healthy);
      is(`${mode}: no application command follows an unknown ACK`, afterUnknown, 0);
      is(`${mode}: admission remains before KEEP`, effects.admission, 1);
      is(`${mode}: enrollment requires a confirmed ACK`, effects.enroll, healthy ? 1 : 0);
      is(`${mode}: funnel lookup requires a confirmed ACK`, effects.funnelReads, healthy ? 1 : 0);
      is(`${mode}: funnel completion requires a confirmed ACK`, effects.funnel, healthy ? 1 : 0);
      is(`${mode}: offerList=false requests no confirmation`, effects.joins, 0);
      is(`${mode}: no provider operation`, providerCalls, 0);
      const localeFeedback: { language: string; explicitNotSent: boolean; currentErrorCopy: string }[] = [];
      if (!healthy) {
        // This proof follows the returned original-page status into its REAL BlockView
        // consumer. It does not pretend this is the full page loader or a browser.
        if (target?.pathname !== `/@${shop.handle}/apply`) throw Error('The returned consumer changed; review the proof harness');
        const notice = { form: target.searchParams.get('form') ?? '', status: target.searchParams.get('status') ?? '' };
        for (const language of LANGUAGE_CODES) {
          withinDeadline();
          const ctx: BlockContext = { storeName: 'Synthetic proof shop', productTitle: 'Synthetic form', picture: null, photo: null, action: { kind: 'none', text: '' }, defaultLabel: '', lang: language, forms: { [form.id]: stored }, formTarget: { handle: shop.handle, page: 'page000001', funnel: 'funnel0001', listOpen: false }, formNotice: notice };
          const html = renderToStaticMarkup(createElement(BlockView, { block: { id: 'block00001', kind: 'form', heading: 'Synthetic form', form: form.id }, ctx, reviews: null }));
          const explicitNotSent = html.includes(escaped(NOT_SENT[language]));
          is(`${mode}/${language}: the real returned form has an alert`, /role="alert"/.test(html), true);
          if (mode === 'applied-unknown') is(`${language}: a natively kept response is not declared unsent`, explicitNotSent, false);
          localeFeedback.push({ language, explicitNotSent, currentErrorCopy: formWords(language).errors.error });
        }
      }
      console.log('KEPT_FEEDBACK_OBSERVATION', JSON.stringify({ mode, status: response.status, location, commands, injections, keepDispatches, nativeKeepCompletions, nativeKeepReceipt, afterUnknown, storedCount: count, storedAnswers: first?.answers ?? null, effects: { ...effects }, localeFeedback }));
    }
    is('all cases: no provider was contacted', providerCalls, 0);
    console.log('KEPT_FEEDBACK_TOTALS', JSON.stringify({ aggregateCommands, localCommands, localReservedBytes, localActualBytes, providerCalls }));
  } finally { redis.pipeline = native; globalThis.fetch = fetchBefore; }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
