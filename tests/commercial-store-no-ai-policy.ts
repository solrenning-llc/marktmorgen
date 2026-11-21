import type { AiSpendPolicy } from '../lib/ai-spend-policy';
export * from '../lib/ai-spend-policy';
/** Synthetic ceilings only, as tests/commercial-ai-approved-policy.ts, except that Store, which publishes no AI right
 * (AI_MONTHLY.creator and ANSWERS_MONTHLY.creator are 0), gets an AI ceiling of 0, as the automatic policy gives it. */
let fixedMonth: string | null = null;
export const CURRENT_AI_SPEND_POLICY: AiSpendPolicy = {
  reviewId:'synthetic_store_no_ai',
  get month(){return fixedMonth??new Date().toISOString().slice(0,7);},
  set month(value:string){fixedMonth=value;},
  evidence:'TEST ONLY: synthetic commercial gate fixture with a zero Store AI ceiling, not actual funding',
  requestMicroUsd:{'claude-sonnet-5-5':1,'claude-haiku-5-5':1},
  storeMicroUsd:{creator:0,pro:10000,scale:10000,trial:0,setup:0,ended:0},
  fundedStores:{creator:10000,pro:10000,scale:10000,trial:0,setup:0,ended:0},
  companyMicroUsd:200000000,
};
export const currentAiSpendPolicy=()=>CURRENT_AI_SPEND_POLICY;
