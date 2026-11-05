/** Actual sender/guard with synthetic HTTP and MemoryRedis. No real account. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {auditMeterPreflight} from './email-meter-preflight-world';

test('selected known-unavailable routes preserve mail allowances before dispatch',async t=>{
 const report=await auditMeterPreflight();
 const zero=new Set(['single_NULL_default','batch_NULL_default','list_only_no_SES','only_amazon_no_SES_even_with_funded_Resend_runtime','only_resend_with_configured_SES_but_NULL_fallback','funded_NULL_finance_before_meter','invalid_single_before_meter','empty_batch_keeps_sent','empty_list_keeps_sent','invalid_batch_keeps_retry','runtime_present_but_remaining_quota_insufficient']);
 for(const row of report.scenarios)await t.test(String(row.name),()=>{
  if(zero.has(String(row.name)))assert.equal(row.spent,0,'no allowance taken for a known unavailable selected route');
  if(String(row.name).startsWith('external_meter_'))assert.deepEqual(row.keys,[]);
 });
 assert.equal(report.positiveSinglePosts,1);assert.equal(report.positiveBatchPosts,1);assert.equal(report.forbiddenExternalFetch,0);
});
