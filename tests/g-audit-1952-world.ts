import type { Role } from '@/lib/team-roles';
export let role:Role='support';
export const setRole=(value:Role)=>{role=value;};
const visible={id:'open01',name:'Visible',kind:'open' as const};
const hidden={id:'won002',name:'Confidential',kind:'won' as const};
export const pipelines=[{id:'pipe01',name:'Public team pipeline',stages:[visible]},{id:'pipe02',name:'Confidential owner pipeline',stages:[hidden]}];
export const deals=[
 {id:'deal01',title:'Visible deal',email:'visible@example.test',cents:100,stage:visible.id,note:'',createdAt:1,updatedAt:1},
 {id:'deal02',title:'Hidden deal',email:'secret@example.test',cents:9876500,stage:hidden.id,note:'',createdAt:1,updatedAt:1},
];
export const cookies=async()=>({get:()=>undefined});
export const redirect=()=>{throw Error('unexpected redirect');};
export const studioView=async()=>({ok:true,view:{role,email:'support@example.test',ref:'owner@example.test',store:{handle:'audit1952',sid:'audit1952',currency:'usd',email:'owner@example.test',name:'Synthetic',statsId:'audit1952',subscription:{active:true}},stores:[],owned:[]}});
export const studioPath=()=>'/studio';
export const readFields=async()=>[];
export const readOpportunityReview=async()=>({available:true,pipelines,stages:[visible,hidden],deals,versions:{}});
export const readPipelineAccess=async()=>({pipe02:'none' as const});
export const readTeam=async()=>({members:[]});
export const buyerLedger=async()=>({buyers:new Map([['secret@example.test',{channel:'CONFIDENTIAL-CAMPAIGN'}],['visible@example.test',{channel:'public'}]]),partial:false});
export const StudioHeader=()=>null;
export const StudioStorePin=({children}:{children:unknown})=>children;
export const DealsBoard=()=>null;
export const DealsUnavailable=()=>null;
