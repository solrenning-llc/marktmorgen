// This alias is used only by contract-renewal.test.ts: it turns the renewals
// coverage on for that test alone. Production coverage keeps renewals false, and
// tests/contract-funding.test.ts holds that refusal before any Redis command.
export * from '../lib/contract-funding-rules';
export const CONTRACT_ADMISSION_COVERAGE={checkout:true,planSwitch:true,pauseRestart:false,resourceAllocations:false,renewals:true,settlementAndReserveReconciliation:false} as const;
