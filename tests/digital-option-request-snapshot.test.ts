import {test} from "node:test";
import assert from "node:assert/strict";
import {captureDigitalOptionRequestSnapshot} from "@/lib/digital-option-body";
import {confirmationBodyDigest} from "@/lib/order-confirmation-outbox";
const nonce="a".repeat(64);
function fixture(){
 const store={statsId:"b".repeat(32),stripeAccountId:"acct_TestOption01",handle:"original.store",currency:"usd"};
 const option={id:"edition01",label:"Original PDF",priceCents:6500,file:{pathname:"stores/synthetic/edition01/book.pdf",name:"Book.pdf",bytes:1200,contentType:"application/pdf",addedAt:"2026-11-01T00:00:00.000Z"},link:null,details:[],best:false};
 const product={id:"product01",title:"Original book",summary:"Original summary",options:[option],fields:[]};
 const name=`${product.title} (${option.label})`,consent="yes:2026-10-30.2:d:1790000000";
 const form=new URLSearchParams({mode:"payment","metadata[store]":store.handle,"metadata[product]":product.id,"metadata[option]":option.id,"metadata[title]":name,"metadata[dc]":consent,"payment_intent_data[metadata][dc]":consent,"line_items[0][quantity]":"1","line_items[0][price_data][unit_amount]":"6500","line_items[0][price_data][currency]":"usd","line_items[0][price_data][product_data][name]":name,"line_items[0][price_data][product_data][description]":product.summary,"metadata[mm_order_origin]":"digital-option-v1","metadata[mm_order_intent]":nonce});
 form.set("metadata[mm_order_hash]",confirmationBodyDigest(form.toString()));
 return {store,product,optionId:option.id,folder:"synthetic",body:form.toString(),nonce,consent,maximumBytes:60000};
}
test("the original request snapshot is detached, bounded, and grants no authority",()=>{
 const f=fixture(),saved=captureDigitalOptionRequestSnapshot(f);assert.ok(saved);
 assert.deepEqual([saved.admitted,saved.permitsCheckout,saved.grantsAccess],[false,false,false]);
 assert.equal(saved.bodyDigest,new URLSearchParams(f.body).get("metadata[mm_order_hash]"));assert.ok(Object.isFrozen(saved));assert.ok(Object.isFrozen(saved.selected.file));
 f.store.currency="eur";f.product.summary="Changed";f.product.options[0].priceCents=1;f.product.options[0].file.pathname="stores/other/edition01/new.pdf";
 assert.equal(saved.identity.currency,"usd");assert.equal(saved.identity.summary,"Original summary");assert.equal(saved.selected.priceCents,6500);assert.equal(saved.selected.file.pathname,"stores/synthetic/edition01/book.pdf");
 assert.ok(saved.encodedBytes<=60000);
});
test("original nonce, recipe marker, own hash, byte envelope and coupled rights are mandatory",()=>{
 for(const key of ["metadata[mm_order_intent]","metadata[mm_order_origin]","metadata[mm_order_hash]"]){const f=fixture(),form=new URLSearchParams(f.body);form.set(key,"substituted");f.body=form.toString();assert.equal(captureDigitalOptionRequestSnapshot(f),null,key);}
 for(const bytes of [0,-1,NaN,Infinity,131073,200])assert.equal(captureDigitalOptionRequestSnapshot({...fixture(),maximumBytes:bytes}),null);
 for(const key of ["course","call","shipping","recurring","bundle","keys","plan","pwyw"]){const f=fixture();Object.assign(f.product,{[key]:{active:true}});assert.equal(captureDigitalOptionRequestSnapshot(f),null,key);}
 const f=fixture();f.product.fields=["unexpected"] as never;assert.equal(captureDigitalOptionRequestSnapshot(f),null);
});
test("capture never runs root/store/product accessors or serialization hooks",()=>{
 let reads=0;const bad=()=>{reads++;throw Error("no hook");};
 const f=fixture();
 for(const value of [Object.defineProperty({...f},"body",{get:bad}),{...f,store:Object.defineProperty({...f.store},"currency",{get:bad})},{...f,product:Object.defineProperty({...f.product},"summary",{get:bad})},{...f,toJSON:bad}])assert.equal(captureDigitalOptionRequestSnapshot(value),null);
 assert.equal(reads,0);
});

test("inherited global JSON hooks are refused before any selected values are encoded",()=>{
 for(const prototype of [Object.prototype,Array.prototype]){
  const previous=Object.getOwnPropertyDescriptor(prototype,"toJSON");let reads=0;const f=fixture();let result;
  try{Object.defineProperty(prototype,"toJSON",{configurable:true,value(){reads++;throw Error("no global hook");}});result=captureDigitalOptionRequestSnapshot(f);}
  finally{if(previous)Object.defineProperty(prototype,"toJSON",previous);else Reflect.deleteProperty(prototype,"toJSON");}
  assert.equal(result,null);assert.equal(reads,0);
 }
});

test("Proxy traps are not invoked while inspecting original request, choice or file",()=>{
 let traps=0;const wrap=<T extends object>(v:T)=>new Proxy(v,{getPrototypeOf(){traps++;throw Error("executable prototype");},ownKeys(){traps++;throw Error("executable keys");},getOwnPropertyDescriptor(){traps++;throw Error("executable descriptor");}});
 const f=fixture();
 for(const candidate of [wrap(f),{...f,store:wrap(f.store)},{...f,product:wrap(f.product)},{...f,product:{...f.product,options:wrap(f.product.options)}},{...f,product:{...f.product,options:[{...f.product.options[0],file:wrap(f.product.options[0].file)}]}}])assert.equal(captureDigitalOptionRequestSnapshot(candidate),null);
 assert.equal(traps,0,"reflection must not execute caller Proxy hooks");
});
