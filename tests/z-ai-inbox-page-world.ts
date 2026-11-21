/** Real server page with explicit auth/data/AI helper stand-ins. No external IO. */
import { UnknownReplyError } from '@/lib/redis-reply';
export const state={unknown:false,on:true,left:39,balanceReads:0};
export function reset(){Object.assign(state,{unknown:false,on:true,left:39,balanceReads:0});}
export const cookies=async()=>({});
export const redirect=()=>{throw new Error('Unexpected sign-in redirect');};
export const studioPath=()=>'/studio';
export const studioView=async()=>({ok:true,view:{store:{sid:'inbox-proof',statsId:'inbox-proof',email:'owner@example.invalid',handle:'inbox-proof',inbox:{},faq:[]},email:'owner@example.invalid',role:'owner',stores:[],owned:[]}});
export const StudioHeader=()=>null;
export const StudioStorePin=()=>null;
export const InboxStudio=()=>null;
export const aiAvailableFor=()=>state.on;
export async function aiLeft(){state.balanceReads++;if(state.unknown)throw new UnknownReplyError('synthetic balance boundary');return state.left;}
export const isSenderConfigured=()=>true;
export const isHouseStore=()=>false;
export const readInbox=async()=>[{id:'synthetic-conversation'}];
export const openConversation=async()=>{throw new Error('No selected conversation in fixture');};
export const readTeam=async()=>({members:[]});
