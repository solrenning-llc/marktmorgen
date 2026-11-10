/** Synthetic authentication, access, funding and provider boundaries, explicitly not certified. */
export * from './redis-stub';
export * from '../lib/meet-providers';
export const storeForId=async()=>{throw new Error('Store lookup outside callback proof');};
import { redisPipeline as normal, store } from './redis-stub';
import type { Store } from '@/lib/store';
export const fixture={sid:'oauth-proof-store',statsId:'oauth-proof-stats',handle:'oauth-proof',email:'owner@example.invalid',currency:'usd',tier:'pro',period:{funded:true}} as Store & {statsId:string};
export const state={configured:true,session:true,access:true,paused:'',funding:true,counter:'normal' as string,commands:[] as (string|number)[][],providerCalls:0,fundingCalls:0,accessCalls:0};
export function reset(){store.clear();Object.assign(state,{configured:true,session:true,access:true,paused:'',funding:true,counter:'normal',commands:[],providerCalls:0,fundingCalls:0,accessCalls:0});}
export async function redisPipeline(commands:(string|number)[][]):Promise<unknown[]>{
 state.commands.push(...commands);
 if(commands[0]?.[0]==='SET' && String(commands[0][1]).startsWith('nl:rl:')){
  if(state.counter==='timeout')throw new Error('Synthetic lost counter response');
  if(state.counter==='false-set')return [false,1];
  if(state.counter==='null-count')return ['OK',null];
  if(state.counter==='text-count')return ['OK','1'];
  if(state.counter==='empty')return [];
  if(state.counter==='partial')return ['OK'];
  if(state.counter==='exceeded')return ['OK',31];
 }
 return normal(commands);
}
export const SESSION_COOKIE='oauth-proof-session';
export async function emailForSession(){return state.session?fixture.email:null;}
export async function resolveAccess(){state.accessCalls++;return state.access?{ok:true as const,access:{store:fixture,role:'owner' as const}}:{ok:false as const};}
export const studioPath=(_store:unknown,query='',part='')=>'/studio?'+query+(part?'#'+part:'');
export const away=(origin:string,path:string)=>new Response(null,{status:303,headers:{Location:new URL(path,origin).href}});
export const creatorFrom=async()=>{throw new Error('Only callbacks are exercised');};
export const ensureStatsId=async()=>{throw new Error('Callback must not allocate stats');};
export const integrationPauseWord=()=>state.paused||null;
export async function reservePaidResourceWindow(){state.fundingCalls++;return state.funding;}
export const noticeCreator=async()=>{throw new Error('Deferred notification is outside this proof');};
export const logTeam=async()=>{throw new Error('Owner callback has no team log');};
export const offeredProviders=()=>['google','zoom'];
export const isConfigured=()=>state.configured;
export const hostSyncOn=()=>state.configured;
export const isZoomReview=()=>false;
export const cameForZoom=()=>false;
export const GOOGLE_HOST_SCOPES=['synthetic-scope'];
export const ZOOM_REVIEW_QUERY='zoom=review';
export const withinServiceWhy=async()=>{throw new Error('Callback does not take a fresh integration allowance');};
export const serviceRefusalCode=()=>{throw new Error('Start flow is outside this proof');};
