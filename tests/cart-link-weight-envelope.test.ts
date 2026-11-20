// Codex G's proof on #1928 (codex/g-review-1928-weight-envelope@7b689b88, tests/g1928-weight-envelope.proof.ts), kept as a discovered test with its assertions unchanged (its default mode, an extra reply in the envelope).
import { cartLinkProducts, cartLinkUnits, CART_LINK_UNIT_BYTES } from '@/lib/cart-link-products';
import { KIND, MAX_PRODUCT_BYTES, productIds } from '@/lib/catalog';
import { STUDIO_PAGE_UNITS } from '@/lib/studio-allowance-rules';
import { countStudio } from '@/lib/studio-route';
import { addDraftProducts, claimHandle, ensureStatsId, setProductFile, setProductHidden, setSubscription, storeForEmail } from '@/lib/store';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { listingKeysRead, listingValues } from './listing-reads';
import { is, done } from './check';

globalThis.fetch = async () => { throw Error('No external service in G review'); };
async function main() {
  redis.clear(); const owner = 'g-weight-envelope@example.test';
  await claimHandle(owner, 'g-weight-envelope', 'Synthetic store', ''); await ensureStatsId(owner);
  await setSubscription(owner, { customerId: 'cus_GWeightEnvelope', subscriptionId: 'sub_GWeightEnvelope', active: true, tier: 'pro', period: paidPeriod() });
  const drafts = [...Array.from({ length: 30 }, (_, i) => ({ title: 'Free ' + i, summary: '', priceCents: 0, link: 'https://example.test/free' })), ...Array.from({ length: 24 }, (_, i) => ({ title: 'Paid ' + i, summary: '', priceCents: 1900, link: 'https://example.test/paid' }))];
  const added = await addDraftProducts(owner, drafts); if (!added.ok) throw Error('fixture creation refused');
  let shop = (await storeForEmail(owner))!;
  for (const id of productIds(shop)) { const result = await setProductHidden(owner, id, false); if (!result.ok) throw Error('publish refused'); }
  shop = (await storeForEmail(owner))!;
  const paidIds = shop.catalog.items.filter(p => (p.kind & KIND.paid) !== 0).map(p => p.id);
  if (paidIds.length !== 24) throw Error('fixture did not identify its 24 paid records');
  // Synthetic existing file metadata, within the catalog record ceiling. No upload or blob read occurs.
  for (const id of paidIds) {
    const result = await setProductFile(owner, id, { pathname: `stores/synthetic/${id}/file.pdf`, name: 'x'.repeat(18_000) + '.pdf', bytes: 1, contentType: 'application/pdf', addedAt: '2026-11-06' });
    if (!result.ok) throw Error('synthetic file metadata was refused');
  }
  shop = (await storeForEmail(owner))!;
  const mode = process.env.G_WEIGHT_MODE ?? 'extra'; const base = redis.pipeline.bind(redis);
  const debits: number[] = []; let reads = 0, bytes = 0, injected = 0, paidBeforeFirst = 0;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === 'HMGET' && String(c[1]).startsWith('nl:data:'))) {
      injected++;
      if (mode === 'extra') return [Array(commands[0].length - 2).fill('1'), 0];
      if (mode === 'unknown') return [null];
    }
    if (commands.some(c => listingKeysRead(c).length > 0) && !reads) paidBeforeFirst = debits.reduce((a, b) => a + b, 0);
    const answer = await base(commands);
    commands.forEach(c => { if (c[0] === 'INCRBY' && String(c[1]).includes(':studio:')) debits.push(Number(c[2])); });
    // Each listing record read, alone or in an MGET (lib/catalog.ts getMany), and the bytes it answered.
    for (const read of listingValues(commands, answer)) { reads++; bytes += Buffer.byteLength(String(read.value)); }
    return answer;
  };
  let listed: Awaited<ReturnType<typeof cartLinkProducts>> = [];
  try { const admitted = await countStudio(shop, null, STUDIO_PAGE_UNITS); if (!admitted.ok) throw Error('fixture studio page refused'); listed = await cartLinkProducts(shop); }
  finally { redis.pipeline = base; }
  console.log('G_WEIGHT_ENVELOPE', JSON.stringify({ mode, injected, reads, bytes, debits, paidBeforeFirst, capacity: paidBeforeFirst * CART_LINK_UNIT_BYTES, listed: listed.length }));
  is('the exact weight boundary was reached', injected, 1);
  is('the builder reads and offers its bounded 24 existing products', [reads, listed.length], [24, 24]);
  if (mode !== 'healthy') is('an unknown outer envelope charges the conservative per-record ceiling', debits.at(-1), cartLinkUnits(24, 24 * MAX_PRODUCT_BYTES));
  is('actual listing bytes fit all admission completed before the first read', bytes <= paidBeforeFirst * CART_LINK_UNIT_BYTES, true);
  done();
}
void main();
