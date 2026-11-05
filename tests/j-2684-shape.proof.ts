import {readRows} from '@/lib/search-console';
import {serverRoles} from '@/lib/discord';
import {assignable} from '@/lib/discord-rules';
import {done,is,part} from './check';
const SERVER='111111111111111111', BOT='222222222222222222';
const BOTROLE='333333333333333333', TARGET='444444444444444444';
let roles: unknown=[];
process.env.DISCORD_BOT_TOKEN='synthetic-token';
globalThis.fetch=(async(input:string|URL|Request)=>{
 const path=new URL(String(input)).pathname;
 const reply=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
 if(path.endsWith(`/guilds/${SERVER}/roles`))return reply(roles);
 if(path.endsWith('/users/@me'))return reply({id:BOT});
 if(path.endsWith(`/members/${BOT}`))return reply({roles:[BOTROLE]});
 throw Error('Unexpected synthetic request');
}) as typeof fetch;
const rejected=(value:unknown)=>{try{readRows(value);return false;}catch{return true;}};
async function main(){
 part('Search Console exact query evidence');
 is('control: known no rows',readRows({responseAggregationType:'byProperty'}),[]);
 is('control: valid query preserved',readRows({rows:[{keys:['valid'],clicks:1,impressions:2,position:3}]}),[{query:'valid',clicks:1,impressions:2,position:3}]);
 for(const keys of [undefined,null,[],[42]]){
  is(`unknown query ${JSON.stringify(keys)} rejects rather than reporting no searches`,rejected({rows:[{keys,clicks:1,impressions:2,position:3}]}),true);
 }
 part('Discord managed evidence controls assignability');
 const bot={id:BOTROLE,name:'bot',position:5,color:0,managed:true};
 for(const managed of [false,true,undefined,null,'true']){
  roles=[bot,{id:TARGET,name:'target',position:2,color:0,managed}];
  const read=await serverRoles(SERVER);
  const offered=read?assignable(read.roles,SERVER,read.botTop).map(r=>r.id):[];
  is(`managed=${JSON.stringify(managed)} only confirmed false is assignable`,offered,managed===false?[TARGET]:[]);
 }
 done();
}
void main();
