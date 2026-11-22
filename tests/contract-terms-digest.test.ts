/**
 * The commercial terms are bound once in a contract's encoding, and cited everywhere else by their SHA-256
 * (owner, 20/11/2026 18h14 Fortaleza, DONO-20261120-1814-CONTRATO-HASH; lib/commercial-terms-digest.ts).
 *
 * A contract restart encodes {input, policy, context} through canonicalFinancialSnapshot, which refuses anything
 * above 1 MiB. The terms text (CURRENT_PRICE_AND_RIGHTS_SNAPSHOT) was repeated in it 39 times: once in the context,
 * in the review, in each scenario's tax context and tax review, and again inside policy.financialSnapshot, the review
 * encoded as a string. Synthetic records only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CURRENT_COMMERCIAL_TERMS, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, CURRENT_TERMS_DIGEST } from '@/lib/commercial-margin';
import { canonicalFinancialSnapshot, contractFundingConfiguration } from '@/lib/contract-funding-rules';
import { commercialTermsDigest, expandCommercialReview, termsTextFor } from '@/lib/commercial-terms-digest';
import { contractFixture } from './contract-funding-fixture';

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
// The terms text as it sits in an encoding (escaped once), and inside policy.financialSnapshot (escaped twice).
const once = JSON.stringify(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT).slice(1, 201);
const twice = JSON.stringify(JSON.stringify(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT)).slice(1, 201);

test("a contract's encoding holds the terms text once; everything else cites its digest", () => {
  const f = contractFixture();
  const encoded = canonicalFinancialSnapshot({ policy: f.policy, context: f.context })!;
  assert.ok(encoded);
  assert.equal(occurrences(encoded, once), 1, 'the context holds the one full copy');
  assert.equal(occurrences(encoded, twice), 0, 'the review encoded in the policy holds none');
  // The review cites it once, and each scenario twice (its tax context and its tax review's scope); the review is in
  // the context and again, encoded, in the policy.
  assert.equal(occurrences(encoded, CURRENT_TERMS_DIGEST!), 2 * (1 + 2 * Object.keys(f.review.scenarios).length));
  assert.ok(new TextEncoder().encode(encoded).length < 512 * 1024, 'well under the 1 MiB bound');
  assert.ok(contractFundingConfiguration(f.policy, f.context, f.now));
});

test('the digest is the SHA-256 of the exact terms text, with its schema version', () => {
  const hex = createHash('sha256').update(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, 'utf8').digest('hex');
  assert.equal(CURRENT_TERMS_DIGEST, `v${CURRENT_COMMERCIAL_TERMS.schemaVersion}:sha256:${hex}`);
  assert.equal(commercialTermsDigest(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT), CURRENT_TERMS_DIGEST);
  assert.notEqual(commercialTermsDigest(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT + ' '), CURRENT_TERMS_DIGEST);
  for (const bad of ['', 'not json', '{}', '{"schemaVersion":0}', '{"schemaVersion":"29"}', null, 29]) assert.equal(commercialTermsDigest(bad), null, String(bad));
});

test('reading the terms recomputes the digest and refuses visibly when it does not match or the text is missing', () => {
  assert.deepEqual(termsTextFor(CURRENT_TERMS_DIGEST, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT), { ok: true, text: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT });
  assert.deepEqual(termsTextFor(CURRENT_TERMS_DIGEST, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT.replace('29', '30')), { ok: false, reason: 'terms_digest_mismatch' });
  assert.deepEqual(termsTextFor(CURRENT_TERMS_DIGEST, null), { ok: false, reason: 'terms_unknown' });
  assert.deepEqual(termsTextFor(CURRENT_TERMS_DIGEST, ''), { ok: false, reason: 'terms_unknown' });
  assert.deepEqual(termsTextFor('v29:sha256:xyz', CURRENT_PRICE_AND_RIGHTS_SNAPSHOT), { ok: false, reason: 'terms_digest_invalid' });
});

test('the full review is rebuilt byte for byte as it was encoded with the text repeated', () => {
  const f = contractFixture();
  const expanded = expandCommercialReview(f.review, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT);
  assert.ok(expanded.ok);
  // The old format, built by hand: the text in place of every digest, under the old field names.
  const old = structuredClone(f.review) as unknown as Record<string, unknown>;
  delete old.priceAndRightsDigest; old.priceAndRightsSnapshot = CURRENT_PRICE_AND_RIGHTS_SNAPSHOT;
  for (const scenario of Object.values(old.scenarios as Record<string, { taxContext?: { contract?: Record<string, unknown> }; taxReview?: { scope?: { contract?: Record<string, unknown> } } }>)) {
    for (const contract of [scenario.taxContext?.contract, scenario.taxReview?.scope?.contract]) {
      if (!contract) continue;
      delete contract.termsDigest; contract.termsSnapshot = CURRENT_PRICE_AND_RIGHTS_SNAPSHOT;
    }
  }
  assert.equal(canonicalFinancialSnapshot(expanded.ok && expanded.review), canonicalFinancialSnapshot(old));
  assert.deepEqual(expandCommercialReview(f.review, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT + ' '), { ok: false, reason: 'terms_digest_mismatch' });
});

test('the 1 MiB bound is still checked: an encoding above it is refused, never cut', () => {
  assert.equal(canonicalFinancialSnapshot({ big: 'x'.repeat(1024 * 1024) }), null);
});
