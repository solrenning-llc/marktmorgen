import { readFileSync } from 'node:fs';
import { readTrouble } from '@/lib/checkout-trouble';
import { store as redis } from './redis-stub';
import { done, is } from './check';

async function main() {
  const pipeline = redis.pipeline.bind(redis);
  const now = Date.parse('2026-11-05T03:00:00Z');
  // Exact callback from the page, exercised with the real reader. This is
  // not full SSR, React rendering, or a synthetic replacement for Next.
  const source = readFileSync('app/studio/page.tsx', 'utf8');
  const callback = source.match(/readTrouble\(current\.statsId\)\.catch\((\(\) => \(\{ week: 0, last: null \}\))\)/)?.[1];
  if (!callback) throw new Error('Page fallback changed; re-review it');
  const fallback = new Function(`return (${callback})`)() as () => { week: number; last: null };
  is('confirmed missing Redis record remains a quiet week', await readTrouble('g'.repeat(32),now).catch(fallback), {week:0,last:null});
  redis.pipeline = async () => [];
  const throughPageCatch = await readTrouble('g'.repeat(32),now).catch(fallback);
  is('inherited page fallback preserves unknown instead of quiet week', throughPageCatch, null);
  redis.pipeline = pipeline;
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
