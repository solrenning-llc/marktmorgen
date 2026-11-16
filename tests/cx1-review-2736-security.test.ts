/** Opt-in independent security proof; all requests, credentials and sessions are synthetic. */
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { POST as requestRoute } from '@/app/api/auth/request/route';
import { POST as codeRoute } from '@/app/api/auth/email-code/route';
import { emailForSession, takeSignInLink } from '@/lib/auth';
import { store as redis } from './redis-stub';
import { installSesMailFixture } from './ses-mail-fixture';
import { is, done } from './check';

process.env.NIMBUS_DATA_KEY ??= 'tests-only-not-a-real-deployment-secret';
globalThis.fetch = (async () => { throw new Error('Unexpected external request in synthetic security proof'); }) as typeof fetch;
const mail = installSesMailFixture();
mail.configure();
let net = 1;
const origin = 'https://marktmorgen.com';
const json = (path: string, body: unknown) => new NextRequest(`${origin}${path}`, {
  method: 'POST',
  headers: { Host: 'marktmorgen.com', Origin: origin, 'Content-Type': 'application/json', 'x-forwarded-for': `192.0.2.${net++}` },
  body: JSON.stringify(body),
});

async function ask(email: string): Promise<{ request: string; token: string; code: string }> {
  const before = mail.sent.length;
  const response = await requestRoute(json('/api/auth/request', { email }));
  const data = await response.json() as { ok?: boolean; request?: string };
  const text = mail.sent.slice(before).find(message => message.to[0] === email)?.text ?? '';
  const token = /token=([0-9a-f]{64})/.exec(text)?.[1] ?? '';
  const code = /\n(\d{6})\n/.exec(text)?.[1] ?? '';
  if (!data.ok || !data.request || code.length !== 6 || token.length !== 64) throw new Error('Synthetic issuance fixture failed');
  return { request: data.request, token, code };
}

async function send(request: string, code: string) {
  const response = await codeRoute(json('/api/auth/email-code', { request, code }));
  const data = await response.json() as { ok?: boolean; error?: string };
  const session = (response.headers.get('set-cookie') ?? '').match(/nl_session=([0-9a-f]{64})/)?.[1] ?? '';
  return { status: response.status, ...data, session };
}

async function main() {
  redis.clear();
  const good = await ask('cx1good@review.example');
  const accepted = await send(good.request, good.code);
  is('exact accepted code control',
    [accepted.status, accepted.ok, accepted.session.length, await emailForSession(accepted.session)],
    [200, true, 64, 'cx1good@review.example']);
  is('code consumes its own link control', await takeSignInLink(good.token), null);

  const uncertain = await ask('cx1reply@review.example');
  const uncertainLink = `nl:auth:link:${createHash('sha256').update(`nimbus-auth-link:${uncertain.token}`).digest('hex').slice(0, 40)}`;
  const uncertainRecord = `nl:auth:code:${createHash('sha256').update(`nimbus-auth-code:${uncertain.request}`).digest('hex').slice(0, 40)}`;
  const normal = redis.pipeline.bind(redis);
  let malformed = 0;
  redis.pipeline = async commands => {
    // Execute the real consume (or its corrective script). Change exactly
    // one returned outer envelope; the command's effect remains real.
    const reply = await normal(commands);
    const consuming = commands.length === 1 && (
      (commands[0][0] === 'GETDEL' && commands[0][1] === uncertainLink) ||
      (commands[0][0] === 'EVAL' && commands[0].slice(1).some(value => value === uncertainLink || value === uncertainRecord)));
    if (malformed === 0 && consuming) {
      malformed++;
      return [...reply, null];
    }
    return reply;
  };
  let bad: Awaited<ReturnType<typeof send>>;
  try { bad = await send(uncertain.request, uncertain.code); }
  finally { redis.pipeline = normal; }
  if (malformed !== 1) throw new Error('Final consume injection not reached exactly once');
  is('unknown final consume envelope must open no session',
    [bad.status >= 400, bad.session.length, await emailForSession(bad.session)], [true, 0, null]);

  const previous = await ask('cx1order@review.example');
  await ask('cx1order@review.example');
  is('sequential replacement control', (await send(previous.request, previous.code)).error, 'code_expired');

  const older = await ask('cx1race@review.example');
  const olderLink = `nl:auth:link:${createHash('sha256').update(`nimbus-auth-link:${older.token}`).digest('hex').slice(0, 40)}`;
  const olderRecord = `nl:auth:code:${createHash('sha256').update(`nimbus-auth-code:${older.request}`).digest('hex').slice(0, 40)}`;
  const holder: { newest?: Awaited<ReturnType<typeof ask>> } = {};
  let armed = true;
  redis.pipeline = async commands => {
    // A newer real issuance completes immediately BEFORE the old link's
    // consume. Every reply is exact. Also support a corrective atomic EVAL
    // that checks the latest record together with its consume: that script
    // must see the newer record. This does not require the old counter shape.
    const consumesOld = commands.some(command =>
      (command[0] === 'GETDEL' && command[1] === olderLink) ||
      (command[0] === 'EVAL' && command.slice(1).some(value => value === olderLink || value === olderRecord)));
    if (armed && consumesOld) {
      armed = false;
      holder.newest = await ask('cx1race@review.example');
    }
    return normal(commands);
  };
  let raced: Awaited<ReturnType<typeof send>>;
  try { raced = await send(older.request, older.code); }
  finally { redis.pipeline = normal; }
  if (!holder.newest?.request || holder.newest.request === older.request) throw new Error('Newer real issuance did not complete');
  is('code replaced after latest-read but before consume must not open',
    [raced.status >= 400, raced.session.length, await emailForSession(raced.session)], [true, 0, null]);
  const newest = await send(holder.newest.request, holder.newest.code);
  is('newest code remains usable control',
    [newest.ok, newest.session.length, await emailForSession(newest.session)], [true, 64, 'cx1race@review.example']);

  // Conditional threat model: read-only access to the Redis verifier, not
  // access to the inbox, any deployment secret, or a write to auth records.
  // This issuer deliberately reads ONLY the public request response.
  const publicResponse = await requestRoute(json('/api/auth/request', { email: 'cx1offline@review.example' }));
  const publicBody = await publicResponse.json() as { request?: string };
  if (!publicBody.request) throw new Error('Public issuance fixture failed');
  const requestId = publicBody.request;
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const record = `nl:auth:code:${sha256(`nimbus-auth-code:${requestId}`).slice(0, 40)}`;
  const verifier = (await normal([['HGET', record, 'h']]))[0];
  is('offline case has spent no online guesses control', (await normal([['HGET', record, 'n']]))[0], '0');
  let recovered = '';
  if (typeof verifier === 'string' && /^[0-9a-f]{64}$/.test(verifier)) {
    for (let number = 0; number < 1_000_000; number++) {
      const candidate = String(number).padStart(6, '0');
      if (sha256(`nimbus-auth-code-value:${requestId}:${candidate}`) === verifier) {
        recovered = candidate;
        break;
      }
    }
  }
  const fromDatabase = recovered ? await send(requestId, recovered) : null;
  is('public request plus read-only verifier must not recover a usable secret',
    [recovered.length === 0, fromDatabase?.session.length ?? 0, fromDatabase ? await emailForSession(fromDatabase.session) : null],
    [true, 0, null]);

  mail.restore();
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
