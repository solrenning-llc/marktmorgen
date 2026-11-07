/** Independent #3016: bounded real count reader, public page and MemoryRedis. */
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import Page from '@/app/[handle]/community/about/page';
import { aboutCounts, aboutWords, ABOUT_POSTS_READ, ABOUT_POST_BYTES } from '@/lib/community-about';
import { freshConfig } from '@/lib/community';
import type { Store } from '@/lib/store';
import { DEFAULT_LOOK } from '@/lib/store-look';
import { takePublicRequest } from '@/lib/traffic';
import { requestLimitFor } from '@/lib/traffic-rules';
import { store as redis } from './redis-stub';
import { ROOM } from './data-room';
import { paidPeriod } from './billing-period-fixture';
import { done, is, part } from './check';

const now = Date.now(), at = Math.floor(now / 1000), id = 'd'.repeat(32), owner = 'about-proof@example.com';
const store = { ...ROOM, sid: 'e'.repeat(32), email: owner, extra: false, cycle: 'month', period: paidPeriod(now), name: 'Synthetic public club', handle: 'about-proof', language: 'en', currency: 'usd', look: DEFAULT_LOOK, statsId: 'f'.repeat(32), community: { id, on: true }, suspended: '', sitePages: [] } as unknown as Store;
const config = { ...freshConfig(store.name), name: 'Synthetic community', about: 'Public synthetic description.', access: [], page: { on: true, counts: true } };
const key = (part: string) => `nl:cm:${id}:${part}`;
const ownerKey = `nl:store:owner:${createHash('sha256').update(`nimbus-store:${owner}`).digest('hex').slice(0, 40)}`;
const original = redis.pipeline.bind(redis), beforeFetch = globalThis.fetch;
let allCommands = 0, allPostBytes = 0, providerCalls = 0;

