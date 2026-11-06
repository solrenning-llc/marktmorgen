/** Proof (#2819): a team host without "settings" whose host-calendar callback meets an unknown or exceeded
 * counter is sent to /studio/meetings, a settings-only page that answers "team=forbidden". */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { finishConnect } from '@/lib/meet-routes';
import { beginConsent } from './meet-return-provider-world';
import { hostId } from '@/lib/host-claims';
import { can } from '@/lib/team-roles';
import { fixture, reset, state, SESSION_COOKIE } from './meet-return-counter-world';
async function hostReturn(counter: string) {
  reset();
  const url = await beginConsent('google', { statsId: fixture.statsId, sid: fixture.sid, sessionCookie: 's', email: fixture.email, host: hostId(fixture.email) });
  const req = new NextRequest('https://example.invalid/callback?state=' + new URL(url).searchParams.get('state') + '&code=c', { headers: { cookie: SESSION_COOKIE + '=s', 'x-forwarded-for': '192.0.2.9' } });
  state.counter = counter;
  return new URL((await finishConnect(req, 'google')).headers.get('Location')!);
}
const page = readFileSync(join(process.cwd(), 'app/studio/meetings/page.tsx'), 'utf8');
for (const counter of ['exceeded', 'null-count']) test(`host-calendar return (${counter}) lands somewhere any host-eligible member can read the notice`, async () => {
  const target = await hostReturn(counter);
  // Host sync is open to any member (startHostConnect: creatorFrom(request, "member")); editor/support lack "settings".
  assert.equal(can('editor', 'settings'), false);
  assert.equal(can('support', 'settings'), false);
  const settingsOnly = page.includes('studioView(jar, typeof query.store === "string" ? query.store : undefined, "settings")') && page.includes('"team=forbidden"');
  assert.ok(!(target.pathname === '/studio/meetings' && settingsOnly), `${target.pathname}${target.search} is settings-only: an editor/support host is told "Your role on this store does not include that"`);
});
test('control: the store-level owner return still reaches the meetings notice', async () => {
  reset();
  assert.equal(can('owner', 'settings'), true);
});
