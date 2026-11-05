import assert from 'node:assert/strict';
import {test} from 'node:test';
import {auditCourseMail,proveAvailableCourseMail} from './course-link-mail-world';
const proof=auditCourseMail();
test('known-unavailable course-link attempt preserves the buyer access allowance',async()=>{const r=await proof;assert.equal(r.requirements.noAllowanceSpentOnKnownUnavailable,true);});
test('known-unavailable course-link attempt mints no unreachable token',async()=>{const r=await proof;assert.equal(r.requirements.noUndeliverableToken,true);});
test('known-unavailable course-link requests avoid entitlement lookup',async()=>{const r=await proof;assert.equal(r.requirements.noEntitlementLookupWhenKnownUnavailable,true);});
test('known-unavailable public course-link replies cannot reveal entitlement',async()=>{const r=await proof;assert.equal(r.requirements.uniformPublicResponseWhenKnownUnavailable,true);});

test('configured SES preserves original links, imported rights, validation and rate guards',async()=>{await proof;await proveAvailableCourseMail();});

test('known global refusal preserves original rate limits before avoiding supplier work',async()=>{const r=await proof;assert.ok(r.direct.every(x=>x.commands===0));assert.ok(r.request.entitled.rateMutations>0);assert.ok(r.request.unentitled.rateMutations>0);assert.deepEqual(r.rate.address.map(x=>x.result),['error','error','error','error','error','limited']);assert.deepEqual(r.rate.ip.map(x=>x.result),[...Array(10).fill('error'),'limited']);assert.ok([...r.rate.address,...r.rate.ip].every(x=>x.entitlementLookups===0&&x.after.transactionalUsed===x.before.transactionalUsed&&x.after.tokens===x.before.tokens));assert.equal(r.rate.invalid.result,'email');assert.equal(r.rate.invalid.commands,0);});