async function main() {
  globalThis.fetch = (async () => { providerCalls++; throw Error('No external provider IO permitted'); }) as typeof fetch;
  try {
    for (const mode of ['empty', 'visible', 'hidden-window', 'future-time', 'nonfinite-time', 'unknown-hlen', 'oversized-feed', 'refused-refresh'] as const) {
      part(mode); redis.pipeline = original; redis.clear();
      let commands = 0, postBytes = 0, injecting = false, injections = 0;
      const seen: (string | number)[][] = [], widths: number[] = [];
      const ids: string[] = [];
      redis.pipeline = async batch => {
        if (commands + batch.length > 1250 || allCommands + batch.length > 10000) throw Error('Own application command admission exceeded');
        const posts = batch.filter(c => c[0] === 'MGET' && c.slice(1).some(k => String(k).startsWith(key('p:'))));
        const nextBytes = posts.reduce((n, c) => n + (c.length - 1) * ABOUT_POST_BYTES, 0);
        if (posts.some(c => c.length - 1 > 32) || postBytes + nextBytes > 1024 * 1024 || allPostBytes + nextBytes > 8 * 1024 * 1024) throw Error('Local synthetic MGET dimension admission exceeded');
        commands += batch.length; allCommands += batch.length; postBytes += nextBytes; allPostBytes += nextBytes;
        widths.push(...posts.map(c => c.length - 1)); seen.push(...batch);
        const result = await original(batch);
        return result.map((value, index) => {
          if (injecting && mode === 'unknown-hlen' && batch[index][0] === 'HLEN') { injections++; return 'QUEUED'; }
          if (injecting && mode === 'oversized-feed' && batch[index][0] === 'ZREVRANGE') { injections++; return ids; }
          return value;
        });
      };
      await redis.pipeline([
        ['SET', ownerKey, JSON.stringify(store)], ['SET', `nl:store:handle:${store.handle}`, owner], ['SET', key('cfg'), JSON.stringify(config)],
        ['HSET', key('m'), 'a'.repeat(32), JSON.stringify({ k: 'a'.repeat(32), n: 'PRIVATE_MEMBER_SENTINEL', e: 'synthetic-member@example.com', at, seen: at })],
      ]);
      const size = mode === 'empty' ? 0 : mode === 'hidden-window' ? 21 : mode === 'oversized-feed' ? 25 : 1;
      for (let index = 0; index < size; index++) {
        const postId = index.toString(16).padStart(24, '0'); ids.push(postId);
        const hidden = mode === 'hidden-window' && index < 20;
        const timestamp = mode === 'future-time' ? at + 3600 : at - index - 1;
        const raw = mode === 'nonfinite-time' ? '{"at":1e309,"hid":false,"title":"PRIVATE_POST_SENTINEL"}' : JSON.stringify({ at: timestamp, hid: hidden, title: 'PRIVATE_POST_SENTINEL', text: 'PRIVATE_BODY_SENTINEL' });
        await redis.pipeline([['SET', key(`p:${postId}`), raw], ['ZADD', key('feed'), at - index, postId]]);
      }
      if (mode === 'refused-refresh') is('refused: existing synthetic allowance can be exhausted without changing a limit', await takePublicRequest(store, 'buyer', now, requestLimitFor(store)), true);
      const beforeRead = seen.length; injecting = true;
      const counts = await aboutCounts(store, id, config, now); injecting = false;
      const read = seen.slice(beforeRead);
      is(`${mode}: no member record or name is read`, read.some(c => ['HGET', 'HGETALL', 'HVALS', 'HSCAN'].includes(String(c[0])) && c[1] === key('m')), false);
      is(`${mode}: expected injection count`, injections, mode === 'unknown-hlen' || mode === 'oversized-feed' ? 1 : 0);
      is(`${mode}: result contains no private fields`, ['PRIVATE_MEMBER_SENTINEL', 'synthetic-member@example.com', 'PRIVATE_POST_SENTINEL', 'PRIVATE_BODY_SENTINEL'].some(s => JSON.stringify(counts).includes(s)), false);
      if (mode === 'empty') is('empty: confirmed empty feed is a genuine zero', counts?.posts, { n: 0, atLeast: false });
      if (mode === 'visible') is('visible: a valid recent post is counted', counts?.posts, { n: 1, atLeast: false });
      if (mode === 'hidden-window') {
        const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ handle: `@${store.handle}` }) }));
        is('hidden window: real public page renders the synthetic description', html.includes('Public synthetic description.'), true);
        is('hidden window: page does not claim zero while an older visible recent post exists', html.includes(aboutWords('en').posts(0, false)), false);
        is('hidden window: no member or post payload leaks into real SSR', ['PRIVATE_MEMBER_SENTINEL', 'synthetic-member@example.com', 'PRIVATE_POST_SENTINEL', 'PRIVATE_BODY_SENTINEL'].some(s => html.includes(s)), false);
      }
      if (mode === 'future-time') is('future time: a future post is not a post in the preceding 30 days', counts?.posts == null || counts.posts.n === 0, true);
      if (mode === 'nonfinite-time') is('nonfinite time: unknown timestamp does not become a confirmed post count', counts?.posts ?? null, null);
      if (mode === 'unknown-hlen') is('unknown member count: omitted, while known posts remain', counts && [counts.joined, counts.posts], [null, { n: 1, atLeast: false }]);
      if (mode === 'oversized-feed') {
        is('oversized feed: no downstream read escapes the declared 20-post bound', widths.every(n => n <= ABOUT_POSTS_READ), true);
        is('oversized feed: refresh was admitted at the source constant, not an expanded amount', read.some(c => c[0] === 'INCRBY' && String(c[1]).startsWith('nl:traffic:r:') && c[2] === 2), true);
      }
      if (mode === 'refused-refresh') {
        is('refused refresh: no count is fabricated', counts, null);
        is('refused refresh: no member/feed/post read after refusal', read.some(c => ['HLEN', 'ZREVRANGE', 'MGET'].includes(String(c[0])) && String(c[1]).startsWith(`nl:cm:${id}:`)), false);
      }
      console.log('PUBLIC_ABOUT_REVIEW_OBSERVATION', JSON.stringify({ mode, commands, widths, declaredPostBytes: postBytes, counts }));
    }
    is('no real provider operation attempted', providerCalls, 0);
    console.log('PUBLIC_ABOUT_REVIEW_ADMISSION', JSON.stringify({ cases: 8, allCommands, maxOwnCommands: 10000, allPostBytes, maxPostBytes: 8 * 1024 * 1024 })); done();
  } finally { redis.pipeline = original; globalThis.fetch = beforeFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
