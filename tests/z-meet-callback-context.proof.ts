/** Author RED for C5 6701844921; declared provider/auth/funding stand-ins, not R2 approval. */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { NextRequest } from 'next/server';
import { finishConnect } from '@/lib/meet-routes';
import { hostId } from '@/lib/host-claims';
import { beginConsent } from './meet-return-provider-world';
import { fixture, reset, state, SESSION_COOKIE } from './meet-return-counter-world';

let commands = 0;
let callbacks = 0;
for (const kind of ['google', 'zoom', 'host'] as const) {
  for (const mode of ['exceeded', 'null-count'] as const) {
    test(kind + ' callback keeps its retry context: ' + mode, async () => {
      // Admission before synthetic dispatch: one consent SET and two counter commands.
      assert.ok(commands + 3 <= 100);
      assert.ok(callbacks + 1 <= 6);
      reset();
      const provider = kind === 'zoom' ? 'zoom' : 'google';
      const url = await beginConsent(provider, {
        statsId: fixture.statsId, sid: fixture.sid, sessionCookie: 'synthetic-session',
        email: fixture.email, ...(kind === 'host' ? { host: hostId(fixture.email) } : {}),
      });
      assert.equal(state.commands.length, 1, 'one synthetic setup command');
      commands += state.commands.length;
      state.commands.length = 0;
      state.counter = mode;
      const req = new NextRequest('https://example.invalid/callback?state=' +
        new URL(url).searchParams.get('state') + '&code=synthetic-code', {
        headers: { cookie: SESSION_COOKIE + '=synthetic-session', 'x-forwarded-for': '192.0.2.1' },
      });
      callbacks++;
      const response = await finishConnect(req, provider);
      commands += state.commands.length;
      assert.equal(response.status, 303);
      assert.equal(state.commands.length, 2);
      assert.deepEqual(state.commands.map(c => c[0]), ['SET', 'INCR']);
      assert.equal(state.providerCalls, 0);
      assert.equal(state.accessCalls, 0);
      assert.equal(state.fundingCalls, 0);
      assert.equal(await response.text(), '');
      const target = new URL(response.headers.get('Location')!);
      const host = kind === 'host';
      assert.equal(target.searchParams.get(host ? 'cal' : 'meet'),
        mode === 'exceeded' ? 'limited' : 'error', 'retry notice uses the correct flow query');
      assert.equal(target.pathname, host ? '/studio/calendar' : '/studio/meetings',
        'store connections need the store retry control; host must keep its member page');
      assert.equal(target.searchParams.get('p'), provider);
    });
  }
}
after(() => console.log('Synthetic totals:', JSON.stringify({ commands, callbacks, externalRequests: 0 })));
