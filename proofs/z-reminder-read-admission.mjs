import { build } from '/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/esbuild/lib/main.js';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';

// This is an ordering proof, not a replay of the complete quota/funding implementation.
if (process.argv[2] === '--worker') {
  net.Socket.prototype.connect = () => { throw Error('External sockets forbidden'); };
  globalThis.fetch = async () => { throw Error('External fetch forbidden'); };
  const require = createRequire(import.meta.url);
  let commands = 0, admissions = 0, failures = 0;
  const observations = [];
  const store = { statsId: 'z-reminder', handle: 'z-reminder', stripeAccountId: 'fixture', suspended: false,
    assistReminder: { on: true }, recovery: { address: 'Synthetic postal address' } };
  const consent = JSON.stringify({ s: store.statsId, e: 'buyer@example.invalid', t: 'Synthetic consent', v: 'fixture', l: 'en', at: 1794000000000 });
  const { remindFromConsent } = require(process.argv[3]);
  for (const mode of ['refused-before-count', 'unknown', 'missing-consent', 'healthy']) {
    const events = []; let used = 0, charged = 0, stripe = 0, requestBytes = 0, replyBytes = 0, asked = 0;
    globalThis.__reminderWorld = {
      async pipeline(batch) {
        // Admit the complete batch BEFORE any synthetic dispatch, including setup/nested calls.
        if (commands + batch.length > 20) throw Error('Redis command ceiling');
        commands += batch.length; used += batch.length;
        if (JSON.stringify(batch.map(c => c[0])) !== '["GET","TTL"]') throw Error('Unexpected command path');
        events.push('GET+TTL');
        const reply = mode === 'missing-consent' ? [null, -2] : [consent, 120];
        requestBytes += Buffer.byteLength(JSON.stringify(batch)); replyBytes += Buffer.byteLength(JSON.stringify(reply));
        return reply;
      },
      async admit(units) {
        if (++admissions > 10) throw Error('Admission ceiling');
        asked++; events.push(`admit:${units}`);
        if (units !== 4) throw Error('Unexpected request units');
        if (mode === 'unknown') throw Error('Synthetic unknown admission');
        if (mode === 'refused-before-count') return false;
        charged += units; return true;
      },
      async stripe() { stripe++; events.push('Stripe stand-in'); return { status: 'complete' }; },
    };
    let outcome;
    try { outcome = await remindFromConsent(store, 'cs_test_zreminder000001', 1794000000000); }
    catch (error) { outcome = String(error.message); }
    const pass = mode === 'healthy'
      ? used === 2 && charged === 4 && asked === 1 && stripe === 1 && outcome === 'skip'
      : used === 0 && charged === 0 && stripe === 0;
    if (!pass) failures++;
    observations.push({ mode, events, commands: used, chargedPublicUnitsInStandIn: charged, admissionCalls: asked,
      stripeStandInCalls: stripe, requestBytes, replyBytes, outcome, pass });
  }
  console.log(JSON.stringify({ observations, commands, admissions, checks: 4, failures, externalCalls: 0 }, null, 2));
  process.exitCode = failures ? 1 : 0;
} else {
  const root = resolve(process.argv[2] || process.cwd());
  const source = readFileSync(join(root, 'lib/assistant-reminder.ts'), 'utf8');
  const rules = readFileSync(join(root, 'lib/assistant-reminder-rules.ts'), 'utf8');
  if (!/export const ASSIST_REMIND_REQUEST_UNITS = 4;/.test(rules)) throw Error('Request units changed');
  const names = new Map();
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*?)\}\s+from\s+["'](@\/lib\/[^"']+)["']/g)) {
    names.set(match[2], match[1].split(',').map(n => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean));
  }
  const custom = {
    isRedisConfigured: '()=>true', isSenderConfigured: '()=>true',
    redisPipeline: 'batch=>globalThis.__reminderWorld.pipeline(batch)',
    takeBuyerRead: '(_store,units)=>globalThis.__reminderWorld.admit(units)',
    onAccount: '()=>globalThis.__reminderWorld.stripe()',
    assistRemindKey: 'session=>`nl:assist:remind:${session}`',
    ASSIST_REMIND_REQUEST_UNITS: '4',
  };
  const out = mkdtempSync(join(tmpdir(), 'z-reminder-admission-'));
  try {
    const bundle = join(out, 'reminder.cjs');
    await build({ entryPoints: [join(root, 'lib/assistant-reminder.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
      logLevel: 'error', plugins: [{ name: 'explicit-ordering-boundaries', setup(b) {
        b.onResolve({ filter: /^@\/lib\// }, a => ({ path: a.path, namespace: 'boundary' }));
        b.onLoad({ filter: /.*/, namespace: 'boundary' }, a => ({ loader: 'js', contents: (names.get(a.path) || []).map(name =>
          `export const ${name}=${custom[name] || `()=>{throw Error('Unexpected boundary ${name}')}`};`).join('\n') }));
      } }] });
    const r = spawnSync(process.execPath, ['--max-old-space-size=512', resolve(process.argv[1]), '--worker', bundle],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 131072 });
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    if (r.error) throw r.error;
    process.exitCode = r.status === 0 ? 0 : 1;
  } finally { rmSync(out, { recursive: true, force: true }); }
}
