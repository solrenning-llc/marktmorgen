import { test } from "node:test";
import assert from "node:assert/strict";
import { tell, MAX_NOTICES, NOTICE_BYTES } from "@/lib/community-notify";
import { dataKey } from "@/lib/store-data";
import { store } from "../../../tests/redis-stub";

type Batch = (string | number)[][];
const id = "z3288-room-synthetic";
const member = "a1a1a1a1a1a1";
const second = "b2b2b2b2b2b2";
const actor = "c3c3c3c3c3c3";
const room = { sid: "z3288-room-synthetic", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_synthetic", trialEnds: 0, planEndedAt: "" };
const key = (who: string) => `nl:cm:${id}:nt:${who}`;
const ledger = dataKey(room)!;
const takeMarker = "-- marktmorgen:store-data:v1";
const notice = (post: string) => ({kind: "mention" as const, post, comment: "", by: actor, words: "synthetic"});
const counters = () => (globalThis as typeof globalThis & { __zCounts: () => {runs: number; mocks: number; over: boolean} }).__zCounts();
const shapes: [string, () => unknown, string[]?][] = [
 ["empty", () => []], ["extra", () => [0,0]], ["nil slot", () => [null]],
 ["missing value", () => [undefined]], ["text count", () => ["0"]], ["OK slot", () => ["OK"]],
 ["object slot", () => [{}]], ["nested slot", () => [[]]], ["negative", () => [-1]],
 ["fraction", () => [0.5]], ["NaN", () => [NaN]], ["infinity", () => [Infinity]],
 ["unsafe integer", () => [Number.MAX_SAFE_INTEGER + 1]], ["hole", () => Array(1)],
 ["inherited", () => {const a = Array(1); Object.setPrototypeOf(a, Object.assign(Object.create(Array.prototype), {0:0})); return a;}],
 ["getter", () => Object.defineProperty([0], "0", { get() { throw Error("reply getter executed"); } })],
 ["frozen malformed", () => Object.freeze(["OK"])],
 ["mixed missing", () => [0], [member,second]], ["mixed unknown", () => [0,"OK"], [member,second]],
 ["mixed hole", () => {const a = [0]; a.length=2; return a;}, [member,second]],
];
async function observe(label: string, recipients: string[], injected: {value: unknown} | null, post=label) {
 const original = store.pipeline.bind(store);
 const batches: Batch[] = []; const admittedAtWrite: number[] = [];
 const before = counters();
 store.pipeline = async (batch) => {
  batches.push(batch);
  if (batch[0]?.[0] === "ZCARD" && injected) return injected.value as unknown[];
  if (batch.some(c => c[0] === "ZADD")) {
   const [used] = await original([["HGET",ledger,"cm:nt"]]);
   admittedAtWrite.push(Number(used ?? 0));
  }
  return original(batch);
 };
 try { await tell(id,recipients,notice(post),room); } finally { store.pipeline=original; }
 const after = counters();
 const sizes = await original(recipients.filter((v,i,a) => !!v && v!==actor && a.indexOf(v)===i).map(v => ["ZCARD",key(v)]));
 const [paid,total] = await original([["HGET",ledger,"cm:nt"],["HGET",ledger,"#"]]);
 const commands = batches.flat();
 const out = {label, commands: commands.map(c => c[0] === "EVAL" && String(c[1]).startsWith(takeMarker) ? "TAKE" : c[0]),
  jsonPipelineBytes:batches.reduce((n,b)=>n+Buffer.byteLength(JSON.stringify(b)),0),
  nestedRedis:after.runs-before.runs, mockHttp:after.mocks-before.mocks, paid:Number(paid??0), total:Number(total??0), sizes, admittedAtWrite, noticeBytes:NOTICE_BYTES};
 console.log("Z_CASE",JSON.stringify(out)); return out;
}
for (const [label,make,recipients] of shapes) test(`independent unknown size: ${label}`, async () => {
 store.clear(); const to=recipients??[member]; const got=await observe(label,to,{value:make()});
 assert.deepEqual(got.commands,to.map(()=>"ZCARD"));
 assert.deepEqual(got.sizes,to.map(()=>0)); assert.equal(got.paid,0); assert.equal(got.total,0);
});
test("confirmed empty frozen receipt reserves actual room before real ZADD", async () => {
 store.clear(); const got=await observe("frozen zero",[member],{value:Object.freeze([0])});
 assert.deepEqual(got.commands,["ZCARD","TAKE","ZADD","ZREMRANGEBYRANK"]);
 assert.deepEqual(got.sizes,[1]); assert.equal(got.paid,NOTICE_BYTES); assert.equal(got.total,NOTICE_BYTES+64);
 assert.deepEqual(got.admittedAtWrite,[NOTICE_BYTES]);
});
test("deduplication and actor filtering reserve only two actual rows", async () => {
 store.clear(); const got=await observe("dedup",[member,member,actor,"",second],null);
 assert.deepEqual(got.commands,["ZCARD","ZCARD","TAKE","ZADD","ZREMRANGEBYRANK","ZADD","ZREMRANGEBYRANK"]);
 assert.deepEqual(got.sizes,[1,1]); assert.equal(got.paid,2*NOTICE_BYTES); assert.equal(got.total,2*NOTICE_BYTES+64);
 assert.deepEqual(got.admittedAtWrite,[2*NOTICE_BYTES]);
});
test("full funded ring reuses existing room and trims to the unchanged limit", async () => {
 store.clear();
 for(let n=0;n<MAX_NOTICES;n++) await tell(id,[member],notice(`seed-${n}`),room);
 const got=await observe("funded full ring",[member],null,"new-ring-row");
 assert.deepEqual(got.commands,["ZCARD","ZADD","ZREMRANGEBYRANK"]);
 assert.deepEqual(got.sizes,[MAX_NOTICES]); assert.equal(got.paid,MAX_NOTICES*NOTICE_BYTES);
 assert.equal(got.total,MAX_NOTICES*NOTICE_BYTES+64); assert.deepEqual(got.admittedAtWrite,[MAX_NOTICES*NOTICE_BYTES]);
});
test("only self and empty recipients spend no Redis commands", async () => {
 store.clear(); const got=await observe("filtered all",[actor,""],null);
 assert.deepEqual(got.commands,[]); assert.equal(got.nestedRedis,0); assert.equal(got.mockHttp,0);
});
