# N independent review: PR 3056

Exact head: af0e7edad89d987e0b90c70069fe64025ba25b3f; stacked base bd5f77a7f3e0efe876b1cf7437428989c41f3303 (#2735). Claim b7301a13/CXN-20261107-1030-C4-1 preceded diff/source/proof edits. All four changed paths and the destination's store selection were read. This is a review/evidence branch, never a product merge source.

## MEDIUM: the new link drops the page's selected store

components/tax-editor.tsx:118 hardcodes /studio/tax. TaxEditor is rendered within StudioStorePin, but pinTo only attaches its header to /api/ requests. It does not rewrite this navigation. StudioTaxPage explicitly accepts searchParams.store and passes it to studioView. Without it, resolveAccess uses the last nl_store preference or first accessible store. Consequently, a user who has store A open and changes the switcher to B in another tab follows A's tax-setting link into B's registrations. This is wrong-store financial information/navigation for the same authorized person, not a demonstrated cross-user authorization bypass or tax mutation.

Permanent regression suggestion: render the real TaxEditor inside the real StudioStorePin and require /studio/tax?store=<page sid> for active, pending and unknown states. Use the existing useStudioHref helper for the new link; keep the no-context and disconnected controls. Five-check independent proof: three failures at the exact head, two controls passing. It executes React renderToStaticMarkup and real Next Link plus the real store context; only next/navigation is the repository's canonical stub. No server route, browser or cookie-switch event was executed. The consequence follows from the destination/resolveAccess code, not an end-to-end browser claim.

## Executed validation

- Same canonical wg15-tax-link test c3fb3d44: original RED source b7d30f49 from 772e36fe yields 4 checks/3 failures; final source 5e57be96 yields 4/4. Only the product source was swapped in the final module graph for RED; it is not a whole historical checkout replay.
- Independent store-pin proof: 5 checks/3 failures (active/pending/unknown); unpinned and disconnected controls pass. Initial createElement children-prop lint error was corrected to JSX without changing any assertion; the final proof was rerun, same result. Lint final exits 0, with the partial-checkout pages-directory notice retained.
- Head manifest hashes verified for 68 repository input/config/context paths: zero mismatches. The initial inherited snapshot had six unrelated imported rule modules from an older baseline; these were replaced with exact head blobs before the qualified final runs. Node/esbuild package dependencies are the already-installed host dependencies, no installation. Missing arguments-length transport was corrected using smaller writes before running final snapshots.
- Every child limited before launch to 120 seconds, 512 MiB heap and 256 KiB output; external fetch blocked before graph evaluation. Pure React rendering: no Redis calls or provider calls. Not a global cost/MR certification.
- No full types, global build, browser, native Redis, CI gates or global accessibility certification performed. Existing canonical tests do not assert that the 44 px class remains, although current code contains min-h-11; no runtime size defect claimed.

## Coordination

Reservation document is among the author's changed paths; N did not change it. Product/reservation consolidation policy remains with the coordinator/V. No author source/ref, main, CI, merge/enqueue, commercial setting, account, supplier credential or personal data was changed. C4-0226 requires literal FILA LIGADA before any eligible author enqueue; incorporation of #3047 alone does not authorize it.
