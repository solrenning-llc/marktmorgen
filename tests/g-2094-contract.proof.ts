import {apiOkFields,pickFields} from '@/lib/api-fields';
import {AGENTS_GET} from '@/lib/store-search-check';
import {MCP_TOOLS} from '@/lib/mcp-catalog';
import {readFileSync} from 'node:fs';
import {done,is} from './check';
async function main(){
const request=(f:string)=>new Request('https://marktmorgen.com/api/v1/products?fields='+encodeURIComponent(f));
const body={data:[{title:'Synthetic course',private_note:'Never selected'}],next:'opaque-cursor'};
for(const field of ['constructor','hasOwnProperty','toString','__proto__','title.private_note','title\nsecret']){
const r=apiOkFields(request(field),body),v=await r.json();
is('hostile field is refused '+JSON.stringify(field),r.status,400);
is('no data leaked '+JSON.stringify(field),'data' in v,false);
}
Object.defineProperty(Object.prototype,'g_private_inherited',{value:'synthetic',configurable:true});
try{is('prototype field never becomes a projected field',pickFields(body,['g_private_inherited']),{ok:false,unknown:'g_private_inherited'});}finally{delete (Object.prototype as Record<string,unknown>).g_private_inherited;}
const selected=apiOkFields(request('title,title'),body);
is('valid projection excludes hidden fields and preserves cursor',await selected.json(),{...body,data:[{title:'Synthetic course'}]});
const route=readFileSync('app/api/mcp/route.ts','utf8');
for(const [word,tool] of [['numbers','get_numbers'],['products','list_products'],['memberships','get_memberships'],['email results','get_emails'],['affiliates','get_affiliates']]){
is('claimed read has catalog AND dispatch '+word,AGENTS_GET[2].includes(word)&&MCP_TOOLS.some(t=>t.name===tool)&&route.includes(`params.name === "${tool}"`),true);
}
done();}
main().catch(e=>{console.error(e);process.exitCode=1;});
