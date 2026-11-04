/** Detached paid-file selection only. No original catalog/owner proof,
 * financial grant, immutable persisted source, payment or download permission. */
import {ownsPath,type ProductFile} from '@/lib/product-file';

export type SelectedDigitalOption=Readonly<{
 id:string;label:string;priceCents:number;file:Readonly<ProductFile>;link:null;details:readonly string[];best:boolean;
}>;
function own(value:unknown):Record<string,unknown>|null{
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
  const keys=Reflect.ownKeys(value);if(keys.length>128)return null;const result:Record<string,unknown>=Object.create(null);
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d||!Object.hasOwn(d,'value'))return null;result[key]=d.value;}return result;
 }catch{return null;}
}
function list(value:unknown,maximum:number):unknown[]|null{
 try{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
  const n=Object.getOwnPropertyDescriptor(value,'length')?.value;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>maximum||Reflect.ownKeys(value).length!==n+1)return null;
  const result=[];for(let i=0;i<n;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))return null;result.push(d.value);}return result;
 }catch{return null;}
}
const text=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.length<=maximum&&Boolean(value.trim())&&!/[\u0000-\u001f\u007f]/.test(value);

/** Caller must already have projected exactly one explicit original choice.
 * Zero-price delivery and link/mixed/SKU variants require separate recipes. */
export function selectedDigitalOption(product:unknown,optionId:unknown):SelectedDigitalOption|null{
 const p=own(product),options=list(p?.options,1);if(options?.length!==1)return null;
 const o=own(options[0]);if(!o||Object.keys(o).length!==7||!['id','label','priceCents','file','link','details','best'].every(k=>Object.hasOwn(o,k)))return null;
 const f=own(o.file),details=list(o.details,8);
 if(!text(o.id,24)||!/^[A-Za-z0-9_-]+$/.test(o.id)||o.id!==optionId||!text(o.label,40)||
  !Number.isSafeInteger(o.priceCents)||Number(o.priceCents)<=0||o.link!==null||typeof o.best!=='boolean'||!details||
  details.some(d=>typeof d!=='string'||d.length>100||/[\u0000-\u001f\u007f]/.test(d))||!f||Object.keys(f).length!==5||
  !['pathname','name','bytes','contentType','addedAt'].every(k=>Object.hasOwn(f,k))||
  !text(f.pathname,2000)||!text(f.name,255)||!text(f.contentType,255)||!text(f.addedAt,40)||
  !Number.isSafeInteger(f.bytes)||Number(f.bytes)<=0)return null;
 const timestamp=Date.parse(f.addedAt);if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString()!==f.addedAt)return null;
 const file=Object.freeze({pathname:f.pathname,name:f.name,bytes:Number(f.bytes),contentType:f.contentType,addedAt:f.addedAt});
 return Object.freeze({id:o.id,label:o.label,priceCents:Number(o.priceCents),file,link:null,details:Object.freeze(details as string[]),best:o.best});
}

/** Prefix comparison only: the caller must independently authenticate the
 * original folder and prove the original account/file/access funding. */
export function selectedDigitalOptionForFolder(product:unknown,optionId:unknown,storeFolder:unknown):SelectedDigitalOption|null{
 if(!text(storeFolder,320)||storeFolder!==storeFolder.trim()||storeFolder.includes('/')||storeFolder.includes('\\'))return null;
 const selected=selectedDigitalOption(product,optionId);
 return selected&&ownsPath(selected.file.pathname,storeFolder,selected.id)?selected:null;
}
