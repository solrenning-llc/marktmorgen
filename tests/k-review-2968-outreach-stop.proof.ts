/** Independent #2968 review: real page/helper/MemoryRedis, selective read failures only. */
import { renderToStaticMarkup } from 'react-dom/server';
import Page from '@/app/outreach/stop/[token]/page';
import { linkKey, stopFromLink } from '@/lib/outreach';
import { store as redis } from './redis-stub';
import { done, is, part } from './check';

const token = 'b'.repeat(32), domain = 'example.com', statsId = 'review-2968-store';
const original = redis.pipeline.bind(redis), beforeFetch = globalThis.fetch;
let commandsTotal = 0, providerCalls = 0;

async function main() {
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider operation permitted'); }) as typeof fetch;
  try {
    for (const mode of ['healthy', 'missing', 'invalid', 'link-throw', 'flag-throw', 'flag-unknown', 'stopped', 'everyone'] as const) {
      part(mode); redis.pipeline = original; redis.clear();
      // Fixture setup and direct observations are outside application command counts.
      if (mode !== 'missing') await original([['SET', linkKey(token), JSON.stringify({ s: statsId, id: 'synthetic-pitch', d: domain, n: 'Synthetic creator' })]]);
      if (mode === 'stopped') await original([['SADD', `nl:outreach:${statsId}:stop`, domain]]);
      if (mode === 'everyone') await original([['SADD', 'nl:outreach:stop:all', domain]]);
      let commands = 0, injections = 0, writes = 0;
      redis.pipeline = async batch => {
        if (commands + batch.length > 40 || commandsTotal + batch.length > 320) throw Error('Synthetic command admission exceeded');
        commands += batch.length; commandsTotal += batch.length;
        writes += batch.filter(c => /^(?:SET|SADD|HSET|HDEL|DEL|ZADD|ZREM)$/.test(String(c[0]))).length;
        if (mode === 'link-throw' && batch.some(c => c[0] === 'GET' && c[1] === linkKey(token))) { injections++; throw Error('Synthetic selected link GET failure'); }
        if ((mode === 'flag-throw' || mode === 'flag-unknown') && batch.length === 2 && batch.every(c => c[0] === 'SISMEMBER')) {
          injections++;
          if (mode === 'flag-throw') throw Error('Synthetic selected stop-state read failure');
          return [null, null];
        }
        return original(batch);
      };
      const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: mode === 'invalid' ? 'invalid!' : token }), searchParams: Promise.resolve({}) }));
      const forms = [...html.matchAll(/<form\b[^>]*action="\/api\/outreach\/stop"[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]);
      const scopes = forms.map(f => /name="scope"\s+value="([^"]*)"/.exec(f)?.[1] ?? '').sort();
      const writesBeforeAction = writes;
      is(`${mode}: rendering performs no write`, writes, 0);
      is(`${mode}: injection count is exact`, injections, mode === 'link-throw' || mode === 'flag-throw' || mode === 'flag-unknown' ? 1 : 0);
      if (mode === 'link-throw' || mode === 'flag-throw') {
        is(`${mode}: read failure is not asserted to be a missing link`, html.includes('This link is not one we know'), false);
        is(`${mode}: read failure is identified`, html.includes('This link could not be read just now'), true);
        is(`${mode}: both explicit stop scopes remain actionable`, scopes, ['all', 'store']);
        is(`${mode}: unavailable page makes no positive stop claim`, html.includes('cannot write to you again') || html.includes('Nobody here can write to you'), false);
        if (mode === 'flag-throw') {
          // The state-read outage does not prevent the real stop action's GET/HGET/SADD path.
          const applied = await stopFromLink(token, false, 1_800_000_000);
          const [kept] = await original([['SISMEMBER', `nl:outreach:${statsId}:stop`, domain]]);
          is('flag-throw: the real stop action remains available despite the hidden control', applied, true);
          is('flag-throw: the synthetic stop actually took effect', kept, 1);
        }
      } else if (mode === 'missing' || mode === 'invalid') {
        is(`${mode}: confirmed missing or invalid remains the missing-link state`, html.includes('This link is not one we know'), true);
        is(`${mode}: no action is offered without a usable token`, scopes, []);
        if (mode === 'invalid') is('invalid: no storage read is dispatched', commands, 0);
      } else {
        is(`${mode}: action scopes match confirmed state`, scopes, mode === 'everyone' ? [] : mode === 'stopped' ? ['all'] : ['all', 'store']);
        is(`${mode}: every offered action carries the original token`, forms.every(f => f.includes(`name="p" value="${token}"`)), true);
      }
      console.log('OUTREACH_STOP_REVIEW_OBSERVATION', JSON.stringify({ mode, commands, injections, scopes, writesBeforeAction }));
    }
    is('no actual provider operation was attempted', providerCalls, 0);
    console.log('OUTREACH_STOP_REVIEW_COMMANDS', commandsTotal);
    done();
  } finally { redis.pipeline = original; globalThis.fetch = beforeFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
