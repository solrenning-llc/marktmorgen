/** Build-time stand-in selected only by this test's runner wiring. */
export const DISCORD_SIGNIN_APPROVED = false;
export function discordSignInReady(): boolean { return process.env.TEST_DISCORD_SIGNIN === "1"; }
