import { MAX_FILE_BYTES } from "@/lib/product-file";
import { PIECE_BYTES, PIECES_PER_ASK } from "@/lib/vault-rules";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { COST_TABLE_VERSION, uploadOperationsMicroUsd } from "@/lib/spend-cost-table";
/** Public numerical ceilings, not proof of supplier pricing or tax treatment. */
export const UPLOAD_BUDGET_SCOPES = ['creator','pro','scale','trial','setup','ended'] as const;
/** Where an upload goes: an R2 file, a Blob file, or a lesson video kept by the video service. */
export type UploadBackend = 'r2'|'blob'|'stream';
/** The upload doors reserveStoreUpload opens (lib/upload-budget.ts). Direct
 * Blob and video-service grants do not establish the same revocable,
 * size-bound session contract, so they stay closed until that provider path
 * is proven. Public pages read the same answer, so captions and video sizes,
 * which exist only for a video the video service keeps, are promised only
 * while its door can open (AGENTS.md, VR Part A item 2). */
const OPEN_UPLOAD_BACKENDS: Readonly<Record<UploadBackend, boolean>> = { r2: true, blob: false, stream: false };
export function uploadBackendOpen(backend: UploadBackend): boolean {
  return OPEN_UPLOAD_BACKENDS[backend] === true;
}
export type UploadBudgetScope = typeof UPLOAD_BUDGET_SCOPES[number];
export type UploadCaps = { opens: number; authorizedBytes: number; controlRequests: number };
export type UploadBudgetPolicy = {
  reviewId: string;
  month: string;
  evidence: string;
  company: UploadCaps;
  perStore: Record<UploadBudgetScope,UploadCaps>;
  /** Maximum store allocations in this month, not a forecast of average usage. */
  fundedStores: Record<UploadBudgetScope,number>;
};
export const UPLOAD_BUDGET_RULES = {
  schema: 2,
  boundedBackend: 'r2-revocable-multipart-only',
  completionAndCancellation: 'reserved-liability-not-blocked',
  /** Exact in Lua doubles and JavaScript numbers (below 2^53): a month of bytes across every allocated store fits. */
  maxInteger: 9_000_000_000_000_000,
  ledger: 'nl:upload-budget:v2:{YYYY-MM}',
  scopeChanges: 'review-required-no-counter-reset',
  reservation: 'before-provider-authorization-no-refund',
  missingLedger: 'automatic-policy-opens-each-month-once-never-recreates',
  changedAutomaticCeilings: 'carry-every-counter',
  expiry: 'none',
} as const;
export const uploadLedgerKey = (month: string) => 'nl:upload-budget:v2:{' + month + '}';
/** Marks that a month's ledger was opened, in the same cluster slot, so a lost ledger is never recreated empty. */
export const uploadOpenedKey = (month: string) => uploadLedgerKey(month) + ':opened';

/** The smallest number of upload-control requests that lets every start and every byte be signed. */
export function minimumControlRequests(opens: number, authorizedBytes: number): number {
  if (opens === 0) return 0;
  return opens + opens + Math.floor((authorizedBytes - opens) / (PIECE_BYTES * PIECES_PER_ASK));
}
/** Upload starts a paid store may make in a window (lib/allowance-window.ts: a billing month when the store pays). */
export const PAID_UPLOAD_OPENS = { creator: 50, pro: 300, scale: 600 } as const;
/**
 * Each paid plan's monthly upload allowance, computed from what the plan
 * already publishes and enforces: newly authorized bytes up to the plan's
 * whole storage (lib/storage-rules.ts), its upload starts, and enough signing
 * requests for every byte plus one more batch for each start. Stored bytes
 * are paid for by the storage allowance, because admission counts every open
 * reservation against it (docs/storage-reservations.md); what this allowance
 * adds is the provider operations, priced in lib/spend-cost-table.ts and held
 * to the 60% floor by tests/spend-floor.test.ts.
 *
 * Trial, setup and ended stores have no revenue: their uploads are a funded
 * exposure with no approved reserve, so they have no allocation here.
 */
