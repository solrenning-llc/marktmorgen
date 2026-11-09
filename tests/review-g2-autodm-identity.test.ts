import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readAutoDmRule,decideReply,noteTested,ruleFingerprint,replyMessage,readReplyText} from '@/lib/autodm-reply-rules';
const product={id:'p_g2guide',title:'Synthetic guide'},person='synthetic_tester';
function rule(){const r=readAutoDmRule({id:'g2rule01',post:'g2post',keywords:['guide'],reply:'Here is your guide.',product:product.id,testers:[person]},[product]);assert.ok(r.ok);return r.rule;}
function decide(ownAccountId:unknown,extra:Partial<Parameters<typeof decideReply>[0]>={}){return decideReply({rule:rule(),personId:person,comment:'guide',ownAccountId:ownAccountId as string,lastSentAtSeconds:null,nowSeconds:2_000_000_000,live:true,...extra});}
test('control: known owner is excluded and a different known account permits a tester',()=>{assert.deepEqual(decide(person),{send:false,why:'own'});assert.equal(decide('synthetic_owner').send,true);});
for(const own of ['',null,undefined,0])test('control: missing own identity refuses before the tester can receive '+String(own),()=>{assert.deepEqual(decide(own),{send:false,why:'no_account'});});
for(const own of [' ','\t','\r\n'])test('a blank own account value is still unknown identity '+JSON.stringify(own),()=>{const answer=decide(own);console.log('G2_AUTODM_BLANK_OWNER',JSON.stringify({own,answer}));assert.deepEqual(answer,{send:false,why:'no_account'});});
test('unknown request clocks and unknown previous send times cannot authorize a reply',()=>{
 for(const now of [NaN,Infinity,-Infinity])assert.equal(decide('synthetic_owner',{nowSeconds:now}).send,false);
 for(const last of [undefined,NaN,Infinity,{},'0'])assert.equal(decide('synthetic_owner',{lastSentAtSeconds:last as number}).send,false);
});
test('live stays off with a genuine matching server test mark and every caller live value',()=>{
 const tested={...noteTested(rule()),mode:'live' as const};
 for(const live of [true,false,1,'true',{},null])assert.equal(decide('synthetic_owner',{rule:tested,live:live as boolean}).send,false);
 assert.equal(readAutoDmRule({...tested,tested:ruleFingerprint(tested)},[product]).ok,false);
});
test('counted product link carries only a rule id and normalization rejects deceptive bases',()=>{
 const r=rule(),made=replyMessage(r,'https://example.com/@synthetic',product);assert.ok(made);const url=new URL(made.link);assert.deepEqual([...url.searchParams],[['mm_dm','g2rule01']]);assert.equal(made.link.includes(person),false);
 for(const base of ['https://example.com:443/@synthetic','https://EXAMPLE.com/@synthetic','https://example.com/@synthetic/%2e%2e','https://reader@example.com/@synthetic','https://example.com/@synthetic?'])assert.equal(replyMessage(r,base,product),null);
});
test('normalized common links and unpaired surrogates refuse; genuine graphemes remain bounded',()=>{
 for(const value of ['www.example.com','ｅｘａｍｐｌｅ．ｃｏｍ','example\u200d.com/guide','x\ud800y'])assert.equal(readReplyText(value).ok,false);
 assert.equal(readReplyText('e\u0301'.repeat(500)).ok,true);assert.equal(readReplyText('e\u0301'.repeat(501)).ok,false);
});
