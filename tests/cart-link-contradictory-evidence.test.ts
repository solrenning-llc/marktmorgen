/** Codex G2 on #1928 (483b4540), kept as a permanent test: an error named beside an otherwise complete success is not a confirmed short link. */
/** G2 exact-current confirmation boundary: success plus an explicit error is not a confirmed short link. */
import test from 'node:test';import assert from 'node:assert/strict';
import {confirmedCartLink} from '@/components/cart-link-builder';
const ask={name:'synthetic-post',place:'email',ids:['aaaaaa','bbbbbb'],code:''};
const success={ok:true,links:[{code:'abc234',name:ask.name,place:ask.place,target:{kind:'cart',ids:ask.ids}}]};
test('control: an exact complete successful link is confirmed',()=>assert.equal(confirmedCartLink(200,success,ask),'abc234'));
test('an explicit error beside otherwise complete success is unknown',()=>assert.equal(confirmedCartLink(200,{...success,error:'server_error'},ask),null));
