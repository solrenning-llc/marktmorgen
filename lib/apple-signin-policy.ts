/** Only a later reviewed owner activation can change this approval. */
export const APPLE_SIGNIN_APPROVED: boolean = false;
/** Program, relay setup, complete cost and funded global admission remain unreviewed. */
export const CURRENT_APPLE_SIGNIN_COST_REVIEW: null = null;
export function appleSignInReady(): boolean {
  return APPLE_SIGNIN_APPROVED && CURRENT_APPLE_SIGNIN_COST_REVIEW !== null;
}
