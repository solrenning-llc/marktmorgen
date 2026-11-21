/**
 * Every published version of the commercial terms, by schemaVersion, with the digest of its exact text
 * (owner, 21/11/2026 00h00 Fortaleza, OWNER-20261121-0000-COMMERCIAL-TERMS-STORAGE, step 1).
 *
 * A version, once published, never changes. The full text of each version lives once in the code
 * (CURRENT_PRICE_AND_RIGHTS_SNAPSHOT in lib/commercial-margin.ts), and the git history keeps every earlier one.
 * tests/commercial-terms-versions.test.ts fails when the terms in force do not match the line of their version here:
 * a change to the terms takes a new schemaVersion and a new line, and no earlier line is ever edited or removed.
 *
 * Pure data: no environment, no network, no database.
 */
export const PUBLISHED_COMMERCIAL_TERMS: Readonly<Record<number, string>> = Object.freeze({
  29: 'v29:sha256:f7a557e4db1d5fb6b05d6f49aef4091ed9c3b5b784b6ae3711c4265f7d93b175',
});
