import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCustomerWorstCase, type CustomerWorstCase } from '../lib/net-margin-rules';

import {txCustomerFixture} from './customer-tax-review-fixture';
function review(): CustomerWorstCase {return {...txCustomerFixture(10000,0),taxesCeilingCents:3000};}
test('inherited costs never replace missing reviewed costs',()=>{
 const value=review();value.costCeilings=Object.create(value.costCeilings);
 assert.equal(assessCustomerWorstCase(value).reason,'unknown');
});
test('inherited revenue and tax values never approve a customer',()=>{
 for(const key of ['collectedRevenueCents','refundableRevenueCents','taxesCeilingCents'] as const){
  const value=review();Object.setPrototypeOf(value,{[key]:value[key]});delete (value as Partial<CustomerWorstCase>)[key];
  assert.equal(assessCustomerWorstCase(value).reason,'unknown');
 }
});
test('inherited approval flags are not tax or cost evidence',()=>{
 for(const key of ['allCostsBounded','allTaxesReviewed','revenueCollected'] as const){
  const value=review();Object.setPrototypeOf(value,{[key]:true});delete (value as Partial<CustomerWorstCase>)[key];
  assert.equal(assessCustomerWorstCase(value).approved,false);
 }
});
test('computed monetary fields are refused without executing them',()=>{
 let called=0;
 for(const key of ['collectedRevenueCents','taxesCeilingCents','costCeilings']){
  const value=review();Object.defineProperty(value,key,{get(){called++;throw new Error('must not execute');}});
  assert.equal(assessCustomerWorstCase(value).approved,false);
 }
 const value=review();Object.defineProperty(value.costCeilings,'ai',{get(){called++;return 0;}});
 assert.equal(assessCustomerWorstCase(value).approved,false);assert.equal(called,0);
});
test('an array with cost properties cannot masquerade as a cost record',()=>{
 const value=review();value.costCeilings=Object.assign([],value.costCeilings);
 assert.equal(assessCustomerWorstCase(value).approved,false);
});
test('ordinary JSON and explicit null-prototype records remain supported',()=>{
 const value=review();assert.equal(assessCustomerWorstCase(JSON.parse(JSON.stringify(value))).approved,true);
 value.costCeilings=Object.assign(Object.create(null),value.costCeilings);
 assert.equal(assessCustomerWorstCase(value).approved,true);
});
