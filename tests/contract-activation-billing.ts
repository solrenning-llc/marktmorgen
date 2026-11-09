import type {CheckoutContractActivation} from '../lib/contract-funding';
export const activationObservations:{calls:CheckoutContractActivation[];accept:boolean}={calls:[],accept:false};
export async function activateCheckoutContract(input:CheckoutContractActivation):Promise<boolean>{
 activationObservations.calls.push(input);return activationObservations.accept;
}

export const switchActivationObservations:{calls:CheckoutContractActivation[];accept:boolean}={calls:[],accept:false};
export async function activateSwitchContract(input:CheckoutContractActivation):Promise<boolean>{
 switchActivationObservations.calls.push(input);return switchActivationObservations.accept;
}

// The read-only proof is observed separately and never activates anything.
export const observationReads:{checkout:CheckoutContractActivation[];switches:CheckoutContractActivation[];accept:boolean}={checkout:[],switches:[],accept:false};
export async function observeCheckoutContract(input:CheckoutContractActivation):Promise<boolean>{
 observationReads.checkout.push(input);return observationReads.accept;
}
export async function observeSwitchContract(input:CheckoutContractActivation):Promise<boolean>{
 observationReads.switches.push(input);return observationReads.accept;
}

// Production binding and closed restart guards stay exact for transitive imports.
export {contractFundingBinding,reserveRestartContractFunding,takeRestartRecovery,restartSubmissionOpenNow,recordRestartResult,armRestartSubmission,claimRestartIntent} from '../lib/contract-funding';
