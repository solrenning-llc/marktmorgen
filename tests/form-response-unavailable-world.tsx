/** Synthetic auth/services surrounding REAL page, editor and HTTP handlers. */
import type { ReactNode } from 'react';
import type { Store } from '@/lib/store';
import { UnknownReply } from '@/lib/redis-exact';
import { form, responses } from './form-response-fixture';
export const state={unavailable:true,denied:false,pdf:0,writes:0,inventoryUnavailable:false,definitionsUnavailable:false,deletionUnavailable:false,missing:false,body:null as Record<string,unknown>|null,emailAllowance:1,emailForms:'known' as 'known'|'unknown'|'empty',formReads:0,emailProps:null as Record<string,unknown>|null};
export const store={sid:'synthetic-store',statsId:'synthetic-stats',email:'owner@example.com',name:'Synthetic store',catalog:{items:[]},look:{theme:'light',accent:'#000000'},mail:null,listId:'synthetic-list',tier:'scale',subscriptionActive:true,subscriptionId:null,cycle:'month',trialEnds:0,planEndedAt:'',currency:'USD',language:'en'} as unknown as Store;
export async function cookies(){return {};}
export function redirect(url:string):never{throw Error('redirect:'+url);}
export const useRouter=()=>({refresh(){},push(){}});
export const usePathname=()=>'/studio/forms';
export const useSearchParams=()=>new URLSearchParams();
export function StudioHeader(){return null;}
export function StudioStorePin({children}:{children:ReactNode}){return children;}
export function studioPath(){return '/studio';}
export async function studioView(){return {ok:true,view:{store,role:'owner',email:store.email,stores:[],owned:[]}};}
export async function creatorFrom(){return state.denied?new Response('forbidden',{status:403}):{store};}
export async function guardStoreWrite(){return state.denied?{ok:false,response:new Response('forbidden',{status:403})}:{ok:true,store,role:'owner',body:state.body??{form:form.id,responseRef:'a'.repeat(64)}};}
export async function readForms(){state.formReads++;if(state.inventoryUnavailable||state.emailForms==='unknown')throw new UnknownReply('forms');if(state.emailForms==='empty')return [];return [form,{...form,id:'form000002',name:'Healthy form'}];}
export async function readForm(){if(state.definitionsUnavailable)throw new UnknownReply('form');return state.missing?null:form;}
export async function writeForm(){state.writes++;return true;}
export async function dropForm(){if(state.deletionUnavailable)throw new UnknownReply('form deletion');state.writes++;return true;}
export async function readResponses(_stats:unknown,id:string){if(state.unavailable&&id===form.id)throw new UnknownReply('form responses');return {responses,total:responses.length};}
export async function readCards(){return new Map();}
export async function readOpportunityReview(){return {available:false,stages:[],deals:[],pipelines:[],versions:{}};}
export async function readStages(){return [];}
export async function readPipelines(){return [];}
export async function readTeam(){return {members:[]};}
export async function readPipelineAccess(){return {};}
export const MAX_CONVERTIBLE_FORM_RESPONSES=20;
export function formOpportunityRef(){return 'a'.repeat(64);}
export async function readFormOpportunity(){return null;}
export async function createFormOpportunity(){state.writes++;throw Error('Unexpected write');}
export async function responseDrawable(){return true;}
export async function responsePdf(){state.pdf++;return new Uint8Array([37,80,68,70]);}

export async function setSitePages(){throw Error('Unexpected site-page write');}
export function text(value:unknown,max:number){return typeof value==='string'?value.slice(0,max):'';}

/** Email-page services are synthetic; the page loader/JSX itself is real. */
export function EmailStudio(props:Record<string,unknown>){state.emailProps=props;return null;}
export const WHO=['all'];
export function requestsOpen(){return false;}
export function storeBase(){return 'https://example.com/@synthetic';}
export function productLink(){return 'https://example.com/@synthetic/product';}
export function starterFlows(){return [{starter:'welcome',name:'Synthetic welcome',trigger:'joined',steps:[]}];}
export function sellsSomething(){return false;}
export function idsOfKind(){return [] as string[];}
export async function readTitles(){return new Map<string,string>();}
export async function listCounts(){return {all:0,confirmed:0,unsubscribed:0};}
export async function listBroadcastsStrict(){return [];}
export function letterIdFor(){return 'synthetic-letter';}
export async function publishedLetters(){return new Map();}
export function broadcastMoney(){return null;}
export function flowMoney(){return null;}
export async function readMailRevenue(){return null;}
export async function readMailVisits(){return new Map();}
export async function readFlowStatsStrict(){return new Map();}
export async function readFlowListStrict(){return [];}
export function inTrial(){return false;}
export function monthlyAllowance(){return state.emailAllowance;}
export async function usedThisMonth(){return 0;}
export function healthId(){return 'synthetic-health';}
export async function listHealth(){return null;}
export async function pauseForSending(){return null;}
export function pauseWords(){return '';}
export async function pausedFor(){return null;}
export async function listDraftsStrict(){return [];}
export function aiAvailableFor(){return false;}
export async function aiLeft(){throw Error('Unexpected AI allowance read');}
export async function listSegments(){return [];}
export async function listHeld(){return [];}
export async function runsToday(){return null;}
export async function readFields(){return [];}
export function isBillingConfigured(){return false;}
export function trialOffered(){return false;}
