/** Synthetic auth/services surrounding REAL page, editor and HTTP handlers. */
import type { ReactNode } from 'react';
import type { Store } from '@/lib/store';
import { UnknownReply } from '@/lib/redis-exact';
import { form, responses } from './form-response-fixture';
export const state={unavailable:true,denied:false,pdf:0,writes:0};
export const store={sid:'synthetic-store',statsId:'synthetic-stats',email:'owner@example.com',name:'Synthetic store',currency:'USD',language:'en'} as unknown as Store;
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
export async function guardStoreWrite(){return state.denied?{ok:false,response:new Response('forbidden',{status:403})}:{ok:true,store,role:'owner',body:{form:form.id,responseRef:'a'.repeat(64)}};}
export async function readForms(){return [form,{...form,id:'form000002',name:'Healthy form'}];}
export async function readForm(){return form;}
export async function readResponses(_stats:unknown,id:string){if(state.unavailable&&id===form.id)throw new UnknownReply('form responses');return {responses,total:responses.length};}
export async function readResponse(_stats:unknown,id:string,responseId:string){if(state.unavailable&&id===form.id)throw new UnknownReply('form response');return responses.find(r=>r.id===responseId)??null;}
export async function readCards(){return new Map();}
export async function readOpportunityReview(){return {available:false,stages:[],deals:[],pipelines:[],versions:{}};}
export async function readStages(){return [];}
export async function readPipelines(){return [];}
export class CrmSchemaReadUnavailable extends Error{constructor(){super('CRM configuration preflight could not be confirmed');this.name='CrmSchemaReadUnavailable';}}
export async function readTeam(){return {members:[]};}
export async function readPipelineAccess(){return {};}
export const MAX_CONVERTIBLE_FORM_RESPONSES=20;
export function formOpportunityRef(){return 'a'.repeat(64);}
export async function readFormOpportunity(){return null;}
export async function createFormOpportunity(){state.writes++;throw Error('Unexpected write');}
export async function responseDrawable(){return true;}
export async function responsePdf(){state.pdf++;return new Uint8Array([37,80,68,70]);}
