import test from 'node:test';
import assert from 'node:assert/strict';
import { hostSync, hostCalendarKeys, MAX_ICS_URL } from '@/lib/host-calendar';
import { hostId } from '@/lib/host-claims';
import { seal } from '@/lib/secret-box';
import { TEAM_READING, COMMAND, DB_BYTE } from './plan-cost-registry';
import { VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR, VERCEL_CPU_MICRO_USD_PER_HOUR } from '@/lib/spend-cost-table';
import { store as redis } from './redis-stub';
import { state } from './host-calendar-late-refresh-world';
process.env.NIMBUS_DATA_KEY='a-local-key-for-tests-only-0123456789abcdef';
const email='byte-proof@example.com', host=hostId(email), [cfg]=hostCalendarKeys(host);
test('the registered host read funds its added config argument and fence script, besides its nine commands',async()=>{
  redis.clear();state.fails=false;state.during=async()=>{};
  const url='https://calendar.example.test/'+ 'a'.repeat(MAX_ICS_URL-'https://calendar.example.test/'.length);
  const raw=JSON.stringify({email,source:'ics',read:[],write:'',ics:seal(url,`hostcal|${host}|ics`),icsAddedAt:'2026-11-20'});
  redis.run(['SET',cfg,raw]);const run=redis.pipeline.bind(redis);let addedBytes=0;
  redis.pipeline=async commands=>{const c=commands[0];if(c?.[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:host-reading-current:v1\n'))addedBytes=Buffer.byteLength(String(c[6]))+Buffer.byteLength(String(c[1]));return run(commands);};
  try {
    assert.equal((await hostSync({statsId:'host-bytes'},email,'UTC',{force:true,now:state.now})).state,'ok');
    assert.ok(addedBytes>1000,'a real writer-format config and actual EVAL script were captured');
    const oldCompute=9*COMMAND+VERCEL_FUNCTION_GB*VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR/1e6/3600+0.05*VERCEL_CPU_MICRO_USD_PER_HOUR/1e6/3600;
    assert.ok(TEAM_READING>=oldCompute+addedBytes*DB_BYTE,'the exact fenced operation adds transfer that the registry must fund');
  } finally {redis.pipeline=run;}
});
test('an oversized raw config is unknown before it can be forwarded into a refresh EVAL',async()=>{
  redis.clear();state.fails=false;let reads=0;state.during=async()=>{reads++;};
  const raw=JSON.stringify({email,source:'ics',read:[],write:'',ics:seal('https://calendar.example.test/a.ics',`hostcal|${host}|ics`),icsAddedAt:'2026-11-20',unknownPadding:'a'.repeat(100_000)});
  redis.run(['SET',cfg,raw]);
  const result=await hostSync({statsId:'host-bytes'},email,'UTC',{force:true,now:state.now});
  assert.equal(result.state,'failed');assert.equal(reads,0,'oversized source remains unknown before a provider read');
});
