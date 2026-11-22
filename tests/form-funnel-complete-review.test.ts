/**
 * #2857 follow-up (focal review of 9a4220f5d, LEVE): the funnel launch review
 * applies the same "complete record" rule as the public page and exports, so a
 * stored record parseForm would shorten is unknown there too, never "present".
 */
import { parseForm } from '@/lib/forms';
import { readForms, writeForm } from '@/lib/form-store';
import { readFunnelFormReviews } from '@/lib/funnel-form-review';
import type { Store } from '@/lib/store';
import type { PageFunnel } from '@/lib/page-funnel';
import { store as redis } from '@/tests/redis-stub';
import { done, is } from '@/tests/check';

const stats = 'form-funnel-complete';
const a = parseForm({ id: 'form000001', name: 'A', updatedAt: 2, fields: [{ id: 'topic0', type: 'short', label: 'Topic' }] })!;
const b = parseForm({ ...a, id: 'form000002', name: 'B', updatedAt: 1 })!;

async function main() {
  const native = redis.pipeline.bind(redis);
  try {
    redis.clear();
    await writeForm(stats, a); await writeForm(stats, b);
    is('healthy list still reads both forms, newest first', (await readForms(stats)).map(form => form.id), [a.id, b.id]);

    redis.clear();
    is('an empty list is still a confirmed empty list', await readForms(stats), []);

    // Funnel launch review: a stored record whose second question parseForm would drop.
    redis.clear();
    const page = { id: 'page000001', title: 'Application', slug: 'apply', from: 0 };
    const store = { statsId: 'funnel-binding', sitePages: [page] } as unknown as Store;
    const funnel = { id: 'funnel0001', steps: [{ kind: 'page', id: page.id }] } as PageFunnel;
    const pageReply = [JSON.stringify({ blocks: [{ id: 'block00001', kind: 'form', heading: 'Apply', form: a.id }] })];
    const shortened = JSON.stringify({ ...a, fields: [...a.fields, { id: 'topic1', type: 'short', label: 17 }] });
    is('the shortened record really is shortened by parseForm', parseForm(JSON.parse(shortened))?.fields.length, 1);
    redis.pipeline = async commands => commands[0]?.[0] === 'GET' ? pageReply : [[shortened]];
    const issues = (await readFunnelFormReviews(store, [funnel])).get(funnel.id)!;
    is('a shortened stored form is unknown in the funnel review, never present', issues.map(issue => issue.code), ['forms_unknown']);
    redis.pipeline = async commands => commands[0]?.[0] === 'GET' ? pageReply : [[JSON.stringify(a)]];
    is('a complete stored form is still present in the funnel review', (await readFunnelFormReviews(store, [funnel])).get(funnel.id), []);
  } finally {
    redis.pipeline = native;
  }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
