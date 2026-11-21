/**
 * Step 1 of OWNER-20261121-0000-COMMERCIAL-TERMS-STORAGE (21/11/2026): a published version of the commercial terms never
 * changes, and no contract is admitted while each version cannot be stored by its digest (lib/commercial-terms-versions.ts,
 * lib/commercial-terms-digest.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_COMMERCIAL_TERMS, CURRENT_TERMS_DIGEST } from '@/lib/commercial-margin';
import { PUBLISHED_COMMERCIAL_TERMS } from '@/lib/commercial-terms-versions';
import { assertContractAdmissionAllowed, COMMERCIAL_TERMS_STORED, isCommercialTermsDigest } from '@/lib/commercial-terms-digest';
import { CURRENT_CONTRACT_FUNDING_POLICY } from '@/lib/contract-funding-rules';
import { contractFixture } from './contract-funding-fixture';

test('the terms in force are exactly the published text of their version: a change takes a new version', () => {
  const version = CURRENT_COMMERCIAL_TERMS.schemaVersion;
  assert.ok(Object.hasOwn(PUBLISHED_COMMERCIAL_TERMS, version), `version ${version} is not published: add its line`);
  assert.equal(CURRENT_TERMS_DIGEST, PUBLISHED_COMMERCIAL_TERMS[version], `the text of published version ${version} changed: give the terms a new schemaVersion and a new line`);
});

test('every published line is a well-formed digest of its own version, and the version in force is the newest', () => {
  const versions = Object.keys(PUBLISHED_COMMERCIAL_TERMS).map(Number);
  for (const version of versions) {
    const digest = PUBLISHED_COMMERCIAL_TERMS[version];
    assert.ok(isCommercialTermsDigest(digest), digest);
    assert.ok(digest.startsWith(`v${version}:sha256:`), digest);
  }
  assert.equal(new Set(Object.values(PUBLISHED_COMMERCIAL_TERMS)).size, versions.length);
  assert.equal(Math.max(...versions), CURRENT_COMMERCIAL_TERMS.schemaVersion);
});

test('no contract may be admitted until the terms are stored by digest: the code refuses a policy in force', () => {
  assert.equal(COMMERCIAL_TERMS_STORED, false);
  assert.equal(CURRENT_CONTRACT_FUNDING_POLICY, null);
  assert.doesNotThrow(() => assertContractAdmissionAllowed(null));
  assert.throws(() => assertContractAdmissionAllowed(contractFixture().policy), /OWNER-20261121-0000/);
  assert.doesNotThrow(() => assertContractAdmissionAllowed(contractFixture().policy, true));
});
