import {type Store} from "@/lib/store";
export const state:{store:Store|null}={store:null};
export async function creatorFrom(){return {ref:state.store!.email,store:state.store!,origin:"https://local.example",studio:(query:string)=>"/studio?"+query};}
export function away(origin:string,path:string){return Response.redirect(new URL(path,origin),303);}
export async function limited(request:Request){return request;}
export async function withinLimit(){return true;}
