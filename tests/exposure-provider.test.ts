import './frozen-clock'; // first: the fixture below names its month while it loads, and the code reads the month again
import test from 'node:test';
import assert from 'node:assert/strict';
import {askModel} from '@/lib/ai';
import {exposureBudgetConfiguration} from '@/lib/exposure-budget-policy';
import {fixture} from './exposure-budget-fixture';
import {reset,seed,ledger} from './exposure-budget-redis';
import {spendCalls,resetSpend} from './exposure-ai-spend-stub';
import type {Store} from '@/lib/store';
// tests/exposure-budget-fixture.ts makes `fixture` while it loads, naming the review month (zeroExposureFixture), and
// the code reads the month again before each provider call: a run crossing 00:00 UTC on a month's last day failed the
// reservation. tests/frozen-clock.ts stops Date before that module loads, for the whole run.
process.env.ANTHROPIC_API_KEY='sk-ant-'+ 'x'.repeat(40);
test('non-paying provider calls reserve the entire case before AI spending and never refund failures',async()=>{reset();resetSpend();const config=exposureBudgetConfiguration(fixture.policy,fixture.context)!;const key='nl:exposure:v1:'+config.month;seed(key,config);const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;assert.equal(Number(ledger.get(key)?.get('reserved'))>=100,true);return new Response('busy',{status:503});};try{const store={statsId:'one',tier:'creator'} as Store;assert.equal(await askModel(store,'system','prompt',100,'claude-sonnet-5-5'),null);assert.equal(await askModel(store,'system','prompt',100,'claude-sonnet-5-5'),null);assert.equal(calls,2);assert.equal(spendCalls,2);assert.equal(ledger.get(key)?.get('reserved'),'100');assert.equal(ledger.get(key)?.get('slots:trial'),'1');await askModel({...store,statsId:'two'},'system','prompt',100,'claude-sonnet-5-5');await askModel({...store,statsId:'three'},'system','prompt',100,'claude-sonnet-5-5');assert.equal(calls,3);assert.equal(spendCalls,3);assert.equal(ledger.get(key)?.get('reserved'),'200');}finally{globalThis.fetch=old;}});
