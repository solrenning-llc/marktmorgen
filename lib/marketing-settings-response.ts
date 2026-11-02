import {PIXEL_KINDS,readPixels,type Pixels} from "@/lib/pixels";
import {ATTRIBUTION_DAYS} from "@/lib/attribution-rules";
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
/** A truthy flag, contradictory error, missing IDs or different result never confirms a save. */
export function pixelSettingsConfirmed(httpOK:boolean,value:unknown,requested:Pixels):boolean{
 const data=record(value),pixels=record(data?.pixels);
 if(!httpOK||data?.ok!==true||"error" in data||!pixels||PIXEL_KINDS.some(kind=>!Object.hasOwn(pixels,kind)))return false;
 const parsed=readPixels(pixels);
 // X's event IDs (613 [WP12]) have to come back as they were sent, too.
 const events=(p:Pixels)=>JSON.stringify(p.xEvents??null);
 return parsed.ok&&PIXEL_KINDS.every(kind=>pixels[kind]===requested[kind]&&parsed.pixels[kind]===requested[kind])&&events(parsed.pixels)===events(requested);
}
export function attributionSettingsConfirmed(httpOK:boolean,value:unknown,requested:number):boolean{
 const data=record(value);
 return Boolean(httpOK&&data?.ok===true&&!("error" in data)&&Number.isSafeInteger(data.days)&&data.days===requested&&ATTRIBUTION_DAYS.some(days=>days===requested));
}
