import { NextRequest } from 'next/server';
import { claimHandle, ensureStatsId } from '@/lib/store';
import { openSession, SESSION_COOKIE } from '@/lib/auth';
import { GET, POST } from '@/app/api/store/saved-blocks/route';
import { done, is } from './check';

async function main() {
  globalThis.fetch = (async () => { throw new Error('No external service is permitted in this proof'); }) as typeof fetch;
  const email = 'g2178@example.com';
  await claimHandle(email, 'g2178proof', 'Own synthetic proof', '');
  await ensureStatsId(email);
  const session = await openSession(email);
  const headers = { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${session}` };
  const url = 'https://marktmorgen.com/api/store/saved-blocks';
  const send = async (body: unknown) => POST(new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) }));
  const booking = { id: 'book0001', kind: 'booking', product: 'call000001', heading: 'Reserve a call' };
  const refused = await send({ action: 'save', name: 'Forged call', blocks: [booking] });
  is('real POST refuses a well-shaped booking section', [refused.status, await refused.json()], [400, { ok: false, error: 'kind' }]);
  const list = await GET(new NextRequest(url, { headers }));
  const listed = await list.json();
  is('refused POST leaves no section stored', listed.sections.length, 0);
  const good = await send({ action: 'save', name: 'Text', blocks: [{ id: 'text0001', kind: 'text', heading: 'Welcome', body: 'Read this.' }] });
  const saved = await good.json();
  is('control ordinary POST still succeeds', [good.status, saved.ok], [200, true]);
  const changed = await send({ action: 'update', id: saved.section.id, blocks: [booking] });
  is('real update also refuses booking', [changed.status, await changed.json()], [400, { ok: false, error: 'kind' }]);
  const final = await (await GET(new NextRequest(url, { headers }))).json();
  is('failed update preserves ordinary stored section', final.sections.find((s: { id: string }) => s.id === saved.section.id)?.blocks.map((b: { kind: string }) => b.kind), ['text']);
  done();
}
main().catch(e => { console.error(e); process.exit(1); });
