/** Selected physical price projection only. Not catalog ownership, admission,
 * a shipping/total proof, a funded source or permission to create payment. */
import type {ProductOption} from '@/lib/product-option';
import {readShippingSku} from '@/lib/shipping';
import {shipmentMailPolicy} from '@/lib/shipment-mail-outbox';
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
 const o=own(options[0]);if(!o)return null;
 const hasSku=Object.hasOwn(o,'sku');
 if(Object.keys(o).length!==(hasSku?8:7)||!['id','label','priceCents','file','link','details','best'].every(k=>Object.hasOwn(o,k)))return null;
 // The catalog's optional inventory label is not a new entitlement. Preserve
 // its exact canonical value; never trim/coerce an unverified snapshot here.
 if(hasSku&&(typeof o.sku!=='string'||readShippingSku(o.sku)!==o.sku))return null;
 const details=list(o.details,8);
 if(typeof o.id!=='string'||!/^[A-Za-z0-9_-]{1,24}$/.test(o.id)||o.id!==optionId||
  typeof o.label!=='string'||!o.label.trim()||o.label.length>40||/[\u0000-\u001f\u007f]/.test(o.label)||
  !Number.isSafeInteger(o.priceCents)||Number(o.priceCents)<0||o.file!==null||o.link!==null||typeof o.best!=='boolean'||
  !details||details.some(d=>typeof d!=='string'||d.length>100||/[\u0000-\u001f\u007f]/.test(d)))return null;
 return {id:o.id,label:o.label,priceCents:Number(o.priceCents),...(hasSku?{sku:o.sku as string}:{}),file:null,link:null,details:details as string[],best:o.best};
}

/** Exact original selected snapshot/body comparison, not original-store
 * authenticity, complete shipping/payment proof or financial permission. */
export function physicalOptionBodyMatches(value:unknown,maximumBytes:unknown):boolean{
 const v=own(value),snapshot=own(v?.snapshot),product=own(snapshot?.product),store=own(snapshot?.store);
 if(!v||typeof v.body!=='string'||typeof maximumBytes!=='number'||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>131072||
  v.body.length>maximumBytes||Buffer.byteLength(v.body)>maximumBytes||!product||!store)return false;
 for(const s of [product.id,product.title,store.handle])if(typeof s!=='string'||!s||s.length>maximumBytes||Buffer.byteLength(s)>maximumBytes)return false;
 if(typeof store.currency!=='string'||!/^[a-z]{3}$/.test(store.currency)||!own(product.shipping)||product.note!==false||list(product.fields,0)?.length!==0||
  ['call','course','podcast','recurring','bundle','keys','file','link','plan','pwyw','callPackage'].some(key=>product[key]!==undefined&&product[key]!==null))return false;
 const form=new URLSearchParams(v.body),entries=[...form];
 if(form.toString()!==v.body||new Set(entries.map(([key])=>key)).size!==entries.length)return false;
 const selected=selectedPhysicalOption(product,form.get('metadata[option]'));if(!selected)return false;
 const name=`${product.title} (${selected.label})`;
 const expected:Record<string,string>={mode:'payment','metadata[store]':store.handle as string,'metadata[product]':product.id as string,
  'metadata[mm_order_origin]':'physical-v1','metadata[title]':name.slice(0,480),
  'line_items[0][quantity]':'1','line_items[0][price_data][unit_amount]':String(selected.priceCents),
  'line_items[0][price_data][currency]':store.currency,'line_items[0][price_data][product_data][name]':name};
 return Object.entries(expected).every(([key,val])=>form.get(key)===val)&&
  !entries.some(([key])=>/^line_items\[(?!0\])/.test(key)||/^(discounts|custom_fields|optional_items|subscription_data)\[/.test(key))&&
  !['gift','group','people','preorder','upsell_key','bundle'].some(key=>form.has(`metadata[${key}]`));
}


/** Isolated structural coverage test only. A caller still owes authenticated
 * source ownership, complete cohort checks, shipping/paid reconciliation and
 * real reviewed funding. This function neither creates nor authorizes them. */
export function physicalOptionCovered(value:unknown,policy:unknown,now=Date.now(),admission=true):boolean{
 const p=shipmentMailPolicy(policy,now,admission);
 return Boolean(p?.coveredOrigins?.includes('physical-option-confirmation')&&physicalOptionBodyMatches(value,p.maxPayloadBytes));
}
