/** Independent opt-in G return proof. No account or provider is contacted. */
import { createHash } from 'node:crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { MAX_PASSKEYS, listPasskeys, movePasskeys, signInOptions, signInWith } from '@/lib/passkeys';
import { makePasskey } from './passkey-world';
import { store as redis } from './redis-stub';
import { is, done } from './check';
globalThis.fetch=(async()=>{throw new Error('G proof prohibits external requests');}) as typeof fetch;
const from='g-bounded-source@example.test',to='g-bounded-dest@example.test';
const listKey=(email:string)=>`nl:pk:${createHash('sha256').update(`nimbus-passkeys:${email}`).digest('hex').slice(0,40)}`;
async function login(key:ReturnType<typeof makePasskey>){const {options,nonce}=await signInOptions();return (await signInWith(nonce,key.answer(options.challenge) as AuthenticationResponseJSON))?.email??null;}
async function main(){
 const base=redis.pipeline.bind(redis);
 for(const corrupt of [false,true,"duplicate-only","size-only"]){
  redis.clear();
  const keys=Array.from({length:MAX_PASSKEYS},(_,i)=>makePasskey(from,`g-bound-${i}`));
  for(const key of keys)await key.keep();
  const [raw]=await base([['GET',listKey(from)]]);
  const rows=JSON.parse(String(raw));
  let hit=0;
  redis.pipeline=(async commands=>{
   if(corrupt&&!hit&&commands.length===1&&commands[0][0]==='GET'&&commands[0][1]===listKey(from)){
    hit++;
    const bad=corrupt==="duplicate-only"?[rows[0],...rows.slice(0,MAX_PASSKEYS-1)]:corrupt==="size-only"?[...rows,{...rows[0],id:"g-extra-unique"}]:[rows[0],...rows];
    return [JSON.stringify(bad)];
   }
   return base(commands);
  }) as typeof redis.pipeline;
  const result=await movePasskeys(from,to).then(()=>'moved',()=> 'refused');
  redis.pipeline=base;
  is(`${String(corrupt)}: injection`,hit,corrupt?1:0);
  is(`${String(corrupt)}: result`,result,corrupt?'refused':'moved');
  is(`${String(corrupt)}: source length`,(await listPasskeys(from)).length,corrupt?MAX_PASSKEYS:0);
  is(`${String(corrupt)}: destination length`,(await listPasskeys(to)).length,corrupt?0:MAX_PASSKEYS);
  is(`${String(corrupt)}: tenth original can sign in`,await login(keys[MAX_PASSKEYS-1]),corrupt?from:to);
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
