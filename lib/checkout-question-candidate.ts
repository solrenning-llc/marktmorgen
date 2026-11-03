/** Original questions only. Not a producer, admission, buyer-answer proof,
 * funded origin, payment/checkout permission or delivery capability. */
import {applyCheckoutFields,readFields,MAX_CHECKOUT_FIELDS,MAX_DROPDOWN_OPTIONS,type CheckoutField} from '@/lib/checkout-fields';
import {SHIPMENT_MAIL_MAX_ROW_BYTES} from '@/lib/shipment-mail-outbox';
export type CheckoutQuestionCandidate=Readonly<{kind:'checkout-question-candidate';admitted:false;
 fields:readonly Readonly<Omit<CheckoutField,'options'>&{options:readonly string[]}>[];
 projection:readonly (readonly [string,string])[]}>;
function record(value:unknown):Record<string,unknown>|null{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
 const out:Record<string,unknown>=Object.create(null),keys=Reflect.ownKeys(value);if(keys.length!==4)return null;
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d||!Object.hasOwn(d,'value'))return null;out[key]=d.value;}return out;
}
function list(value:unknown,max:number):unknown[]|null{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
 const n=Object.getOwnPropertyDescriptor(value,'length')?.value;
 if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>max||Reflect.ownKeys(value).length!==n+1)return null;
 const out=[];for(let i=0;i<n;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))return null;out.push(d.value);}return out;
}
const isQuestion=(key:string)=>key.startsWith('custom_fields[')||key.startsWith('phone_number_collection[');
export function captureCheckoutQuestions(raw:unknown,body:unknown,maximumBytes:unknown):CheckoutQuestionCandidate|null{
 try{
  if(typeof body!=='string'||typeof maximumBytes!=='number'||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>SHIPMENT_MAIL_MAX_ROW_BYTES||
   body.length>maximumBytes||Buffer.byteLength(body)>maximumBytes)return null;
  const input=list(raw,MAX_CHECKOUT_FIELDS);if(!input?.length)return null;
  const fields:CheckoutField[]=[];
  for(const entry of input){
   const f=record(entry),options=list(f?.options,MAX_DROPDOWN_OPTIONS);
   if(!f||!['label','type','optional','options'].every(key=>Object.hasOwn(f,key))||typeof f.label!=='string'||f.label.length>50||
    typeof f.type!=='string'||typeof f.optional!=='boolean'||!options||options.some(o=>typeof o!=='string'||o.length>100))return null;
   const copy={label:f.label,type:f.type,optional:f.optional,options:[...options]};
   const checked=readFields([copy]);if(!Array.isArray(checked)||checked.length!==1||JSON.stringify(checked[0])!==JSON.stringify(copy))return null;
   fields.push(checked[0]);
  }
  const checked=readFields(fields);if(!Array.isArray(checked)||JSON.stringify(checked)!==JSON.stringify(fields))return null;
  const expected=new URLSearchParams();applyCheckoutFields(expected,fields);
  const form=new URLSearchParams(body),pairs:[string,string][]=[],seen=new Set<string>();
  for(const [key,value] of form)if(isQuestion(key)){
   if(seen.has(key))return null;seen.add(key);pairs.push([key,value]);
  }
  if(pairs.length!==[...expected].length||pairs.some(([key,value])=>expected.get(key)!==value))return null;
  const candidate={kind:'checkout-question-candidate' as const,admitted:false as const,
   fields:Object.freeze(fields.map(f=>Object.freeze({...f,options:Object.freeze([...f.options])}))),
   projection:Object.freeze(pairs.map(pair=>Object.freeze(pair)))};
  return Buffer.byteLength(JSON.stringify(candidate))<=maximumBytes?Object.freeze(candidate):null;
 }catch{return null;}
}
