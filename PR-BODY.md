## What

A person's erasure (`erasePerson`, lib/person-erasure.ts) took three parts as finished on a reply it could not read (CX-123 rule 24), so it could report everything deleted while the data was still kept:

- `forgetBondPerson` (lib/affiliate-bond.ts): `Number(reply) || 0` on the HDEL of the buyer's affiliate bond.
- `forgetImportedPerson` (lib/imported-purchases.ts): the same on the DEL and HDEL of the purchases brought over from another platform.
- `forgetLeadPerson` (lib/affiliate-leads.ts): the reply of the HSET that takes the address off the affiliate lead was never read.

Each now reads its replies exactly (`repliesFor`, `countOf`) and throws `UnknownReplyError` on anything else. `erasePerson` already records a part that throws as not finished and answers "incomplete", so the person or the team deletes again. No other behavior changes.

Fixes #4582

## Tests

- `tests/erasure-bond-imported-exact.test.ts` (new): a reply cut short or in another shape is unknown for each function, and an exact reply still counts. RED on main (4 of the first 6 checks; the lead part fails without its fix), GREEN 9/9.
- `npx next typegen` and `npx tsc --noEmit`: clean.
- 85 test files green: person-erasure*, person-data*, erasure*, affiliate*, imported*, imports*, paypal-delivery*, plan-cost-registry.

## Acessibilidade

No screen, text, email, PDF, form or public API changes: only the server-side reading of three Redis replies during an erasure. No WCAG criterion applies to this diff; nothing was checked with assistive technology. Steps and decisions for the creator's task: 0 → 0 (a deletion that cannot be confirmed already asks to delete again, as before).

## Rules

No price, limit, commission, flag, gate or Stripe change. Synthetic tests only.
