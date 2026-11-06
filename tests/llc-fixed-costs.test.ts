import test from "node:test";
import assert from "node:assert/strict";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS, FIXED_COST_SOURCE_OBSERVATIONS as sources, LLC_FIXED_COST_ALLOCATION, LLC_FIXED_COST_IDS, type FixedCostCeiling } from "../lib/llc-fixed-costs";
const fixture = (): FixedCostCeiling[] => LLC_FIXED_COST_IDS.map((id,i)=>({id,fullMonthlyUsdCents:101+i,fullAnnualUsdCents:1201+i,evidence:"SYNTHETIC FULL COST; no provider",reserveReviewed:true}));
test("every entire LLC cost is allocated to Marktmorgen with no Hazelsong subsidy",()=>{
 const lines=fixture(), result=allocateEntireLlcFixedCosts(lines)!;
 assert.equal(result.monthlyUsdCents,lines.reduce((sum,x)=>sum+x.fullMonthlyUsdCents!,0));
 assert.equal(result.annualUsdCents,lines.reduce((sum,x)=>sum+x.fullAnnualUsdCents!,0));
 assert.equal(result.marktmorgenBps,10000);assert.equal(result.hazelsongBps,0);
 assert.equal(LLC_FIXED_COST_ALLOCATION.marktmorgenBps,10000);
 for(const line of lines){const changed=lines.map(x=>x.id===line.id?{...x,fullMonthlyUsdCents:x.fullMonthlyUsdCents!+100,fullAnnualUsdCents:x.fullAnnualUsdCents!+1200}:x);const next=allocateEntireLlcFixedCosts(changed)!;assert.equal(next.monthlyUsdCents-result.monthlyUsdCents,100);assert.equal(next.annualUsdCents-result.annualUsdCents,1200);}
});
test("unknown costs, evidence, reserves or incomplete identities never become zero",()=>{
 assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS),null);
 for(const id of LLC_FIXED_COST_IDS){for(const bad of [{fullMonthlyUsdCents:null},{fullAnnualUsdCents:null},{evidence:""},{reserveReviewed:false},{fullMonthlyUsdCents:-1},{fullAnnualUsdCents:0.5}])assert.equal(allocateEntireLlcFixedCosts(fixture().map(x=>x.id===id?{...x,...bad}:x)),null);}
 assert.equal(allocateEntireLlcFixedCosts(fixture().slice(1)),null);const duplicate=fixture();duplicate[1]={...duplicate[0]};assert.equal(allocateEntireLlcFixedCosts(duplicate),null);
});
test("source observations preserve full taxes, INSS and higher monthly mailbox rate",()=>{
 assert.equal(sources.delaware.annualMinor,40000);assert.equal(sources.californiaTax.annualMinor,80000);
 assert.equal(sources.californiaFee.maximumAnnualMinor,1179000);assert.equal(sources.inss.monthlyMinor,169511);assert.equal(sources.inss.annualMinor,2034132);
 assert.equal(sources.mailbox.monthlyMinor,5900);assert.equal(sources.mailbox.twelveMonthlyPaymentsMinor,70800);
});

test("TX4 and SR obligations cannot disappear inside the old fixed-cost inventory",()=>{
 const required = ["us-form-5472","us-pro-forma-1120","br-irpf","br-cbe","vat-oss-and-local-compliance","itin-and-acceptance-agent","us-resident-representative","us-business-address"];
 for(const id of required){
  assert.ok((LLC_FIXED_COST_IDS as readonly string[]).includes(id));
  assert.equal(allocateEntireLlcFixedCosts(fixture().filter(line=>line.id!==id)),null);
  const current=CURRENT_LLC_FIXED_COST_CEILINGS.find(line=>line.id===id)!;
  assert.equal(current.fullMonthlyUsdCents,null);
  assert.equal(current.fullAnnualUsdCents,null);
  assert.equal(current.reserveReviewed,false);
 }
});

test("cost evidence accessors never execute or substitute a lower second value",()=>{
 for(const key of ["id","fullMonthlyUsdCents","fullAnnualUsdCents","evidence","reserveReviewed"] as const){
  let reads=0;
  const lines=fixture();
  Object.defineProperty(lines[0],key,{enumerable:true,get(){reads++;throw new Error("unreviewed getter");}});
  assert.equal(allocateEntireLlcFixedCosts(lines),null);
  assert.equal(reads,0);
 }
 let reads=0;
 const changing=fixture();
 Object.defineProperty(changing[0],"fullMonthlyUsdCents",{enumerable:true,get(){return ++reads===1?101:-100000;}});
 assert.equal(allocateEntireLlcFixedCosts(changing),null);
 assert.equal(reads,0);
});
test("inherited cost records, sparse arrays and accessor entries are not complete evidence",()=>{
 const inherited=fixture();
 inherited[0]=Object.create(inherited[0]);
 assert.equal(allocateEntireLlcFixedCosts(inherited),null);
 const sparse=fixture();Reflect.deleteProperty(sparse,"0");
 assert.equal(allocateEntireLlcFixedCosts(sparse),null);
 let reads=0;const indexed=fixture();
 Object.defineProperty(indexed,"0",{enumerable:true,get(){reads++;return fixture()[0];}});
 assert.equal(allocateEntireLlcFixedCosts(indexed),null);
 assert.equal(reads,0);
});
test("detached cost evidence retains valid totals and refuses unsafe aggregate amounts",()=>{
 const lines=fixture(),expected=allocateEntireLlcFixedCosts(lines);
 assert.deepEqual(allocateEntireLlcFixedCosts(lines.map(line=>Object.assign(Object.create(null),line))),expected);
 const overflow=fixture();overflow[0].fullMonthlyUsdCents=Number.MAX_SAFE_INTEGER;
 assert.equal(allocateEntireLlcFixedCosts(overflow),null);
 const annual=fixture();annual[0].fullAnnualUsdCents=Number.MAX_SAFE_INTEGER;
 assert.equal(allocateEntireLlcFixedCosts(annual),null);
});

