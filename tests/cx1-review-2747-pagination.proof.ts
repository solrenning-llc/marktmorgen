/** Opt-in document review, not an implementation of the unbuilt feature. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const document = readFileSync('docs/stripe-charge-recovery-study-2026-11-06.md', 'utf8');
const proposal = document.split('**Optional, only if the owner wants a readable state (one read):**')[1]
  ?.split('## Worst-case read cost per plan')[0];
assert.ok(proposal, 'Inspect the actual optional proposal');

test('the proposal explicitly uses one page with limit 100 and filters by store', () => {
  assert.match(proposal, /limit=100/);
  assert.match(proposal, /metadata\.store/);
  assert.match(proposal, /N memberships/);
});

test('one legitimate page cannot establish the proposed per-store total', () => {
  // A pagination counterexample, not a live Stripe response or a product run.
  const subscriptions = Array.from({ length: 101 }, (_, index) => ({
    metadata: { store: index === 100 ? 'target' : 'other' },
    status: 'past_due',
  }));
  const page = { object: 'list', data: subscriptions.slice(0, 100), has_more: true };
  const observed = page.data.filter(row => row.metadata.store === 'target').length;
  const complete = subscriptions.filter(row => row.metadata.store === 'target').length;
  assert.equal(page.has_more, true);
  assert.equal(observed, 0);
  assert.equal(complete, 1);
});

test('the proposal must qualify its count when the single page is incomplete', () => {
  assert.match(proposal,
    /has_more|incomplete|partial|first 100|at least|not checked|more subscriptions|page[^\n]*complete|complete[^\n]*page/i,
    'Document how the one-page read remains unknown or explicitly partial when more rows exist');
});
