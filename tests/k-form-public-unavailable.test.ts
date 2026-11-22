/** REAL public page factories and form-store with MemoryRedis; selected transport replies only are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import StoreOwnPage from '@/app/[handle]/[slug]/page';
import FormDonePage from '@/app/[handle]/form/[form]/page';
import { writeForm } from '@/lib/form-store';
import { UnknownReply } from '@/lib/redis-exact';
import { store as redis } from './redis-stub';
import { form } from './form-response-fixture';
import { KnownNotFound, shop, state } from './k-form-public-world';

const pages = [
  { name: 'own page', render: () => StoreOwnPage({ params: Promise.resolve({ handle: '@publicshop', slug: 'apply' }), searchParams: Promise.resolve({}) }) },
  { name: 'form result', render: () => FormDonePage({ params: Promise.resolve({ handle: '@publicshop', form: form.id }), searchParams: Promise.resolve({}) }) },
] as const;

async function scenario(mode: 'healthy' | 'missing' | 'unknown' | 'transport', run: (observe: () => { commands: number; injected: number; reads: number }) => Promise<void>) {
  const pipeline = redis.pipeline.bind(redis);
  redis.clear(); state.withForm = true; state.notFound = 0;
  if (mode !== 'missing') await writeForm(shop.statsId!, form);
  const key = `nl:forms:${shop.statsId}`;
  let commands = 0, injected = 0, reads = 0;
  redis.pipeline = async batch => {
    if (commands + batch.length > 10) throw Error('Ten application commands per public-page case is the ceiling');
    commands += batch.length;
    if (batch[0][0] === 'HGET' && batch[0][1] === key && batch[0][2] === form.id) {
      reads++;
      if (mode === 'unknown') { injected++; return [false]; }
      if (mode === 'transport') { injected++; throw transportFailure; }
    }
    return pipeline(batch);
  };
  try {
    await run(() => ({ commands, injected, reads }));
    if (mode !== 'missing') assert.equal((await pipeline([['HGET', key, form.id]]))[0], JSON.stringify(form), 'the saved form remains intact');
  } finally { redis.pipeline = pipeline; state.withForm = true; }
}
const transportFailure = new Error('Synthetic selected form read transport failure');

for (const page of pages) {
  for (const mode of ['unknown', 'transport'] as const) {
    test(`${page.name}: ${mode} form read propagates to the retry boundary, never notFound`, async () => {
      await scenario(mode, async observe => {
        await assert.rejects(page.render, error => mode === 'unknown' ? error instanceof UnknownReply : error === transportFailure);
        assert.equal(state.notFound, 0);
        assert.deepEqual(observe(), { commands: 1, injected: 1, reads: 1 });
      });
    });
  }
  test(`${page.name}: a readable stored form keeps its healthy page`, async () => {
    await scenario('healthy', async observe => {
      const html = renderToStaticMarkup(await page.render());
      assert.match(html, page.name === 'own page' ? new RegExp(`data-known-form-ids="${form.id}"`) : new RegExp(`data-form-done="${form.id}"`));
      assert.equal(state.notFound, 0);
      assert.deepEqual(observe(), { commands: 1, injected: 0, reads: 1 });
    });
  });
}
test('own page: confirmed missing form remains distinct from an unavailable read', async () => {
  await scenario('missing', async observe => {
    assert.match(renderToStaticMarkup(await pages[0].render()), /data-known-form-ids=""/);
    assert.equal(state.notFound, 0);
    assert.deepEqual(observe(), { commands: 1, injected: 0, reads: 1 });
  });
});
test('form result: confirmed missing form still uses notFound', async () => {
  await scenario('missing', async observe => {
    await assert.rejects(pages[1].render, error => error instanceof KnownNotFound);
    assert.equal(state.notFound, 1);
    assert.deepEqual(observe(), { commands: 1, injected: 0, reads: 1 });
  });
});
test('own page without a form block does not read form definitions', async () => {
  await scenario('healthy', async observe => {
    state.withForm = false;
    assert.match(renderToStaticMarkup(await pages[0].render()), /data-known-form-ids=""/);
    assert.deepEqual(observe(), { commands: 0, injected: 0, reads: 0 });
  });
});
