# Sitemap catalogue reply evidence

Source: main `ffb354bc30a15d05030998d363c53a642570d8bb`, November 6, 2026.
Evidence only. No production source, global test alias, paid service or other agent's branch changed.

## Finding

Proposed LOW SEO/truthfulness issue; final classification and product ownership belong to Claude 4.
`lib/catalog.ts:649–654` flattens GET replies without checking their cardinality.
`readListings` at lines 682–699 silently drops unread records. The actual consumer
`lib/store-sitemap.ts:94` accepts that result and `sitemapXml` serializes an apparently
ordinary map without indicating that the catalogue read was unknown.

Two products are created with the real store writer and serialized with the real
`productWrites`. The same published catalogue is read with no carried cards, so both
listing GETs are exercised. Only that one two-command response is replaced:

| Injected response | Observed product URLs | XML envelope | Expected boundary |
| --- | ---: | --- | --- |
| No reply slots | 0 | Ordinary XML | Unknown; do not certify the map |
| Only the first reply | 1 | Ordinary XML | Unknown; do not certify the map |
| Both replies plus an extra slot | 2 | Ordinary XML | Unknown; wrong envelope |
| First valid record and malformed JSON | 1 | Ordinary XML | Unknown; unread record |

The opt-in proof has seven tests: four causal failures and three passing controls.
Healthy replies retain both products; an explicit null GET result remains distinct
from a missing slot; a thrown transport error already prevents a successful map.
There is no failing comparison of a real absent product with an unread product.

## Reproduction and scope

Run `node proofs/t/sitemap-listing-unknown.mjs` from the evidence checkout. A different
source checkout may be supplied as its first argument. The runner compiles the same
proof against that source's canonical test aliases and local fixtures, without
modifying the selected source checkout. A nonzero exit is the expected RED result.

The actual store writer, catalogue serializer/reader, sitemap function and XML
serializer run against existing MemoryRedis. Reply injection is explicitly synthetic.
The public GET route, paid admission, HTTP status/cache, native Redis, a crawler,
production deployment and measurable search-ranking impact were not exercised or
certified. No privacy or monetary impact is asserted. Existing infrastructure costs
remain unknown rather than zero; this evidence introduces no production IO.

Linked baseline: store-sitemap 8, catalog-reads 9, catalog-read-count 22 and
catalog-ceiling 5: 44 passing controls. Scoped strict TypeScript uses the actual
proof root and imports, with zero diagnostics. Targeted ESLint and the diff check
pass; the public-data scanner checks 4,027 tracked files with zero findings.
An initial unpublished draft used undefined instead of the existing nullable inline
catalogue field and an incorrect assert.rejects overload. Both fixture/type mistakes
were corrected without changing the four rejection requirements or production code.

The same unchecked getMany output also reaches readProducts (lib/catalog.ts:715–732).
That is a static sibling candidate, not another proven customer impact or severity.
The broader catalogue readers also serve non-SEO callers. This proof does not assign
those callers a severity or authorize a shared-catalogue fix. `lib/catalog.ts` is
already involved in Claude 3's open #1928; no corrective source edit is made here.
Any repair needs a coordinated owner, a durable RED/GREEN and the ordinary review/CI
gates, while preserving confirmed null absence and existing read bounds.