const paidCaps = (tier: 'creator'|'pro'|'scale'): UploadCaps => {
  const opens = PAID_UPLOAD_OPENS[tier], authorizedBytes = PAID_STORAGE_BYTES[tier];
  return { opens, authorizedBytes, controlRequests: minimumControlRequests(opens, authorizedBytes) + opens };
};
const NONE: UploadCaps = { opens: 0, authorizedBytes: 0, controlRequests: 0 };
export const AUTOMATIC_UPLOAD_CAPS: Record<UploadBudgetScope, UploadCaps> = {
  creator: paidCaps('creator'), pro: paidCaps('pro'), scale: paidCaps('scale'), trial: NONE, setup: NONE, ended: NONE,
};
/** Paid stores' allocations are funded by their own subscription; a finite count per tier. */
export const PAID_UPLOAD_ALLOCATIONS_PER_TIER = 10_000;
const AUTOMATIC_UPLOAD_FUNDED: Record<UploadBudgetScope, number> = { creator: PAID_UPLOAD_ALLOCATIONS_PER_TIER, pro: PAID_UPLOAD_ALLOCATIONS_PER_TIER, scale: PAID_UPLOAD_ALLOCATIONS_PER_TIER, trial: 0, setup: 0, ended: 0 };
export const AUTOMATIC_UPLOAD_REVIEW_ID = 'automatic_' + COST_TABLE_VERSION.replace(/[^A-Za-z0-9_-]/g, '_');
/** Month-free allowances, bound into the commercial terms snapshot. */
export const AUTOMATIC_UPLOAD_BUDGET_CEILINGS = { reviewId: AUTOMATIC_UPLOAD_REVIEW_ID, perStore: AUTOMATIC_UPLOAD_CAPS, fundedStores: AUTOMATIC_UPLOAD_FUNDED } as const;
/** The most one store's monthly upload allowance can cost in provider operations, in micro-USD. */
export function uploadWorstCostMicroUsd(scope: UploadBudgetScope): number {
  const cap = AUTOMATIC_UPLOAD_CAPS[scope];
  const value = uploadOperationsMicroUsd(cap.opens, cap.controlRequests, PIECES_PER_ASK);
  if (value === null) throw new Error('Unpriceable upload allowance');
  return value;
}
/** The automatic policy for the current UTC month. Nothing to renew. */
export function automaticUploadBudgetPolicy(now = new Date()): UploadBudgetPolicy|null {
  if (!Number.isFinite(now.getTime())) return null;
  const sum = (dimension: keyof UploadCaps) => UPLOAD_BUDGET_SCOPES.reduce((total, scope) => total + AUTOMATIC_UPLOAD_CAPS[scope][dimension] * AUTOMATIC_UPLOAD_FUNDED[scope], 0);
  return {
    reviewId: AUTOMATIC_UPLOAD_REVIEW_ID,
    month: now.toISOString().slice(0, 7),
    evidence: 'Computed in code from the published storage allowances and ' + COST_TABLE_VERSION + ' (lib/spend-cost-table.ts).',
    company: { opens: sum('opens'), authorizedBytes: sum('authorizedBytes'), controlRequests: sum('controlRequests') },
    perStore: Object.fromEntries(UPLOAD_BUDGET_SCOPES.map(scope => [scope, { ...AUTOMATIC_UPLOAD_CAPS[scope] }])) as Record<UploadBudgetScope, UploadCaps>,
    fundedStores: { ...AUTOMATIC_UPLOAD_FUNDED },
  };
}
/** The policy in force now. Always the automatic one. */
export function currentUploadBudgetPolicy(now = new Date()): UploadBudgetPolicy|null {
  return automaticUploadBudgetPolicy(now);
}
const amount = (n: unknown): n is number => typeof n==='number' && Number.isSafeInteger(n) && n>=0 && n<=UPLOAD_BUDGET_RULES.maxInteger;
const caps = (value: unknown): value is UploadCaps => {
  if(!value || typeof value!=='object')return false;
  const row=value as UploadCaps;
  return amount(row.opens)&&amount(row.authorizedBytes)&&amount(row.controlRequests);
};
export function isUploadBudgetConfigured(policy: UploadBudgetPolicy|null = currentUploadBudgetPolicy(), now = new Date()): policy is UploadBudgetPolicy {
  if(!policy || !Number.isFinite(now.getTime()) || policy.month!==now.toISOString().slice(0,7)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(policy.reviewId) || typeof policy.evidence!=='string' || !policy.evidence.trim()
    || !caps(policy.company) || !policy.perStore || !policy.fundedStores)return false;
  if(!UPLOAD_BUDGET_SCOPES.every(scope=>caps(policy.perStore[scope]) && amount(policy.fundedStores[scope])))return false;
  for(const scope of UPLOAD_BUDGET_SCOPES){
    const row=policy.perStore[scope];
    if(row.opens===0){if(row.authorizedBytes!==0)return false;}
    else {
      if(row.authorizedBytes<row.opens || BigInt(row.authorizedBytes)>BigInt(row.opens)*BigInt(MAX_FILE_BYTES))return false;
      const signBatches=BigInt(row.opens)+(BigInt(row.authorizedBytes)-BigInt(row.opens))/BigInt(PIECE_BYTES*PIECES_PER_ASK);
      if(BigInt(row.controlRequests)<BigInt(row.opens)+signBatches)return false;
    }
  }
  // Every allocated store can use its full allowance simultaneously. Do not
  // approve a shared pool that is smaller than the sum of all promised units.
  for(const dimension of ['opens','authorizedBytes','controlRequests'] as const){
    const total=UPLOAD_BUDGET_SCOPES.reduce((sum,scope)=>sum+BigInt(policy.perStore[scope][dimension])*BigInt(policy.fundedStores[scope]),BigInt(0));
    if(total>BigInt(policy.company[dimension]))return false;
  }
  return true;
}
/** Canonical binding prevents silently reusing a ledger after a limit changes. */
export function uploadBudgetSnapshot(policy: UploadBudgetPolicy): string {
  const fields=(row: UploadCaps)=>[row.opens,row.authorizedBytes,row.controlRequests];
  return JSON.stringify([UPLOAD_BUDGET_RULES.schema,policy.reviewId,policy.month,policy.evidence,fields(policy.company),
    UPLOAD_BUDGET_SCOPES.map(scope=>[scope,fields(policy.perStore[scope]),policy.fundedStores[scope]])]);
}

/** Customer-facing wording uses the same current ceilings as admission. */
export function uploadAllowanceWords(scope: UploadBudgetScope, policy: UploadBudgetPolicy|null=currentUploadBudgetPolicy()): string {
  if(!isUploadBudgetConfigured(policy))return 'New product and lesson file uploads are paused while monthly allowances are being reviewed.';
  const cap=policy.perStore[scope];
  if(cap.opens===0)return 'New product and lesson file uploads start with a paid plan.';
  const bytes=cap.authorizedBytes;
  const unit=bytes>=1_000_000_000?1_000_000_000:bytes>=1_000_000?1_000_000:1;
  const label=unit===1_000_000_000?'GB':unit===1_000_000?'MB':'bytes';
  const shown=Math.floor(bytes/unit*1000)/1000;
  return 'Product and lesson files: up to '+cap.opens.toLocaleString('en-US')+' upload starts and '+shown.toLocaleString('en-US',{maximumFractionDigits:3})+' '+label+' of newly authorized file data per billing month. Starting over uses a new allowance. The monthly limit includes '+cap.controlRequests.toLocaleString('en-US')+' requests to start uploads or obtain upload links.';
}
