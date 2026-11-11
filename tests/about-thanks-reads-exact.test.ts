/**
 * Unknown Redis answers for product texts are not known absence (CX-123 rule 24).
 *
 * Kept from Codex T's proof, commit 46e2cc9dda4df5831c28fdcd584cc9c545dbfeb0
 * (branch codex/t-about-thanks-read-proof, tests/t-about-thanks-read.proof.ts,
 * docs/reviews/t-about-thanks-read.md), reproduced by Revisor 2: its cases and
 * assertions unchanged. Real writers, readers and the export stream over the
 * memory Redis stub; only the targeted GET/MGET reply is altered after the real
 * command runs. Synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHandle, ensureStatsId, addProduct, storeForEmail } from "@/lib/store";
import { writeAbout, readAbout, readAbouts } from "@/lib/product-about";
import { writeThanksNote, readThanksNote, readThanksNotes } from "@/lib/thanks-note-store";
import { storeExport } from "@/lib/store-export";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

redis.clear();
const about = "Complete fictional long description.";
const note = { heading: "Start here", body: "Complete fictional welcome instructions.", video: null, button: null };
const fixture = (async () => {
 const owner = "about-thanks-proof@example.test";
 assert.equal((await claimHandle(owner,"aboutthanksproof","Fictional texts","Synthetic evidence.")).ok,true);
 await ensureStatsId(owner);
 const ids: string[] = [];
 for (const title of ["Fictional first guide","Fictional second guide"]) {
  const made = await addProduct(owner,title,"","12",null); assert.ok(made.ok); ids.push(made.product.id);
 }
 const shop = await storeForEmail(owner); assert.ok(shop?.statsId);
 for (const id of ids) { await writeAbout(shop.statsId,id,about,shop); await writeThanksNote(shop.statsId,id,note,shop); }
 return { shop, ids };
})();

type Family = "about" | "note";
type Mode = "missing-envelope" | "extra-envelope" | "wrong-slot" | "partial-slots" | "wrong-record" | "confirmed-null" | "transport";
async function altered(family: Family, mode: Mode, task: () => Promise<void>) {
 const {shop,ids}=await fixture, original=redis.pipeline;
 const prefix=`nl:product:${family}:${shop.statsId}:`;
 const keys=ids.map(id=>["GET",prefix+id]);const before=await original.call(redis,keys);
 let hits=0;
 redis.pipeline=async commands=>{
  const reply=await original.call(redis,commands), c=commands[0];
  if(commands.length!==1||!["GET","MGET"].includes(String(c?.[0]))||!String(c?.[1]).startsWith(prefix))return reply;
  hits++;
  if(mode==="transport")throw new Error("SYNTHETIC_TEXT_TRANSPORT");
  if(mode==="missing-envelope")return [];
  if(mode==="extra-envelope")return [...reply,null];
  if(c[0]==="GET")return [mode==="confirmed-null"?null:false];
  if(mode==="partial-slots")return [(reply[0] as unknown[]).slice(0,1)];
  if(mode==="confirmed-null")return [[null,null]];
  if(mode==="wrong-record")return [[family==="note"?"{":false,(reply[0] as unknown[])[1]]];
  return [null];
 };
 try{await task();}finally{redis.pipeline=original;assert.equal(hits,1);assert.deepEqual(await original.call(redis,keys),before);}
}
async function exportedProducts() {
 const {shop}=await fixture;const reader=storeExport(shop).getReader();
 try{const first=await reader.read(), second=await reader.read();assert.ok(first.value&&second.value);return JSON.parse(new TextDecoder().decode(first.value)+new TextDecoder().decode(second.value)+"}") as {products: {product:{id:string};about?:string;thanks?:unknown}[];aboutsNote?:string;thanksNote?:string};}
 finally{await reader.cancel();}
}
for(const family of ["about","note"] as const){
 const batch=async()=>{const {shop,ids}=await fixture;return family==="about"?readAbouts(shop.statsId,ids):readThanksNotes(shop.statsId,ids);};
 const one=async()=>{const {shop,ids}=await fixture;return family==="about"?readAbout(shop.statsId,ids[0]):readThanksNote(shop.statsId,ids[0]);};
 test(`${family}: real writers, readers and export preserve both complete texts`,async()=>{
  const expected=family==="about"?about:note;
  assert.deepEqual(await batch(),[expected,expected]);assert.deepEqual(await one(),expected);
  const out=await exportedProducts();assert.equal(out.products.length,2);assert.deepEqual(out.products.map(p=>family==="about"?p.about:p.thanks),[expected,expected]);
 });
 for(const mode of ["missing-envelope","extra-envelope","wrong-slot","partial-slots","wrong-record"] as const)
  test(`${family}: batch rejects ${mode} rather than a known complete list`,async context=>{
   await altered(family,mode,async()=>{await assert.rejects(async()=>{const result=await batch();context.diagnostic(JSON.stringify({family,mode,result}));});});
  });
 for(const mode of ["missing-envelope","extra-envelope","wrong-slot"] as const)
  test(`${family}: single reader rejects ${mode}`,async context=>{await altered(family,mode,async()=>{await assert.rejects(async()=>{context.diagnostic(JSON.stringify({family,mode,result:await one()}));});});});
 for(const mode of ["missing-envelope","partial-slots","wrong-record"] as const)
  test(`${family}: actual export must distinguish unknown fields from confirmed absence after ${mode}`,async context=>{
   await altered(family,mode,async()=>{
    const out=await exportedProducts();const field=family==="about"?"about":"thanks",notice=family==="about"?out.aboutsNote:out.thanksNote;
    context.diagnostic(JSON.stringify({family,mode,values:out.products.map(p=>p[field]),notice}));
    assert.ok(typeof notice==="string"&&notice.length>0,"missing explicit unavailable note");
    assert.ok(out.products.every(p=>!Object.hasOwn(p,field)),"unknown family exported as known values");
   });
  });
 test(`${family}: confirmed nulls remain legitimate absence`,async()=>{
  await altered(family,"confirmed-null",async()=>{assert.deepEqual(await batch(),family==="about"?["",""]:[null,null]);});
  await altered(family,"confirmed-null",async()=>{assert.deepEqual(await one(),family==="about"?"":null);});
 });
 test(`${family}: direct transport error already propagates`,async()=>{await altered(family,"transport",async()=>{await assert.rejects(batch,/SYNTHETIC_TEXT_TRANSPORT/);});});
}

/**
 * A kept note that is not a ThanksNote (Claude 4 team's L1 on c2376695): only
 * writeThanksNote stores a note, always JSON.stringify of a ThanksNote that
 * says something, so any other kept value is unknown, never "no note". The
 * key holds the wrong value only inside the test and is put back after it.
 */
