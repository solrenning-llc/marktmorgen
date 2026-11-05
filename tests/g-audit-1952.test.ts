/** Actual page composition; only session/data providers and decorative shell are synthetic. */
import {isValidElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Page from '@/app/studio/deals/page';
import {DealChannelsLoader} from '@/components/deal-channels-table';
import {DealsBoard} from './g-audit-1952-world';
import {setRole} from './g-audit-1952-world';
import {dealsByChannel} from '@/lib/deal-channels';
import {done,is} from './check';
function find(node:unknown,type:unknown):Record<string,unknown>|null{
 if(Array.isArray(node)){for(const child of node){const found=find(child,type);if(found)return found;}return null;}
 if(!isValidElement(node))return null;
 const props=node.props as Record<string,unknown>;
 return node.type===type?props:find(props.children,type);
}
async function main(){
 setRole('support');
 const tree=await Page({searchParams:Promise.resolve({})});
 const board=find(tree,DealsBoard),table=find(tree,DealChannelsLoader);
 if(!board||!table)throw Error('Both actual page components required');
 const visible=board.deals as Parameters<typeof dealsByChannel>[0], passed=table.deals as Parameters<typeof dealsByChannel>[0];
 is('real page restricts the support board to the permitted pipeline',visible.map(d=>d.id),['deal01']);
 is('the table must receive the same visibility-filtered deals',passed.map(d=>d.id),['deal01']);
 const result=dealsByChannel(passed,table.stages as Parameters<typeof dealsByChannel>[1],email=>email==='secret@example.test'?'CONFIDENTIAL-CAMPAIGN':'public');
 const html=renderToStaticMarkup(await DealChannelsLoader(table as Parameters<typeof DealChannelsLoader>[0]));
 console.log('G1952_OBSERVED',JSON.stringify({board:visible.map(d=>d.id),table:passed.map(d=>d.id),won:result.rows.map(r=>[r.name,r.won.cents]),leak:html.includes('CONFIDENTIAL-CAMPAIGN')}));
 is('restricted table must not disclose hidden campaign or amount',html.includes('CONFIDENTIAL-CAMPAIGN')||html.includes('98,765'),false);
 setRole('owner');
 const ownerTree=await Page({searchParams:Promise.resolve({})});
 const ownerTable=find(ownerTree,DealChannelsLoader)!;
 is('owner retains both pipeline deals',(ownerTable.deals as unknown[]).length,2);
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
