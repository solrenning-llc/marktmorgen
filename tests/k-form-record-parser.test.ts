/** RED from K2 proof 52ef9025 (record parser 41/4): REAL parser, form readers, CSV handler and store stream; only record contents/auth boundary are synthetic. */
import type { NextRequest } from 'next/server';
import type { Store } from '@/lib/store';
import { claimHandle, ensureStatsId, storeForEmail } from '@/lib/store';
import { parseForm, type FormResponse } from '@/lib/forms';
import { sensitiveFieldOf } from '@/lib/form-sensitive';
import { writeForm } from '@/lib/form-store';
import { storeExport } from '@/lib/store-export';
import { GET as exportCsv } from '@/app/api/store/forms/export/route';
import { store as redis } from '@/tests/redis-stub';
import { done, is } from '@/tests/check';

type ExportBoundary = { store: Store; calls: number; permission: string };
const fixtureGlobal = globalThis as typeof globalThis & { __k2FormRecord?: ExportBoundary };
const legacy = {
  id: 'form000003', name: 'Stored questionnaire',
  fields: [
    { id: 'fielda', type: 'short', label: 'Project name', required: true },
    { id: 'fieldb', type: 'long', label: 'Detailed notes' },
  ],
};
const canonical = parseForm({ ...legacy, updatedAt: 1 })!;
const partialRecord = { ...canonical, fields: [canonical.fields[0], { ...canonical.fields[1], label: 17 }] };
const answer: FormResponse = {
  at: 1_800_000_000, page: 'apply', answers: { fielda: 'Synthetic project', fieldb: 'Important synthetic notes' }, outcome: '', joined: false,
};

async function main() {
  // parseForm deliberately sanitizes editor/legacy input; these are controls, not a demand to change that contract.
  const old = parseForm(legacy)!;
  is('legacy: both readable questions survive without optional defaults', old.fields.length, 2);
  is('legacy: optional text defaults remain empty', [old.button, old.doneHeading, old.doneBody], ['', '', '']);
  is('legacy: absent outcomes remain a known empty list', old.outcomes, []);
  is('legacy: absent update time has its existing default', old.updatedAt, 0);
  is('parser contract: malformed editor question is sanitized away', parseForm(partialRecord)?.fields.map(field => field.id), ['fielda']);
  is('sensitive-field contract: these ordinary questions remain allowed', sensitiveFieldOf(canonical), null);

  const pipeline = redis.pipeline.bind(redis);
  const beforeFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider operation is allowed'); }) as typeof fetch;
  try {
    for (const mode of ['canonical', 'legacy', 'partial-record'] as const) {
      redis.clear();
      let setupCommands = 0;
      redis.pipeline = async batch => {
        if (setupCommands + batch.length > 100) throw Error('One hundred fixture setup commands is the ceiling');
        setupCommands += batch.length;
        return pipeline(batch);
      };
      const owner = 'record-owner@example.com';
      await claimHandle(owner, 'recordparser', 'Synthetic form records', '');
      await ensureStatsId(owner);
      const shop = (await storeForEmail(owner))!;
      if (!shop?.statsId) throw Error('Synthetic store fixture has no stats id');
      await writeForm(shop.statsId, canonical);
      const formKey = `nl:forms:${shop.statsId}`;
      const answerKey = `nl:form:r:${shop.statsId}:${canonical.id}`;
      await redis.pipeline([['LPUSH', answerKey, JSON.stringify(answer)]]);
      const boundary: ExportBoundary = { store: shop, calls: 0, permission: '' };
      fixtureGlobal.__k2FormRecord = boundary;
      const url = `https://example.test/api/store/forms/export?id=${canonical.id}`;
      if (Buffer.byteLength(url) > 4096) throw Error('Four KiB is the local request ceiling');
      const request = Object.assign(new Request(url), { nextUrl: new URL(url) }) as unknown as NextRequest;
      let commands = 0, injectedHvals = 0, injectedHget = 0;
      const supplied = JSON.stringify(mode === 'legacy' ? legacy : partialRecord);
      redis.pipeline = async batch => {
        if (commands + batch.length > 60) throw Error('Sixty application commands per export pair is the ceiling');
        commands += batch.length;
        if (mode !== 'canonical' && batch.length === 1 && batch[0][0] === 'HVALS' && batch[0][1] === formKey) {
          injectedHvals++; return [[supplied]];
        }
        if (mode !== 'canonical' && batch.length === 1 && batch[0][0] === 'HGET' && batch[0][1] === formKey && batch[0][2] === canonical.id) {
          injectedHget++; return [supplied];
        }
        return pipeline(batch);
      };
      const json = JSON.parse(await new Response(storeExport(shop)).text()) as {
        forms?: { form: typeof canonical; answers: FormResponse[] }[]; unreadPart4?: string;
      };
      const csv = await exportCsv(request);
      const text = await csv.text();
      // Two fixed direct inspections are outside the application's counter and reply substitution.
      const [storedForm, storedAnswers] = await pipeline([['HGET', formKey, canonical.id], ['LRANGE', answerKey, 0, -1]]);
      console.log('FORM_RECORD_OBSERVATION', JSON.stringify({
        mode, commands, setupCommands, injectedHvals, injectedHget,
        exportedFields: json.forms?.[0]?.form.fields, exportedAnswers: json.forms?.[0]?.answers,
        unreadPart4: json.unreadPart4, csvStatus: csv.status, attachment: csv.headers.get('content-disposition'), csv: text,
      }));
      is(`${mode}: selected HVALS substitution count`, injectedHvals, mode === 'canonical' ? 0 : 1);
      is(`${mode}: selected HGET substitution count`, injectedHget, mode === 'canonical' ? 0 : 1);
      is(`${mode}: original two-question record stays byte-identical`, storedForm, JSON.stringify(canonical));
      is(`${mode}: original saved answer stays byte-identical`, storedAnswers, [JSON.stringify(answer)]);
      is(`${mode}: CSV permission boundary called exactly once`, boundary.calls, 1);
      is(`${mode}: CSV keeps the export permission`, boundary.permission, 'export');
      is(`${mode}: no provider operation`, providerCalls, 0);
      if (mode === 'partial-record') {
        is('partial stored record: JSON does not certify a shortened definition', json.forms, undefined);
        is('partial stored record: JSON marks the forms section unread', typeof json.unreadPart4 === 'string' && json.unreadPart4.includes('could not be read'), true);
        is('partial stored record: CSV is temporarily unavailable', csv.status, 503);
        is('partial stored record: CSV does not attach a partial spreadsheet', csv.headers.get('content-disposition'), null);
      } else {
        is(`${mode}: JSON preserves both questions`, json.forms?.[0]?.form.fields.map(field => field.label), ['Project name', 'Detailed notes']);
        is(`${mode}: JSON preserves the saved second answer`, json.forms?.[0]?.answers[0]?.answers.fieldb, 'Important synthetic notes');
        is(`${mode}: healthy forms section has no unread marker`, json.unreadPart4, undefined);
        is(`${mode}: CSV remains downloadable`, csv.status, 200);
        is(`${mode}: CSV preserves second question and answer`, text.includes('Detailed notes') && text.includes('Important synthetic notes'), true);
      }
    }
  } finally {
    redis.pipeline = pipeline; globalThis.fetch = beforeFetch;
    delete fixtureGlobal.__k2FormRecord;
  }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
