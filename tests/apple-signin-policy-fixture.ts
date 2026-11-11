/** Test runner only: never reachable from the production import graph. */
export const APPLE_SIGNIN_APPROVED = false;
export function appleSignInReady(): boolean { return process.env.TEST_APPLE_SIGNIN === "1"; }
