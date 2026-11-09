import type { Tier } from '@/lib/plan';
export { storageBrakeFor } from '../lib/storage-rules';
export const FOLDER='a'.repeat(32);
export const PATH='vault/'+FOLDER+'/product-1/0123456789abcdef-file.pdf';
export const state={auth:true,owns:true,lessonOwned:true,rateAllowed:true,vaultConfigured:true,providerFails:false,events:[] as string[],storageLimits:[] as number[],store:{statsId:'b'.repeat(32),tier:'creator' as Tier,subscriptionActive:true,subscriptionId:null as string|null,trialEnds:0,planEndedAt:''}};
export function resetWorld(){state.auth=true;state.owns=true;state.lessonOwned=true;state.rateAllowed=true;state.vaultConfigured=true;state.providerFails=false;state.events.length=0;state.storageLimits.length=0;state.store.tier="creator";state.store.trialEnds=0;}
export async function guardStoreWrite(request:Request){return state.auth?{ok:true,ref:'owner@example.test',body:await request.json()}:{ok:false,response:Response.json({ok:false,error:'signed_out'},{status:401})};}
export async function studioAccess(){return state.auth?{ok:true,access:{store:state.store,ref:'owner@example.test'}}:{ok:false,reason:'signed_out'};}
export const storeForEmail=async()=>state.store;
export const storeFolder=async()=>FOLDER;
export const storeRef=()=>'owner@example.test';
export const ownsDeliveryId=()=>state.owns;
export const readKind=async()=>[{course:{id:'course-1'}}];
export const ITEM_ID_PATTERN=/^[A-Za-z0-9_-]{1,40}$/;
export const VIDEO_TYPES=['video/mp4'];
export const readCourses=async()=>new Map([['course-1',{id:'course-1'}]]);
export const findLesson=()=>state.lessonOwned?{id:'lesson-1'}:null;
export const text=(value:unknown,length:number)=>typeof value==='string'?value.slice(0,length):'';
export const withinLimit=async()=>state.rateAllowed;
/** The short limit and the store's figure together (lib/metered-limits.ts): the figure is held by tests/store-allowance.test.ts. */
export const withinService=async()=>state.rateAllowed;
/** The same refusal said with its reason (lib/metered-limits.ts, withinServiceWhy): here only the short window refuses. */
export const withinServiceWhy=async()=>(state.rateAllowed?null:{reason:"tries" as const});
export const serviceRefusedJson=(refusal:{reason:string;message?:string},code:string)=>Response.json(refusal.reason==="tries"?{ok:false,error:code}:{ok:false,error:code,message:refusal.message},{status:429});
export const withinStore=async()=>state.rateAllowed;
export const fromAnotherSite=()=>false;
export const limited=async(request:Request)=>request;
export const rememberFolderOwner=async()=>{};
export const isVaultConfigured=()=>state.vaultConfigured;
export const isStreamConfigured=()=>true;
export async function openReservedVault(_input:unknown,limit:number){state.storageLimits.push(limit);state.events.push('provider:open');return state.providerFails?{ok:false,reason:'unavailable'}:{ok:true,upload:{pathname:PATH,pieces:1,pieceBytes:16*1024*1024,multipart:true}};}
export async function closeReservedVault(){state.events.push('provider:complete');return {ok:true,file:{pathname:PATH,bytes:5,contentType:'application/pdf'}};}
export async function abortReservedVault(){state.events.push('provider:abort');return true;}
export async function signPieces(){state.events.push('provider:sign');return [{number:1,url:'https://provider.example.test/part',type:null}];}
export async function openUpload(){state.events.push('provider:stream');return {ok:true,door:{pathname:'stream/test'}};}
export async function issueSignedToken(){state.events.push('provider:blob');return 'not-a-real-provider-token';}
export async function handleUploadPresigned(value:{body:{pathname:string;clientPayload?:string};getSignedToken:(path:string,payload?:string)=>Promise<unknown>}){return value.getSignedToken(value.body.pathname,value.body.clientPayload);}
export async function storageUsed(_folder:string,limit:number){state.events.push('provider:measurement');return {available:true,bytes:0,brake:limit,left:limit,full:false};}
export const maximumUploadBytes=(held:{left:number},maximum:number)=>Math.min(held.left,maximum);
export const fits=(held:{available:boolean;left:number},bytes:number)=>held.available&&bytes<=held.left;

// lib/image-space.ts as the three doors use it (owner's decision 8): the files' measurement this world records, with no pictures.
export async function spaceUsed(_ref:string,limit:number){const held=await storageUsed('',limit);return {...held,files:held.bytes};}
export async function noteFilesAuthorized(){}
