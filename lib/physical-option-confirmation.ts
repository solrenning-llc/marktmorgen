/** Selected physical price projection only. Not catalog ownership, admission,
 * a shipping/total proof, a funded source or permission to create payment. */
import type {ProductOption} from '@/lib/product-option';
function own(value:unknown):Record<string,unknown>|null{
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
  const keys=Reflect.ownKeys(value);if(keys.length>128)return null;const out:Record<string,unknown>=Object.create(null);
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d||!Object.hasOwn(d,'value'))return null;out[key]=d.value;}return out;
 }catch{return null;}
}
function list(value:unknown,max:number):unknown[]|null{
 try{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
  const n=Object.getOwnPropertyDescriptor(value,'length')?.value;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>max||Reflect.ownKeys(value).length!==n+1)return null;
  const out=[];for(let i=0;i<n;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))return null;out.push(d.value);}return out;
 }catch{return null;}
}
export function selectedPhysicalOption(product:unknown,optionId:unknown):ProductOption|null{
 const p=own(product),options=list(p?.options,1);if(options?.length!==1)return null;
 const o=own(options[0]);if(!o||Object.keys(o).length!==7||!['id','label','priceCents','file','link','details','best'].every(k=>Object.hasOwn(o,k)))return null;
 const details=list(o.details,8);
 if(typeof o.id!=='string'||!/^[A-Za-z0-9_-]{1,24}$/.test(o.id)||o.id!==optionId||
  typeof o.label!=='string'||!o.label.trim()||o.label.length>40||/[\u0000-\u001f\u007f]/.test(o.label)||
  !Number.isSafeInteger(o.priceCents)||Number(o.priceCents)<0||o.file!==null||o.link!==null||typeof o.best!=='boolean'||
  !details||details.some(d=>typeof d!=='string'||d.length>100||/[\u0000-\u001f\u007f]/.test(d)))return null;
 return {id:o.id,label:o.label,priceCents:Number(o.priceCents),file:null,link:null,details:details as string[],best:o.best};
}
