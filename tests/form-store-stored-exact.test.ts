/**
 * #2857, Codex X5 review of e3c447d445 (two MEDIUM findings):
 * 1. readForms binds each record to its hash field: a valid record of another
 *    form under a field (shifted or swapped) is unknown, never a confirmed form.
 * 2. A stored record is confirmed only when parsing keeps every value it reads,
 *    not just the counts: a same-length record whose branch goes backward, or
 *    whose closing time is unreadable, is unknown, never a rewritten form that
 *    then takes answers. An older record that only leaves defaults out still reads.
 */
import { parseForm } from '@/lib/forms';
import { addResponse, forgetFormsPerson, readForm, readForms, readResponses, storedFormRecord, writeForm } from '@/lib/form-store';
import { ROOM } from '@/tests/data-room';
import { UnknownReply } from '@/lib/redis-exact';
import { store as redis } from '@/tests/redis-stub';
import { done, is } from '@/tests/check';

const stats = 'form-stored-exact';
const key = `nl:forms:${stats}`;
const a = parseForm({ id: 'form000001', name: 'A', updatedAt: 2, fields: [{ id: 'topic0', type: 'short', label: 'Topic' }] })!;
const b = parseForm({ ...a, id: 'form000002', name: 'B', updatedAt: 1 })!;
const quiz = parseForm({
  id: 'form000003', name: 'Quiz', updatedAt: 3,
  fields: [
    { id: 'first0', type: 'short', label: 'First' },
    { id: 'pick00', type: 'choice', label: 'Pick', options: [{ id: 'yes000', label: 'Yes', next: 'last00' }, { id: 'no0000', label: 'No' }] },
    { id: 'last00', type: 'short', label: 'Last' },
  ],
  closesAt: 1_900_000_000,
})!;

async function outcome<T>(run: () => Promise<T>): Promise<string> {
  try { return JSON.stringify(await run()); } catch (error) { return error instanceof UnknownReply ? 'unknown' : `other:${String(error)}`; }
}

async function main() {
  const native = redis.pipeline.bind(redis);
  try {
    redis.clear();
    await writeForm(stats, a); await writeForm(stats, b); await writeForm(stats, quiz);
    is('healthy forms still read, newest first', (await readForms(stats)).map(form => form.id), [quiz.id, a.id, b.id]);
    is('a healthy branching, scheduled form is confirmed as stored', JSON.stringify(await readForm(stats, quiz.id)), JSON.stringify(quiz));

    // 1. Field binding.
    redis.clear();
    await native([['HSET', key, a.id, JSON.stringify(b), b.id, JSON.stringify(a)]]);
    is('two records swapped between their fields are unknown, never confirmed', await outcome(() => readForms(stats)), 'unknown');
    redis.clear();
    await native([['HSET', key, a.id, JSON.stringify(b)]]);
    is('a record of B under field A is unknown, never B', await outcome(() => readForms(stats)), 'unknown');

    // The erasure inventory is bound the same way: B's record under field A would erase B's answers and leave A's.
    redis.clear();
    const mail = parseForm({ id: 'form000005', name: 'Mail', fields: [{ id: 'email1', type: 'email', label: 'Email', required: true }] })!;
    const other = parseForm({ ...mail, id: 'form000006', name: 'Other' })!;
    await writeForm(stats, mail);
    await addResponse(stats, mail.id, { at: 1, page: '/apply', answers: { email1: 'person@example.com' }, outcome: '', joined: false }, ROOM);
    await native([['HSET', key, mail.id, JSON.stringify(other)]]);
    is('the erasure refuses an inventory record bound to another form', await outcome(() => forgetFormsPerson(stats, 'person@example.com', ROOM)), 'unknown');
    await native([['HSET', key, mail.id, JSON.stringify(mail)]]);
    is('the answer is still there to erase once read exactly', (await readResponses(stats, mail.id)).total, 1);
    is('read exactly, the erasure takes it', await forgetFormsPerson(stats, 'person@example.com', ROOM), 1);

    // 2. Same counts, different behavior.
    const backward = JSON.parse(JSON.stringify(quiz));
    backward.fields[1].options[0].next = 'first0';
    is('the backward branch keeps every count', parseForm(backward)?.fields.length, 3);
    is('a backward branch parseForm would drop is unknown', storedFormRecord(JSON.stringify(backward)), null);
    redis.clear();
    await native([['HSET', key, quiz.id, JSON.stringify(backward)]]);
    is('readForm refuses the backward branch', await outcome(() => readForm(stats, quiz.id)), 'unknown');
    is('readForms refuses the backward branch', await outcome(() => readForms(stats)), 'unknown');

    const unreadableClose = { ...JSON.parse(JSON.stringify(quiz)), closesAt: 'tomorrow' };
    is('an unreadable closing time is unknown, never a form that stays open', storedFormRecord(JSON.stringify(unreadableClose)), null);
    const required = JSON.parse(JSON.stringify(a)); required.fields[0].required = 'yes';
    is('a required flag parseForm would read as false is unknown', storedFormRecord(JSON.stringify(required)), null);
    const longName = { ...JSON.parse(JSON.stringify(a)), name: 'A'.repeat(5000) };
    is('a name parseForm would cut is unknown', storedFormRecord(JSON.stringify(longName)), null);

    // An older record that only leaves defaults out still reads, as before.
    const legacy = { id: 'form000004', name: 'Old', fields: [{ id: 'topic0', type: 'short', label: 'Topic' }] };
    is('a record without defaults still reads', storedFormRecord(JSON.stringify(legacy))?.id, 'form000004');
    is('defaults kept as null still read', storedFormRecord(JSON.stringify({ ...legacy, button: null, opensAt: null }))?.id, 'form000004');
  } finally {
    redis.pipeline = native;
  }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
