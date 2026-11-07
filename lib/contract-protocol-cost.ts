import {CONTRACT_KEYS,CONTRACT_FUNDING_RULES,type ContractKey} from "@/lib/contract-funding-rules";
import {PUBLISHED_PLAN_PRICES} from "@/lib/plan";
import {protocolInfrastructureMicroUsd,type ProtocolInfrastructureBounds} from "@/lib/spend-cost-table";

export type ContractProtocolInfrastructureCosts = Record<ContractKey,{
 contractKey:ContractKey;
 paidMonths:number;
 publishedPriceCents:number;
 infrastructure:{baseMicroUsd:number;providerAllowanceMicroUsd:number;totalMicroUsd:number};
 infrastructureCents:number;
}>;

/** All six plan/cycle profiles must be supplied as own finite data. Each
 * profile covers its whole proposed obligation, including its liability tail.
 * Annual profiles are never inferred by averaging or multiplying a monthly
 * profile; their explicit operations and retention are priced independently.
 * paidMonths is contract metadata, not verification of the supplied horizon.
 * This is an infrastructure comparison, not total cost, funded cash, a margin
 * assessment, an approved retention policy or permission to operate.
 */
export function contractProtocolInfrastructureCosts(input:unknown):ContractProtocolInfrastructureCosts|null {
 const result={} as ContractProtocolInfrastructureCosts;
 try{
  if(!input||typeof input!=="object"||Array.isArray(input)||
     ![Object.prototype,null].includes(Object.getPrototypeOf(input))||
     Reflect.ownKeys(input).length!==CONTRACT_KEYS.length)return null;
  for(const key of CONTRACT_KEYS){
   const field=Object.getOwnPropertyDescriptor(input,key);
   if(!field||!field.enumerable||!Object.hasOwn(field,"value"))return null;
   // Price the original profile: a prior JSON projection could erase a
   // category hidden by Proxy reflection before the pricing boundary sees it.
   const cost=protocolInfrastructureMicroUsd(field.value as ProtocolInfrastructureBounds);
   if(!cost)return null;
   const [tier,cycle]=key.split("_") as ["creator"|"pro"|"scale","month"|"year"];
   Object.defineProperty(result,key,{value:{
    contractKey:key,
    paidMonths:CONTRACT_FUNDING_RULES.paidMonths[cycle],
    publishedPriceCents:PUBLISHED_PLAN_PRICES[tier][cycle],
    infrastructure:cost,
    infrastructureCents:Number((BigInt(cost.totalMicroUsd)+BigInt(9_999))/BigInt(10_000)),
   },enumerable:true,writable:true,configurable:true});
  }
  // Every original profile is now validated plain numeric data. Reject a
  // Proxy at the matrix root without cloning unvalidated accessor graphs.
  structuredClone(input);
 }catch{return null;}
 return result;
}
