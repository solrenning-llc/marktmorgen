/**
 * lib/opening for tests/billing-trial-studio-no-stripe.test.ts: everything from the real module, with paid plans
 * on sale, so the studio renders as it will on opening day. Only that one flag differs; nothing in lib/ changes.
 */
export * from "../lib/opening";
export const PLANS_ON_SALE = true;
