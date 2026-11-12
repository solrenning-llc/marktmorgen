/**
 * Codex G's audit proof of 06/11/2026 (codex/g-audit-passkey-move-20261106@4ebd6fe3), kept as a permanent test of
 * lot L10b (#2723): both its parts run here, the lost index reply and the unknown passkey list (its
 * G_PASSKEY_UNKNOWN=1 part). An unreadable list is never "none": a move is refused and both lists stay.
 */
import { createHash } from 'node:crypto';
import { listPasskeys, movePasskeys, signInOptions, signInWith } from '@/lib/passkeys';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { makePasskey } from './passkey-world';
import { store as redis } from './redis-stub';
import { is, part, done } from './check';

globalThis.fetch = (async () => { throw new Error('External network forbidden in G proof'); }) as typeof fetch;
const hex = (value: string) => createHash('sha256').update(value).digest('hex').slice(0,40);
const listKey = (email: string) => `nl:pk:${hex(`nimbus-passkeys:${email}`)}`;
const credKey = (id: string) => `nl:pk:cred:${hex(`nimbus-passkey-id:${id}`)}`;
async function login(key: ReturnType<typeof makePasskey>) {
  const { options, nonce } = await signInOptions();
  return (await signInWith(nonce, key.answer(options.challenge) as AuthenticationResponseJSON))?.email ?? null;
}
async function main() {
  const original = redis.pipeline.bind(redis);
  {
    part('Applied index reply lost: one/two credentials, failure before/after persistence');
    for (const count of [1,2]) for (const mode of ['before-throw','after-throw','after-empty','after-null','after-false']) {
      redis.clear();
      const from = 'g-source@example.test', to = 'g-dest@example.test';
      const keys = Array.from({length:count}, (_,i) => makePasskey(from,`g-credential-${i}`));
      for (const key of keys) await key.keep();
      const index = credKey(`g-credential-${count-1}`);
      let hit = 0;
      redis.pipeline = (async commands => {
        if (!hit && commands.some(c => c[0]==='EVAL' && String(c[1]).startsWith('-- marktmorgen:fenced-set:') && c[4]===index && c[6]===to)) {
          hit++;
          if (mode!=='before-throw') await original(commands);
          if (mode.endsWith('throw')) throw new Error('G injected lost index reply');
          return mode==='after-empty' ? [] : [mode==='after-null' ? null : false];
        }
        return original(commands);
      }) as typeof redis.pipeline;
      const result = await movePasskeys(from,to).then(()=> 'moved',()=> 'refused');
      redis.pipeline = original;
      is(`${count}/${mode}: exact injection hit`,hit,1);
      is(`${count}/${mode}: refused`,result,'refused');
      is(`${count}/${mode}: source list retained`,(await listPasskeys(from)).length,count);
      is(`${count}/${mode}: destination empty`,(await listPasskeys(to)).length,0);
      is(`${count}/${mode}: every owner restored`,await original(keys.map((_,i)=>['GET',credKey(`g-credential-${i}`)])),Array(count).fill(from));
      is(`${count}/${mode}: real signature sign-in retained`,await Promise.all(keys.map(login)),Array(count).fill(from));
    }
    redis.clear();
    const key = makePasskey('g-source@example.test','g-good'); await key.keep();
    await movePasskeys('g-source@example.test','g-dest@example.test');
    is('intact move transfers list',[(await listPasskeys('g-source@example.test')).length,(await listPasskeys('g-dest@example.test')).length],[0,1]);
    is('intact move transfers actual sign-in',await login(key),'g-dest@example.test');
  }
  {
    part('Known occupied destination and thrown source read refuse unchanged');
    for (const kind of ['known-occupied','thrown-read']) {
      redis.clear();
      const from='g-source@example.test', to='g-dest@example.test';
      const a=makePasskey(from,'g-control-a'); await a.keep();
      const b=makePasskey(to,'g-control-b'); if(kind==='known-occupied')await b.keep();
      redis.pipeline=(async commands=>{
        if(kind==='thrown-read' && commands.length===1 && commands[0][0]==='GET' && commands[0][1]===listKey(from))throw new Error('G unavailable read');
        return original(commands);
      }) as typeof redis.pipeline;
      const answer=await movePasskeys(from,to).then(()=> 'moved',()=> 'refused');
      redis.pipeline=original;
      is(`${kind}: refuses`,answer,'refused');
      is(`${kind}: source retained`,(await listPasskeys(from)).map(k=>k.id),['g-control-a']);
      is(`${kind}: destination retained`,(await listPasskeys(to)).map(k=>k.id),kind==='known-occupied'?['g-control-b']:[]);
      is(`${kind}: source sign-in retained`,await login(a),from);
    }
    part('Unknown source/destination list must refuse before deleting or overwriting');
    for (const side of ['source','destination']) for (const mode of ['empty','wrong-type','wrong-json']) {
      redis.clear();
      const from='g-source@example.test', to='g-dest@example.test';
      const source=makePasskey(from,'g-source-key'); await source.keep();
      const dest=makePasskey(to,'g-dest-key'); if(side==='destination')await dest.keep();
      const target=listKey(side==='source'?from:to);
      let hit=0;
      redis.pipeline=(async commands=>{
        if(!hit && commands.length===1 && commands[0][0]==='GET' && commands[0][1]===target){
          hit++;
          return mode==='empty'?[]:mode==='wrong-type'?[false]:['{}'];
        }
        return original(commands);
      }) as typeof redis.pipeline;
      const result=await movePasskeys(from,to).then(()=> 'moved',()=> 'refused');
      redis.pipeline=original;
      is(`${side}/${mode}: exact injection hit`,hit,1);
      is(`${side}/${mode}: unknown refuses move`,result,'refused');
      is(`${side}/${mode}: source retained`,(await listPasskeys(from)).map(k=>k.id),['g-source-key']);
      is(`${side}/${mode}: destination retained`,(await listPasskeys(to)).map(k=>k.id),side==='destination'?['g-dest-key']:[]);
      is(`${side}/${mode}: source still signs in`,await login(source),from);
      if(side==='destination')is(`${side}/${mode}: destination still signs in`,await login(dest),to);
    }
  }
  done();
}
main().catch(e=>{ console.error(e);process.exitCode=1; });