test("SD1 initial LLC formation cannot disappear from the complete company cost review",()=>{
 assert.ok((LLC_FIXED_COST_IDS as readonly string[]).includes("llc-formation"));
 assert.equal(allocateEntireLlcFixedCosts(fixture().filter(line=>line.id!=="llc-formation")),null);
 const current=CURRENT_LLC_FIXED_COST_CEILINGS.find(line=>line.id==="llc-formation")!;
 assert.deepEqual([current.fullMonthlyUsdCents,current.fullAnnualUsdCents,current.reserveReviewed],[null,null,false]);
 assert.equal(sources.formation.initialMinor,50000);
 assert.equal(sources.formation.includesGovernmentFees,true);
 assert.equal(sources.formation.includesFirstAgentYear,true);
 assert.equal(sources.registeredAgent.annualMinor,10000);
});


test("deployment and function artifact retention is an explicit unknown whole-LLC cost",()=>{
 assert.ok(LLC_FIXED_COST_IDS.includes("deployment-artifact-retention"));
 assert.equal(allocateEntireLlcFixedCosts(fixture().filter(line=>line.id!=="deployment-artifact-retention")),null);
 const current=CURRENT_LLC_FIXED_COST_CEILINGS.find(line=>line.id==="deployment-artifact-retention")!;
 assert.deepEqual([current.fullMonthlyUsdCents,current.fullAnnualUsdCents,current.reserveReviewed],[null,null,false]);
 assert.equal(sources.deploymentArtifacts.perGbMonthMinorEach,10);
 assert.equal(sources.deploymentArtifacts.approvedCeiling,false);
});

test("missing fixed-cost fields cannot inherit a zero ceiling or review evidence",()=>{
 const replacements = {id:LLC_FIXED_COST_IDS[0],fullMonthlyUsdCents:0,fullAnnualUsdCents:0,evidence:"SYNTHETIC inherited review",reserveReviewed:true};
 for(const key of ["id","fullMonthlyUsdCents","fullAnnualUsdCents","evidence","reserveReviewed"] as const){
  const original=Object.getOwnPropertyDescriptor(Object.prototype,key);
  const lines=fixture();
  delete (lines[0] as Partial<FixedCostCeiling>)[key];
  Object.defineProperty(lines[0],"unexpected",{value:"keeps the own-field count",enumerable:true});
  try{
   Object.defineProperty(Object.prototype,key,{configurable:true,writable:true,value:{value:replacements[key]}});
   assert.equal(allocateEntireLlcFixedCosts(lines),null,key);
  }finally{
   if(original)Object.defineProperty(Object.prototype,key,original);
   else Reflect.deleteProperty(Object.prototype,key);
  }
 }
});
test("missing fixed-cost fields never execute descriptor-map prototype getters",()=>{
 for(const key of ["id","fullMonthlyUsdCents","fullAnnualUsdCents","evidence","reserveReviewed"] as const){
  const original=Object.getOwnPropertyDescriptor(Object.prototype,key);
  const lines=fixture();let reads=0;
  delete (lines[0] as Partial<FixedCostCeiling>)[key];
  Object.defineProperty(lines[0],"unexpected",{value:"keeps the own-field count",enumerable:true});
  try{
   Object.defineProperty(Object.prototype,key,{configurable:true,get(){reads++;return{value:0};}});
   assert.equal(allocateEntireLlcFixedCosts(lines),null,key);
   assert.equal(reads,0,key);
  }finally{
   if(original)Object.defineProperty(Object.prototype,key,original);
   else Reflect.deleteProperty(Object.prototype,key);
  }
 }
 const expected=fixture();
 assert.deepEqual(allocateEntireLlcFixedCosts(expected),{
  monthlyUsdCents:expected.reduce((sum,line)=>sum+line.fullMonthlyUsdCents!,0),
  annualUsdCents:expected.reduce((sum,line)=>sum+line.fullAnnualUsdCents!,0),
  marktmorgenBps:10000,hazelsongBps:0,
 });
 assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS),null);
});

test("detaching own fixed costs never invokes inherited setters or replacement zero getters",()=>{
 for(const key of ["id","fullMonthlyUsdCents","fullAnnualUsdCents","evidence","reserveReviewed"] as const){
  const original=Object.getOwnPropertyDescriptor(Object.prototype,key);
  const lines=fixture(),expected=allocateEntireLlcFixedCosts(lines);
  let reads=0,writes=0;
  try{
   Object.defineProperty(Object.prototype,key,{
    configurable:true,
    get(){reads++;return key==="evidence"?"inherited substitution":key==="reserveReviewed"?true:key==="id"?LLC_FIXED_COST_IDS[0]:0;},
    set(){writes++;},
   });
   assert.deepEqual(allocateEntireLlcFixedCosts(lines),expected,key);
   assert.deepEqual([reads,writes],[0,0],key);
  }finally{
   if(original)Object.defineProperty(Object.prototype,key,original);
   else Reflect.deleteProperty(Object.prototype,key);
  }
 }
 assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS),null);
});
