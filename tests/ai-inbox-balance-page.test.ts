/** Caller proof: the real Inbox server page; helper refusal is explicitly synthetic. */
import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {isValidElement,type ReactNode} from 'react';
import InboxPage from '@/app/studio/inbox/page';
import {InboxStudio,reset,state} from './z-ai-inbox-page-world';
function find(node:ReactNode):Record<string,unknown>|null{
 if(Array.isArray(node)){for(const child of node){const found=find(child);if(found)return found;}return null;}
 if(!isValidElement<Record<string,unknown>>(node))return null;
 if(node.type===InboxStudio)return node.props;
 return find(node.props.children as ReactNode);
}
function warning(node:ReactNode):string|undefined{
 if(Array.isArray(node)){for(const child of node){const found=warning(child);if(found)return found;}return undefined;}
 if(!isValidElement<Record<string,unknown>>(node))return undefined;
 if(node.props.role==='status')return String(node.props.children);
 return warning(node.props.children as ReactNode);
}
const props=()=>({searchParams:Promise.resolve({})});
test('unknown writing balance preserves the inbox and refuses only AI',async()=>{
 reset();state.unknown=true;
 let page:ReactNode=null;
 await assert.doesNotReject(async()=>{page=await InboxPage(props());},'a balance refusal must not take down the inbox');
 const inbox=find(page);assert.ok(inbox);assert.deepEqual(inbox.initial,[{id:'synthetic-conversation'}]);
 assert.deepEqual(inbox.ai,{on:false,left:0},'AI is unavailable, not a confirmed zero allowance');
 assert.equal(state.balanceReads,1);
 assert.equal(warning(page),"Writing allowance couldn't be checked. Reload to try again.");
});
test('known available balance is preserved',async()=>{
 reset();const inbox=find(await InboxPage(props()));assert.ok(inbox);
 assert.deepEqual(inbox.ai,{on:true,left:39});assert.equal(state.balanceReads,1);
});
test('AI not offered does not read its balance',async()=>{
 reset();state.on=false;const inbox=find(await InboxPage(props()));assert.ok(inbox);
 assert.deepEqual(inbox.ai,{on:false,left:0});assert.equal(state.balanceReads,0);
});

test('confirmed zero remains an offered known balance',async()=>{
 reset();state.left=0;const page=await InboxPage(props()),inbox=find(page);assert.ok(inbox);
 assert.deepEqual(inbox.ai,{on:true,left:0});assert.equal(warning(page),undefined);
});