const wrongNotes: [string, string][] = [
 ["a body that is a number", JSON.stringify({ body: 5 })],
 ["an object missing fields", JSON.stringify({ heading: "Only a heading" })],
 ["a field of the wrong type", JSON.stringify({ ...note, heading: 7 })],
 ["a button without its link", JSON.stringify({ ...note, button: { label: "Open" } })],
 ["a video that cannot be read", JSON.stringify({ ...note, video: { provider: "elsewhere", id: "x", hash: "" } })],
 ["a note that says nothing", JSON.stringify({ heading: "", body: "", video: null, button: null })],
 ["an array", JSON.stringify([note])],
 ["a number", "5"],
 ["a JSON string", JSON.stringify(note.body)],
 ["text that is not JSON", "not a kept note"],
];
async function keptAs(raw: string, task: () => Promise<void>) {
 const {shop,ids}=await fixture, key=`nl:product:note:${shop.statsId}:${ids[0]}`;
 const [before]=await redis.pipeline([["GET",key]]);
 await redis.pipeline([["SET",key,raw]]);
 try{await task();}finally{await redis.pipeline([["SET",key,String(before)]]);}
}
for(const [name,raw] of wrongNotes){
 test(`note: kept as ${name}, a note is unknown, never "no note"`,async context=>{
  const {shop,ids}=await fixture;
  await keptAs(raw,async()=>{
   await assert.rejects(async()=>{context.diagnostic(JSON.stringify({name,one:await readThanksNote(shop.statsId,ids[0])}));},UnknownReplyError);
   await assert.rejects(async()=>{context.diagnostic(JSON.stringify({name,batch:await readThanksNotes(shop.statsId,ids)}));},UnknownReplyError);
   const out=await exportedProducts();
   assert.ok(typeof out.thanksNote==="string"&&out.thanksNote.length>0,"missing explicit unavailable note");
   assert.ok(out.products.every(p=>!Object.hasOwn(p,"thanks")),"unknown note exported as known");
  });
 });
}
test("note: after a wrong kept value, the healthy note and confirmed absence read as before",async()=>{
 const {shop,ids}=await fixture;
 assert.deepEqual(await readThanksNote(shop.statsId,ids[0]),note);
 assert.deepEqual(await readThanksNotes(shop.statsId,ids),[note,note]);
 assert.equal(await readThanksNote(shop.statsId,"no-such-product"),null);
 assert.deepEqual(await readThanksNotes(shop.statsId,["no-such-product",ids[1]]),[null,note]);
});
