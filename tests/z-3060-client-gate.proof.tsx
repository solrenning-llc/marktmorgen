/** Real component/pure parser with a declared controlled hook lifecycle and localStorage boundary. */
import {test} from "node:test";
import {strict as assert} from "node:assert";
import {renderToStaticMarkup} from "react-dom/server";
import {LibraryContinue} from "@/components/library-continue";
import {KEEP_DAYS,lastKey,writeLast} from "@/lib/lesson-position-rules";
import {resetEffects,flushEffects} from "./z-3060-hook-world.proof";
const person="a".repeat(32),other="b".repeat(32),now=Date.now(),key=lastKey(person)!;
const valid=writeLast({path:"/@ada-studio/course/p1/l3",courseId:"c1",lesson:"Lesson 3",course:"Painting",store:"Ada Studio"},now)!;
function render(open:readonly string[]|null,raw=valid,who=person,blocked=false){
 const values=new Map([[key,raw]]);let removed=0;
 const storage={getItem:(k:string)=>{if(blocked)throw Error("synthetic storage blocked");return values.get(k)??null;},removeItem:(k:string)=>{removed++;values.delete(k);}};
 Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:storage}});resetEffects();
 const node=LibraryContinue({person:who,open}),html=node?renderToStaticMarkup(node):"";flushEffects();
 return{html,kept:values.get(key),removed};
}
test("control: an open store offers the actual kept lesson",()=>{
 const result=render(["ada-studio"]);assert.match(result.html,/href="\/@ada-studio\/course\/p1\/l3"/);assert.match(result.html,/aria-labelledby="library-continue-heading"/);assert.equal(result.kept,valid);assert.equal(result.removed,0);
});
for(const [label,open]of [["closed",[]],["unknown",null],["prefix only",["ada"]]]as const){
 test(`${label} store draws no card but preserves the valid device record`,()=>{const result=render(open);console.log(JSON.stringify({label,card:!!result.html,kept:result.kept===valid,removed:result.removed}));assert.equal(result.html,"");assert.equal(result.kept,valid);assert.equal(result.removed,0);});
}
test("another person does not see or remove this person's record",()=>{const result=render(["ada-studio"],valid,other);assert.equal(result.html,"");assert.equal(result.kept,valid);assert.equal(result.removed,0);});
test("invalid record is hidden and cleaned",()=>{const result=render(["ada-studio"],"{");assert.equal(result.html,"");assert.equal(result.kept,undefined);assert.equal(result.removed,1);});
test("expired record is hidden and cleaned",()=>{const expired=writeLast({path:"/@ada-studio/course/p1/l3",courseId:"c1",lesson:"Lesson 3",course:"Painting",store:"Ada Studio"},now-(KEEP_DAYS+1)*86400000)!;const result=render(["ada-studio"],expired);assert.equal(result.html,"");assert.equal(result.removed,1);});
test("blocked storage is hidden without inventing a readable value",()=>{const result=render(["ada-studio"],valid,person,true);assert.equal(result.html,"");assert.equal(result.removed,0);});
