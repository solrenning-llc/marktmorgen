/**
 * tests/r30-scan-followup.test.ts only (tests/test-config.mjs): the list's published limits, with MAX_LEADS not a
 * multiple of 500, so listAsCsv's page ceiling (MAX_LEADS / 500 + 10) is not a whole number.
 */
export * from "../lib/contact-rules";
export const MAX_LEADS = 100_250;
