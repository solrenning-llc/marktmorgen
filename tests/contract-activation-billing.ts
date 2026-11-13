import type {CheckoutContractActivation} from '../lib/contract-funding';
export const activationObservations:{calls:CheckoutContractActivation[];accept:boolean}={calls:[],accept:false};
export async function activateCheckoutContract(input:CheckoutContractActivation):Promise<boolean>{
 activationObservations.calls.push(input);return activationObservations.accept;
}

export const switchActivationObservations:{calls:CheckoutContractActivation[];accept:boolean}={calls:[],accept:false};
export async function activateSwitchContract(input:CheckoutContractActivation):Promise<boolean>{
 switchActivationObservations.calls.push(input);return switchActivationObservations.accept;
}

// Production binding and closed restart guards stay exact for transitive imports.
export {contractFundingBinding,activateRenewalContract,renewalContractNonce,reserveRenewalContractFunding,reserveRestartContractFunding,takeRestartRecovery,restartSubmissionOpenNow,recordRestartResult,armRestartSubmission,claimRestartIntent} from '../lib/contract-funding';
