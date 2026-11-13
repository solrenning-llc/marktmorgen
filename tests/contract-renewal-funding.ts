// Double of lib/contract-funding.ts for contract-renewal.test.ts only. It keeps
// the ledger's answers at the level billing sees them; the production Lua of
// the renewal reservation and activation runs against a real Redis in
// scripts/test_contract_funding_redis.py.
import type {CheckoutContractActivation} from '../lib/contract-funding';
type Reservation={statsId:string;subscriptionId:string;tier:string;cycle:string;periodStartSeconds:number};
export const renewalLedger:{
 /** The period the checkout grant was activated for: the only one it answers for afterwards. */
 committed:{start:number;end:number}|null;
 /** The period a renewal grant was last activated for. */
 renewed:{start:number;end:number}|null;
 reserves:Reservation[];refusedReserves:number;activations:CheckoutContractActivation[];refuseReserve:boolean;
}={committed:null,renewed:null,reserves:[],refusedReserves:0,activations:[],refuseReserve:false};
export function resetRenewalLedger(committed:{start:number;end:number}):void{
 renewalLedger.committed=committed;renewalLedger.renewed=null;renewalLedger.reserves.length=0;renewalLedger.refusedReserves=0;renewalLedger.activations.length=0;renewalLedger.refuseReserve=false;
}
/** A committed checkout proof answers only for its own exact period (ACTIVATE_CONTRACT's {2,finish}). */
export async function activateCheckoutContract(input:CheckoutContractActivation):Promise<boolean>{
 const c=renewalLedger.committed;
 return Boolean(c&&input.periodStartSeconds===c.start&&input.periodEndSeconds===c.end);
}
export async function activateSwitchContract():Promise<boolean>{return false;}
/** One reservation per store, subscription and new period start; a repeat is refused as the real ledger refuses it. */
export async function reserveRenewalContractFunding(statsId:string,subscriptionId:string,tier:string,cycle:string,periodStartSeconds:number):Promise<{id:string}|null>{
 const same=renewalLedger.reserves.some(r=>r.statsId===statsId&&r.subscriptionId===subscriptionId&&r.periodStartSeconds===periodStartSeconds);
 // As RESERVE_CONTRACT: only the period beginning exactly where the active term ended.
 const source=renewalLedger.renewed??renewalLedger.committed;
 if(renewalLedger.refuseReserve||same||!source||periodStartSeconds!==source.end){renewalLedger.refusedReserves++;return null;}
 renewalLedger.reserves.push({statsId,subscriptionId,tier,cycle,periodStartSeconds});
 return {id:'ctr_rn_double'};
}
/** Activates only a reserved, contiguous, paid period; an identical repeat answers again without a new reservation. */
export async function activateRenewalContract(input:CheckoutContractActivation):Promise<boolean>{
 renewalLedger.activations.push(input);
 const reserved=renewalLedger.reserves.some(r=>r.statsId===input.statsId&&r.subscriptionId===input.subscriptionId&&r.periodStartSeconds===input.periodStartSeconds&&r.tier===input.tier&&r.cycle===input.cycle);
 const source=renewalLedger.renewed??renewalLedger.committed;
 const repeat=renewalLedger.renewed!==null&&renewalLedger.renewed.start===input.periodStartSeconds&&renewalLedger.renewed.end===input.periodEndSeconds;
 if(!reserved||input.trialing!==false||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(input.grantId))return false;
 if(repeat)return true;
 if(!source||input.periodStartSeconds!==source.end)return false;
 renewalLedger.renewed={start:input.periodStartSeconds,end:input.periodEndSeconds};
 return true;
}

// Production binding and closed restart guards stay exact for transitive imports.
export {contractFundingBinding,renewalContractNonce,reserveRestartContractFunding,takeRestartRecovery,restartSubmissionOpenNow,recordRestartResult,armRestartSubmission,claimRestartIntent} from '../lib/contract-funding';
