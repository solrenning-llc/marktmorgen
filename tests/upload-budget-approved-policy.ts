import { UPLOAD_BUDGET_SCOPES, type UploadBudgetPolicy } from '../lib/upload-budget-policy';
export * from '../lib/upload-budget-policy';
export function uploadTestPolicy(funded=1): UploadBudgetPolicy {
  const perStore=Object.fromEntries(UPLOAD_BUDGET_SCOPES.map(scope=>[scope,{opens:2,authorizedBytes:10,controlRequests:6}])) as UploadBudgetPolicy['perStore'];
  const fundedStores=Object.fromEntries(UPLOAD_BUDGET_SCOPES.map(scope=>[scope,funded])) as UploadBudgetPolicy['fundedStores'];
  return {reviewId:'synthetic_upload_only',month:new Date().toISOString().slice(0,7),evidence:'Synthetic reservation tests only; not real funding or profitability evidence.',
    perStore,fundedStores,company:{opens:12*funded,authorizedBytes:60*funded,controlRequests:36*funded}};
}
let fixedMonth: string | null = null;
/** The month is read when the policy is read, from the clock a test may have set, unless a test sets one. */
export const CURRENT_UPLOAD_BUDGET_POLICY: UploadBudgetPolicy = Object.defineProperty(uploadTestPolicy(10000), 'month', {
  get: () => fixedMonth ?? new Date().toISOString().slice(0, 7),
  set: (value: string) => { fixedMonth = value; },
  enumerable: true,
});
export const currentUploadBudgetPolicy=()=>CURRENT_UPLOAD_BUDGET_POLICY;
