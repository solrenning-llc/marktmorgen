import {test} from "node:test";
import assert from "node:assert/strict";
import {selectedDigitalOptionFromOriginal} from "@/lib/digital-option-confirmation";
import {MAX_OPTIONS} from "@/lib/product-option";
const make=(id:string)=>({id,label:id,priceCents:6500,file:{pathname:`stores/synthetic/${id}/book.pdf`,name:"Book.pdf",bytes:1200,contentType:"application/pdf",addedAt:"2026-11-01T00:00:00.000Z"},link:null,details:[],best:false});
test("explicit original selection is bounded by the actual catalog limit and detached from later edits",()=>{
 const product={options:Array.from({length:MAX_OPTIONS},(_,i)=>make(`edition${i}`))};const before=JSON.stringify(product);
 const selected=selectedDigitalOptionFromOriginal(product,"edition17","synthetic");assert.ok(selected);assert.equal(selected.priceCents,6500);assert.equal(selected.id,"edition17");assert.equal(JSON.stringify(product),before);
 product.options[17].priceCents=1;product.options[17].file.pathname="stores/other/edition17/changed.pdf";
 assert.equal(selected.priceCents,6500);assert.equal(selected.file.pathname,"stores/synthetic/edition17/book.pdf");assert.ok(Object.isFrozen(selected));assert.ok(Object.isFrozen(selected.file));
 assert.equal(selectedDigitalOptionFromOriginal({options:Array.from({length:MAX_OPTIONS+1},(_,i)=>make(`edition${i}`))},"edition0","synthetic"),null);
});
test("missing, duplicate, inherited and executable original choices never guess or execute",()=>{
 let reads=0;const winner=make("edition1");
 for(const p of [{options:[winner,winner]},{options:[winner,make("edition2")]},Object.create({options:[winner]})])assert.equal(selectedDigitalOptionFromOriginal(p,"missing","synthetic"),null);
 assert.equal(selectedDigitalOptionFromOriginal({options:[winner,winner]},winner.id,"synthetic"),null);
 const executable=Object.defineProperty({...winner},"id",{get(){reads++;throw Error("no getter");}});
 const array=[winner];Object.defineProperty(array,0,{get(){reads++;throw Error("no array getter");}});
 for(const p of [{options:[executable]},{options:array},Object.defineProperty({},"options",{get(){reads++;throw Error("no options getter");}})])assert.equal(selectedDigitalOptionFromOriginal(p,winner.id,"synthetic"),null);
 assert.equal(reads,0);assert.equal(selectedDigitalOptionFromOriginal({options:[winner]},winner.id,"other"),null);
 assert.equal(selectedDigitalOptionFromOriginal({options:[{...winner,sku:"separate-recipe"}]},winner.id,"synthetic"),null);
});
