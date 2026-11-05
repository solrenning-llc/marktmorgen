/** Pure exact-helper extraction in an isolated realm; no global poisoning. */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { done, is } from "./check";

const source = readFileSync("lib/call-reminders.ts", "utf8");
const start = source.indexOf("function dueQueue(");
const end = source.indexOf("async function remindBuyer", start);
if (start < 0 || end < 0) throw Error("Exact helper extraction missing");
const helper = stripTypeScriptTypes(source.slice(start, end));
const result = runInNewContext(`${helper}
const good=dueQueue([[]],1800000000000);
let getterCalls=0;
const reply=[];
Object.defineProperty(reply,'0',{get(){getterCalls++;return ['not a valid raw queue'];},configurable:true});
Object.defineProperty(Object.prototype,'value',{value:[],configurable:true});
let rejected=false;
try { dueQueue(reply,1800000000000); } catch { rejected=true; }
({good:good.length,rejected,getterCalls});`, { BATCH: 200 });
is("confirmed empty reply remains valid in isolated realm", result.good, 0);
is("an accessor cannot borrow value from descriptor prototype", result.rejected, true);
is("no getter was executed", result.getterCalls, 0);
done();
