import assert from "node:assert/strict";
import test from "node:test";
import {templateLibraryCards} from "@/lib/template-library";
import {matchingLibrary,libraryDestination} from "@/lib/template-library-rules";
import type {LibraryCard} from "@/lib/template-library-rules";
import {PAGE_TEMPLATES} from "@/lib/sales-page";
import {MAIL_TEMPLATES} from "@/lib/mail-body";
import {FUNNEL_STARTERS} from "@/lib/funnel-starters";
import {COURSE_TEMPLATES} from "@/lib/course-templates";
import {readFileSync} from "node:fs";
test("library uses canonical models, distinct identities, and conjunctive objective/type/search filters",()=>{
 const cards=templateLibraryCards({fromName:"Synthetic creator",storeLink:"https://example.test",ordersLink:"https://example.test/orders",product:null,paidCount:0});
 assert.equal(cards.length,PAGE_TEMPLATES.length+MAIL_TEMPLATES.length+FUNNEL_STARTERS.length+COURSE_TEMPLATES.length+2);
 assert.equal(new Set(cards.map(card=>card.kind+":"+card.id)).size,cards.length);
 for(const card of cards){assert.ok(card.preview.length);assert.ok(card.preview.every(text=>typeof text==="string"&&text.length>0));}
 const welcome=matchingLibrary(cards,"leads","sequence","welcome");assert.equal(welcome.length,1);assert.equal(welcome[0].id,"welcome");
 assert.equal(matchingLibrary(cards,"sales","sequence","welcome").length,0);
 assert.equal(matchingLibrary(cards,"all","all","not-a-template-928337").length,0);
 for(const card of cards){const url=new URL(libraryDestination(card,"store/value","product & value"),"https://example.test");assert.equal(url.searchParams.get("store"),"store/value");if(card.kind==="course")assert.equal(decodeURIComponent(url.pathname),"/studio/course/product & value");else assert.equal(url.searchParams.get("product"),"product & value");assert.ok(["/studio/pages","/studio/email","/studio/funnels","/studio/course/product%20%26%20value"].includes(url.pathname));assert.equal(url.searchParams.has("active"),false);}
 const funnel=cards.find(card=>card.kind==="funnel")!;assert.equal(new URL(libraryDestination(funnel,"sid"),"https://example.test").hash,"#starter="+encodeURIComponent(funnel.id));
});

const facts={fromName:"Synthetic creator",storeLink:"https://example.test",ordersLink:"https://example.test/orders",product:null,paidCount:0};

test("the shared library uses the canonical course structures without a second catalog",()=>{
 const courses=templateLibraryCards(facts).filter(card=>(card.kind as string)==="course");
 assert.equal(courses.length,COURSE_TEMPLATES.length);
 assert.deepEqual(courses.map(card=>[card.id,card.label,card.hint]),COURSE_TEMPLATES.map(template=>[template.id,template.name,template.about]));
 assert.ok(courses.every(card=>card.goal==="teaching"&&card.preview.length>0));
});

test("course structures can be found by type, title and their module preview",()=>{
 const cards=templateLibraryCards(facts);
 assert.deepEqual(matchingLibrary(cards,"teaching","course","weekly module").map(card=>card.id),["weekly"]);
 assert.deepEqual(matchingLibrary(cards,"teaching","course","certificate quiz").map(card=>card.id),["quizzes"]);
});

test("a course card only opens an existing selected course; it never creates, converts or saves one",()=>{
 const card={id:"weekly",kind:"course",label:"Weekly course",hint:"Four modules.",goal:"teaching",preview:["Week 1"]} as unknown as LibraryCard;
 const url=new URL(libraryDestination(card,"store/value","paid/course"),"https://example.test");
 assert.equal(url.pathname,"/studio/course/paid%2Fcourse");
 assert.equal(url.searchParams.get("store"),"store/value");
});

test("a course card carries the previewed structure to the course editor",()=>{
 const card={id:"weekly",kind:"course",label:"Weekly course",hint:"Four modules.",goal:"teaching",preview:["Week 1"]} as unknown as LibraryCard;
 const url=new URL(libraryDestination(card,"store/value","paid/course"),"https://example.test");
 assert.equal(url.searchParams.get("template"),"weekly");
 const page=readFileSync("app/studio/course/[product]/page.tsx","utf8");
 const editor=readFileSync("components/course-editor.tsx","utf8");
 const picker=readFileSync("components/course-template-picker.tsx","utf8");
 assert.match(page,/templateById\(query\.template\)/);
 assert.match(page,/initialTemplate=/);
 assert.match(editor,/initialTemplate=/);
 assert.match(picker,/initialTemplate/);
});

test("course cards say that ready structures only fit an untouched paid course",()=>{
 const component=readFileSync("components/template-library.tsx","utf8");
 assert.match(component,/Ready structures fit only a course with its original empty Module 1/);
 assert.match(component,/the editor leaves it unchanged/);
});

test("the library screen distinguishes an existing paid course from another product before offering the course link",()=>{
 const component=readFileSync("components/template-library.tsx","utf8");
 const page=readFileSync("app/studio/growth/page.tsx","utf8");
 assert.match(component,/"course"/);
 assert.match(component,/selected\.course/);
 assert.match(component,/Open course structures/);
 assert.match(page,/course:Boolean\(product\.course\)/);
});
