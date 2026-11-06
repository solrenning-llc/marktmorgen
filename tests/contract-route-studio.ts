// Everything else of the real module; the names below stand in.
export * from '../lib/studio-route';
import type {Store} from '@/lib/store';
export let currentStore={statsId:'route-one',handle:'harbor',email:'owner@example.test',stripeCustomerId:null,subscriptionId:null,subscriptionActive:false,extra:false,tier:'creator',cycle:'month'} as Store;
export const setRouteStore=(store:Partial<Store>)=>{currentStore={statsId:'route-one',handle:'harbor',email:'owner@example.test',stripeCustomerId:null,subscriptionId:null,subscriptionActive:false,extra:false,tier:'creator',cycle:'month',...store} as Store;};
export const creatorFrom=async()=>({ref:'owner@example.test',store:currentStore,origin:'https://marktmorgen.test',studio:(q:string)=>'/studio?'+q});
export const away=(origin:string,path:string)=>new Response(null,{status:303,headers:{Location:new URL(path,origin).href}});
