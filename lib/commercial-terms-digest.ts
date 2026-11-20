/**
 * The commercial terms, cited by their SHA-256 (owner, 20/11/2026 18h14 Fortaleza, DONO-20261120-1814-CONTRATO-HASH).
 *
 * A contract's encoding (lib/contract-funding-rules.ts canonicalFinancialSnapshot) is refused above 1 MiB, and the
 * terms text (CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, about 20 KB) was repeated in it in every part that names the terms.
 * Now the context of a contract holds the text once, and every other part (the review, each scenario's tax context and
 * tax review) holds its digest: "v<schemaVersion>:sha256:<hex>", the SHA-256 of the exact text, with its version.
 * Every check that compared the text compares the digest recomputed from the text in force, which is as strong.
 *
 * Reading the terms back recomputes the digest over the text found, and refuses, visibly and by reason, a text that is
 * missing or does not match: never valid, never empty terms. expandCommercialReview rebuilds a review with the text in
 * place of every digest, byte for byte as it was encoded before (tests/contract-terms-digest.test.ts).
 *
 * Browser-safe: no static import of node:crypto. This module reaches pages drawn in the browser through
 * lib/commercial-margin.ts; there the hash is unavailable, every digest is null, and every check refuses.
 */
import type { CommercialMarginReview } from '@/lib/commercial-margin';

const DIGEST = /^v([1-9]\d{0,5}):sha256:([0-9a-f]{64})$/;

const sha256: ((text: string) => string) | null = (() => {
  try {
    if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') return null;
    const crypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto') | undefined;
    if (!crypto || typeof crypto.createHash !== 'function') return null;
    return (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  } catch {
    return null;
  }
})();

// The last text digested, so the same 20 KB text checked in a loop is parsed and hashed once.
let memo: { text: string; digest: string | null } | null = null;

/** The digest of a terms text: its schema version and the SHA-256 of the exact text. Null for anything that is not
 * a terms text with a whole positive schemaVersion, or where no hash is available. */
export function commercialTermsDigest(text: unknown): string | null {
  if (typeof text !== 'string' || !text) return null;
  if (memo && memo.text === text) return memo.digest;
  let digest: string | null = null;
  try {
    const version = (JSON.parse(text) as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (sha256 && typeof version === 'number' && Number.isSafeInteger(version) && version >= 1 && version <= 999_999) digest = `v${version}:sha256:${sha256(text)}`;
  } catch {
    digest = null;
  }
  memo = { text, digest };
  return digest;
}

export function isCommercialTermsDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

/** True only when the digest is well formed and recomputes from the text. */
export function termsMatchDigest(digest: unknown, text: unknown): boolean {
  return isCommercialTermsDigest(digest) && commercialTermsDigest(text) === digest;
}

export type TermsRead = { ok: true; text: string } | { ok: false; reason: 'terms_digest_invalid' | 'terms_unknown' | 'terms_digest_mismatch' };

/** The terms a digest cites, from the text kept for it: refused when the digest is malformed, the text is missing, or
 * its digest does not recompute to the cited one. */
export function termsTextFor(digest: unknown, stored: unknown): TermsRead {
  if (!isCommercialTermsDigest(digest)) return { ok: false, reason: 'terms_digest_invalid' };
  if (typeof stored !== 'string' || !stored) return { ok: false, reason: 'terms_unknown' };
  return commercialTermsDigest(stored) === digest ? { ok: true, text: stored } : { ok: false, reason: 'terms_digest_mismatch' };
}

type Cited = Record<string, unknown> & { termsDigest?: unknown };
type ScenarioCopy = { taxContext?: { contract?: Cited }; taxReview?: { scope?: { contract?: Cited } } };

/**
 * A review with the terms text in place of every digest, under the field names it was encoded with before
 * (priceAndRightsSnapshot and termsSnapshot): for the customer, an export of their data, a dispute or the law. Every
 * digest must recompute from the text, or nothing is rebuilt.
 */
export function expandCommercialReview(review: CommercialMarginReview, text: unknown): { ok: true; review: Record<string, unknown> } | Extract<TermsRead, { ok: false }> {
  const read = termsTextFor(review?.priceAndRightsDigest, text);
  if (!read.ok) return read;
  const copy = structuredClone(review) as unknown as Record<string, unknown>;
  delete copy.priceAndRightsDigest;
  copy.priceAndRightsSnapshot = read.text;
  // A scenario's tax context and its tax review may share one contract object: rebuild each object once.
  const rebuilt = new Set<object>();
  for (const scenario of Object.values((copy.scenarios ?? {}) as Record<string, ScenarioCopy | null>)) {
    for (const contract of [scenario?.taxContext?.contract, scenario?.taxReview?.scope?.contract]) {
      if (!contract || rebuilt.has(contract)) continue;
      rebuilt.add(contract);
      if (contract.termsDigest !== review.priceAndRightsDigest) return { ok: false, reason: 'terms_digest_mismatch' };
      delete contract.termsDigest;
      contract.termsSnapshot = read.text;
    }
  }
  return { ok: true, review: copy };
}
