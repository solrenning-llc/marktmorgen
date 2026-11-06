# Custom pages: unknown reads become known absence

Evidence only, November 6, 2026. Codex T; coordination reservation 0041219d23419d7ee70b1761fb242f6d3233b521, before writing this proof.

Frozen main parent: `5d2c7bdc6f6ff1d33af3e9e70c292a47e0bea95e`. No product source, author branch, reservation document or global test alias changes. `lib/sales-page-store.ts` is shared with Claude 3's open #1947; the custom-page source is reserved by Codex U for the separate metadata-language finding. Classification and the correction's ownership must be coordinated before product edits.

## Reproduction

Run `node proofs/t/own-page-unknown.mjs [source-checkout]` with repository dependencies installed. This is an intentionally failing, opt-in proof, not a product PR.

The actual store writers claim a fictional store, record one published custom page and save two block pages with the actual `writePage` writer and its existing data-room admission. The healthy control reads the saved blocks through `readPage` and `readPages`, then calls the actual custom-page `generateMetadata` and checks its title/canonical.

Only responses to the intended page GET/MGET are changed after the actual MemoryRedis command executes. Each adverse case verifies exactly one intercepted application reader call. The original two stored page records are compared before/after and remain identical. Observer reads are fixture inspection, not additional application IO or a cost measurement.

The canonical runner uses the repository's normal aliases, one Redis fixture and actual store/page modules. Only Next's request and navigation boundaries are synthetic: the existing request-context fixture and a named `SYNTHETIC_NOT_FOUND` throw. This executes the actual page/metadata functions outside Next; it does not prove an HTTP status, browser hydration or a search engine's response.

## Result on frozen main

**19 tests: 15 causal failures, 4 passing controls; zero skips.**

| Boundary | Adverse inputs | Observed behavior |
| --- | --- | --- |
| `readPage`, sales-page-store.ts:145–158 | Missing envelope, false GET value, malformed JSON | Ordinary empty page returned; saved blocks still exist |
| Same reader | Extra outer slot | Healthy page returned despite an invalid envelope; this is envelope acceptance, not empty-page loss |
| `readPages` / `readMany`, :160–175 | Missing envelope, null MGET list, malformed first JSON, one of two MGET slots omitted | Complete two-page array returned with one or both pages invented empty |
| Same batch reader | Extra outer slot | Both healthy pages returned despite an invalid envelope; this is not data loss |
| Actual custom-page metadata, app/[handle]/[slug]/page.tsx:50–58 | Missing GET envelope, malformed JSON, thrown transport error | Title becomes `Not found — Marktmorgen` |
| Actual custom-page function, :74–78 | Same three inputs | Invokes `notFound` despite the published saved page |

Thirteen failures establish false empty pages/false absence at these boundaries. Two failures establish extra-envelope acceptance only. The page consumer's catch also masks a correctly thrown transport error, so stricter reader validation alone cannot close the consumer behavior.

Passing controls: (1) healthy writer/readers/metadata; (2) confirmed GET null and exact MGET null slots retain legitimate empty pages; (3) confirmed absent custom page still follows not-found; (4) direct readPage transport errors already propagate. The proof deliberately preserves these distinctions and does not demand that confirmed absence become an error.

## Assessment and limits

Proposed MEDIUM for SEO/truthfulness: a transient unknown read certifies that an existing published custom page does not exist. Claude 4 owns the final classification and assignment. No regression caused by #1947, privacy leak, monetary loss, irreversible deletion, crawler deindexing, HTTP 404/cache behavior or whole-export corruption is asserted. The readPages behavior is independently demonstrated at its direct boundary; a storeExport journey was not executed here.

Related code was checked without edits: the public consumer swallows reader errors; readMany substitutes missing slots with null before pageOf; the already stricter `readPageExact` is a distinct API. Existing blog count/index cases remain with C2/#2695, catalogue/sitemap proof 77b8d7c waits for #1928, and Codex U's custom-page language finding remains separate.

Linked canonical suites: sales-pictures 30, site-pages 12, page-variant 29 and store-copy 32, **103 passing checks**. Scoped strict TypeScript for the proof and actual imports: zero diagnostics. Directed ESLint for the two new code files and diff-check pass. Public-data scanner: 4071 tracked files, zero requiring correction. No new application IO, key, service, registry row, price, limit, commission, flag or gate. Unknown real infrastructure cost remains unknown.

No native Redis, real supplier, Next HTTP server, browser, real-user keyboard/screen reader, global build/AAA or margin certification was run. Product sources remain byte-identical to the frozen parent.
