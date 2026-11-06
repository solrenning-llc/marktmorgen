/** Next request/navigation context and unrelated surrounding layout only.
 * Authentication, page, connection UI, route, storage and metering stay real. */
import type {ReactNode} from "react";
export const cookieValues=new Map<string,string>();
export async function cookies(){return {get(name:string){const value=cookieValues.get(name);return value===undefined?undefined:{name,value};}};}
export async function headers(){return new Headers();}
export function redirect(url:string):never{throw Error("redirect:"+url);}
export function notFound():never{throw Error("notFound");}
export const useRouter=()=>({refresh(){},push(){},replace(){},back(){},forward(){},prefetch(){}});
export const usePathname=()=>"/studio/meetings";
export const useSearchParams=()=>new URLSearchParams();
export function StudioHeader(){return null;}
export function StudioStorePin({children}:{children:ReactNode}){return children;}
