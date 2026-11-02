import assert from "node:assert/strict";
import {test} from "node:test";
import {NVDAKeyCodeCommands,WindowsKeyCodes,WindowsModifiers} from "@guidepup/guidepup";
import {navigateToContent} from "./navigate-to-content.mjs";

const title="Start your store — Marktmorgen";
const browserTitle=title+" - Chromium";

function fixture({initialSwitches=0,afterPreparationSwitches=0,loseFocus=false,loseAgain=false}={}){
 const state={windowTitle:initialSwitches?"Other window":browserTitle,switchesNeeded:initialSwitches,
  switches:0,reports:[],documentResets:0,headingReads:0,last:""};
 const reader={
  async perform(command){
   if(command===NVDAKeyCodeCommands.reportTitle){
    state.last=state.windowTitle;state.reports.push(state.windowTitle);return;
   }
   if(command.keyCode?.includes?.(WindowsKeyCodes.Escape)&&command.modifiers?.includes(WindowsModifiers.Alt)){
    state.switches++;state.switchesNeeded--;
    if(state.switchesNeeded<=0)state.windowTitle=browserTitle;
   }
   if(command.keyCode?.includes?.(WindowsKeyCodes.Home)&&command.modifiers?.includes(WindowsModifiers.Control)){
    state.documentResets++;
    if(loseFocus&&(state.documentResets===1||loseAgain)){
     state.windowTitle="Start, window";state.switchesNeeded=afterPreparationSwitches;
    }
   }
  },
  async lastSpokenPhrase(){return state.last;},
  async nextHeading(){state.headingReads++;},
 };
 const page={
  async bringToFront(){/* A Playwright tab is not proof of the OS foreground. */},
  async title(){return title;},
  locator(selector){
   assert.equal(selector,"body");
   return {async focus(){},async click(){},async blur(){}};
  },
 };
 const navigateThenRead=async()=>{await navigateToContent(reader,page,"nvda");await reader.nextHeading();};
 return {reader,page,state,navigateThenRead};
}

test("native foreground is verified again after successful NVDA preparation",async()=>{
 const {state,navigateThenRead}=fixture();
 await navigateThenRead();
 assert.ok(state.reports.length>=2,"Initial title alone cannot prove the final foreground");
 assert.equal(state.reports.at(-1),browserTitle);
 assert.equal(state.documentResets,1);
 assert.equal(state.headingReads,1);
});

test("focus lost during preparation is reacquired and proved before a heading is read",async()=>{
 const {state,navigateThenRead}=fixture({loseFocus:true,afterPreparationSwitches:1});
 await navigateThenRead();
 assert.ok(state.reports.includes("Start, window"),"The lost focus must be observed, not assumed away");
 assert.equal(state.windowTitle,browserTitle);
 assert.equal(state.reports.at(-1),browserTitle);
 assert.equal(state.switches,1);
 assert.equal(state.documentResets,2,"Restored browser content still needs its document reset");
 assert.equal(state.headingReads,1,"No heading assertion is retried");
});

test("unrecoverable post-preparation focus refuses heading assertions",async()=>{
 const {state,navigateThenRead}=fixture({loseFocus:true,afterPreparationSwitches:Infinity});
 await assert.rejects(navigateThenRead,/foreground window did not match/);
 assert.equal(state.switches,10);
 assert.equal(state.headingReads,0);
});

test("initial acquisition and final revalidation share the original ten-switch budget",async()=>{
 const {state,navigateThenRead}=fixture({initialSwitches:8,loseFocus:true,afterPreparationSwitches:3});
 await assert.rejects(navigateThenRead,/foreground window did not match/);
 assert.equal(state.switches,10,"Revalidation must not grant another ten window switches");
 assert.equal(state.headingReads,0);
});

test("focus lost again by the final document reset fails without retrying assertions",async()=>{
 const {state,navigateThenRead}=fixture({loseFocus:true,loseAgain:true,afterPreparationSwitches:1});
 await assert.rejects(navigateThenRead,/foreground window did not match/);
 assert.equal(state.documentResets,2);
 assert.equal(state.switches,1);
 assert.equal(state.headingReads,0);
});

test("an initially unknown foreground retains the existing finite refusal",async()=>{
 const {state,navigateThenRead}=fixture({initialSwitches:Infinity});
 await assert.rejects(navigateThenRead,/foreground window did not match/);
 assert.equal(state.switches,10);
 assert.equal(state.documentResets,0);
 assert.equal(state.headingReads,0);
});

test("an empty page title cannot establish native browser identity",async()=>{
 const {reader,page,state}=fixture();page.title=async()=>"  ";
 await assert.rejects(()=>navigateToContent(reader,page,"nvda"),/nonempty page title/);
 assert.equal(state.switches,0);
 assert.equal(state.documentResets,0);
 assert.equal(state.headingReads,0);
});


test("native snapshots locate observed loss without adding reader commands",async(t)=>{
 const logs=[];t.mock.method(console,"log",line=>logs.push(JSON.parse(line.slice(line.indexOf(":")+1))));
 const {reader,page,state}=fixture({afterPreparationSwitches:Infinity});
 const commands=[],perform=reader.perform;reader.perform=async command=>{commands.push(command);return perform(command);};
 const locator=page.locator;page.locator=selector=>({...locator(selector),async blur(){state.windowTitle="Search";state.switchesNeeded=Infinity;}});
 let reads=0;const foreground={async read(){reads++;return state.windowTitle;}};
 await assert.rejects(()=>navigateToContent(reader,page,"nvda",foreground),/foreground window did not match/);
 const snapshots=logs.filter(row=>Object.hasOwn(row,"title"));
 assert.equal(reads,8);assert.equal(snapshots.find(row=>row.title==="Search")?.stage,"after body blur");
 assert.equal(commands.filter(command=>command===NVDAKeyCodeCommands.reportTitle).length,12,"Only original initial and final/bounded recovery title reports remain");
 assert.equal(state.switches,10);assert.equal(state.documentResets,1);assert.equal(state.headingReads,0);
});

test("unknown native snapshots stay explicit and cannot replace the reader gate",async(t)=>{
 const errors=[];t.mock.method(console,"error",line=>errors.push(line));
 const {reader,page,state}=fixture();
 await navigateToContent(reader,page,"nvda",{async read(){throw Error("synthetic native deadline");}});
 assert.equal(errors.length,8);assert.ok(errors.every(line=>line.startsWith("AX2_NVDA_NATIVE_FOREGROUND_UNKNOWN:")));
 assert.equal(state.reports.length,2,"Real NVDA gates are unchanged by diagnostic failure");
});
