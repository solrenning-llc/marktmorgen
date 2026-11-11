/** readForms/readForm: a readable record is evidence only of the form it names, once (C1 review 6800138004, MEDIUM identity). */
import { parseForm } from '@/lib/forms';
import { readForm, readForms, writeForm } from '@/lib/form-store';
import { UnknownReply } from '@/lib/redis-exact';
import { store as redis } from '@/tests/redis-stub';
import { done, is } from '@/tests/check';

const stats = 'form-read-identity';
const key = `nl:forms:${stats}`;
const a = parseForm({ id: 'form000001', name: 'A', updatedAt: 2, fields: [{ id: 'topic0', type: 'short', label: 'Topic' }] })!;
const b = parseForm({ ...a, id: 'form000002', name: 'B', updatedAt: 1 })!;

async function outcome<T>(run: () => Promise<T>): Promise<string> {
  try { return JSON.stringify(await run()); } catch (error) { return error instanceof UnknownReply ? 'unknown' : `other:${String(error)}`; }
}

async function main() {
  const native = redis.pipeline.bind(redis);
  try {
    redis.clear();
    await writeForm(stats, a); await writeForm(stats, b);
    is('healthy readForm returns the requested form', (await readForm(stats, a.id))?.id, a.id);
    is('healthy readForms returns both, newest first', (await readForms(stats)).map(form => form.id), [a.id, b.id]);
    is('confirmed absence stays null', await readForm(stats, 'form00000z'), null);

    redis.pipeline = async batch => batch.length === 1 && batch[0][0] === 'HGET' && batch[0][2] === a.id ? [JSON.stringify(b)] : native(batch);
    is('HGET for A answered with B is unknown, never B', await outcome(() => readForm(stats, a.id)), 'unknown');

    redis.pipeline = async batch => batch.length === 1 && batch[0][0] === 'HVALS' && batch[0][1] === key ? [[JSON.stringify(a), JSON.stringify(a)]] : native(batch);
    is('HVALS with the same form twice is unknown, never a duplicate list', await outcome(() => readForms(stats)), 'unknown');
  } finally {
    redis.pipeline = native;
  }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
