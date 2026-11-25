/** Approval and complete funded cost evidence are independent prerequisites. */
export const DISCORD_SIGNIN_APPROVED: boolean = false;
/** No provider price, funded global ceiling or owner setup has been reviewed. */
export const CURRENT_DISCORD_SIGNIN_COST_REVIEW: null = null;
export function discordSignInReady(): boolean {
  return DISCORD_SIGNIN_APPROVED && CURRENT_DISCORD_SIGNIN_COST_REVIEW !== null;
}
