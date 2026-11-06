/** Nonzero retention ceiling for actual commercial-gate integration tests only. */
export * from "../lib/llc-fixed-costs";
import {fixedCostsFixture} from "./llc-fixed-approved-policy";
export const CURRENT_LLC_FIXED_COST_CEILINGS=fixedCostsFixture(100);
