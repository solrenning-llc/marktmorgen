/** Independent #2969 review: the real page, team/store readers and MemoryRedis. */
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import Page from '@/app/signin/join/page';
import { store as redis } from './redis-stub';
import { done, is, part } from './check';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const token = 'e'.repeat(64), sid = 'd'.repeat(32), owner = 'owner@example.com';
const inviteKey = `nl:team:invite:${hash(`nimbus-team-invite:${token}`).slice(0, 40)}`;
const id = hash(`nimbus-team-invite-id:${token}`).slice(0, 16);
const teamKey = `nl:team:${sid}`, ownerKey = `nl:store:owner:${hash(`nimbus-store:${owner}`).slice(0, 40)}`;
const storeIdKey = `nl:store:id:${sid}`, expired = '/signin?status=invite-expired';
const original = redis.pipeline.bind(redis), beforeFetch = globalThis.fetch;
let applicationTotal = 0, setupTotal = 0, observationTotal = 0, providerCalls = 0;

async function main() {
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider request permitted'); }) as typeof fetch;
  try {
    for (const mode of ['healthy', 'missing', 'invalid', 'invite-throw', 'team-throw', 'store-owner-throw', 'invite-envelope-missing', 'team-envelope-missing'] as const) {
      part(mode); redis.pipeline = original; redis.clear();
      const claim = JSON.stringify({ sid, id, email: 'helper@example.com', role: 'editor' });
      const team = JSON.stringify({ members: [], invites: [{ id, email: 'helper@example.com', role: 'editor', createdAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + 3600 }] });
      const stored = JSON.stringify({ sid, email: owner, handle: 'synthetic-join', name: 'Synthetic join store' });
      const setup: (string | number)[][] = [['SET', storeIdKey, owner], ['SET', ownerKey, stored], ['SET', teamKey, team], ...(mode === 'missing' ? [] : [['SET', inviteKey, claim]])];
      if (setupTotal + setup.length > 32) throw Error('Fixture setup admission exceeded');
      setupTotal += setup.length; await original(setup);
      let commands = 0, injections = 0, writes = 0;
      redis.pipeline = async batch => {
        if (commands + batch.length > 2000 || applicationTotal + batch.length > 16000) throw Error('Application dispatch admission exceeded');
        commands += batch.length; applicationTotal += batch.length;
        writes += batch.filter(c => /^(?:GETDEL|SET|DEL|HSET|HDEL|SADD|SREM|EXPIRE|INCR|ZADD|ZREM|LPUSH|LTRIM|EVAL)$/.test(String(c[0]))).length;
        const selected = batch.length === 1 && batch[0][0] === 'GET' && (
          ((mode === 'invite-throw' || mode === 'invite-envelope-missing') && batch[0][1] === inviteKey)
          || ((mode === 'team-throw' || mode === 'team-envelope-missing') && batch[0][1] === teamKey)
          || (mode === 'store-owner-throw' && batch[0][1] === ownerKey));
        if (selected) {
          injections++;
          if (mode === 'invite-envelope-missing' || mode === 'team-envelope-missing') return [];
          throw Error(`Synthetic selected ${mode} transport failure`);
        }
        return original(batch);
      };
      let html = '', redirect: string | null = null, error: string | null = null;
      try { html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ token: mode === 'invalid' ? 'invalid!' : token }) })); }
      catch (caught) {
        const digest: unknown = caught && typeof caught === 'object' && 'digest' in caught ? caught.digest : null;
        if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;')) redirect = digest.split(';')[2];
        else error = String(caught);
      }
      if (observationTotal + 3 > 24) throw Error('Direct observation admission exceeded');
      observationTotal += 3;
      const [keptClaim, keptTeam, keptStore] = await original([['GET', inviteKey], ['GET', teamKey], ['GET', ownerKey]]);
      is(`${mode}: no unexpected crash`, error, null);
      is(`${mode}: rendering does not mutate storage`, writes, 0);
      is(`${mode}: exact selected injection count`, injections, mode === 'healthy' || mode === 'missing' || mode === 'invalid' ? 0 : 1);
      is(`${mode}: invitation is not spent`, keptClaim, mode === 'missing' ? null : claim);
      is(`${mode}: team is not changed`, keptTeam, team);
      is(`${mode}: store is not changed`, keptStore, stored);
      if (mode === 'healthy') {
        is('healthy: real fixture reaches the join heading', html.includes('Join Synthetic join store'), true);
        is('healthy: original join POST and token remain', html.includes('action="/api/auth/join"') && html.includes(`name="token" value="${token}"`), true);
        is('healthy: no redirect', redirect, null);
      } else if (mode === 'missing' || mode === 'invalid') {
        is(`${mode}: confirmed missing or invalid retains expired redirect`, redirect, expired);
        if (mode === 'invalid') is('invalid: no storage request', commands, 0);
      } else {
        is(`${mode}: unconfirmed read is unavailable, never expired`, [redirect, html.includes('Your invitation could not be read just now')], [null, true]);
        is(`${mode}: no join action is offered on an unconfirmed read`, html.includes('action="/api/auth/join"'), false);
      }
      console.log('JOIN_STATE_REVIEW_OBSERVATION', JSON.stringify({ mode, redirect, commands, injections, writes }));
    }
    is('no actual provider operation was attempted', providerCalls, 0);
    console.log('JOIN_STATE_REVIEW_COMMANDS', JSON.stringify({ applicationTotal, setupTotal, observationTotal, overall: applicationTotal + setupTotal + observationTotal }));
    done();
  } finally { redis.pipeline = original; globalThis.fetch = beforeFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
