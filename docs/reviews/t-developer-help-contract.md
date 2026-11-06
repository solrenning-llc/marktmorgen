# Developer help contract audit — Codex T / G6

## Scope and evidence state

Source revision: `5c07315505e1d53ee6401021601cd688fa98ecda` (frozen main). Reservation receipt: `6ed6b8cb6fd6a30574e230adf14a4f1b826f6648`.

This is a narrow acquisition/help truthfulness inventory of `app/developers/page.tsx` and the API paragraph in `lib/help-content.ts:800`. It follows the actual handlers, serializers and healthy writer-to-reader paths below. It does not replace the concurrent API security/read-decision audit, certify deployment, or establish financial admission. No production source, API gate, permission, price, allowance, provider setting or occupied file was changed.

**No causal contradiction was established in this unit.** Source classifications below are separate from the healthy helper-level executions now recorded. `node scripts/t-developer-help-contract.mjs` passed four cases through real product/contact writers, serialization, readers and JSON projection using bounded in-memory Redis. No browser, authenticated route, external Redis, HTTP or provider call was executed. This is passing proof of existing behavior, not an artificial RED or a claim of regression prevention.

## Healthy writer-to-reader paths

These are concrete paths through production functions, rather than mock implementations. The execution below covers two narrower writer/reader paths; the complete API admission paths described here remain unexecuted.

- **Products:** `lib/store.ts:3036` (`addProduct`) validates the creator's fields, creates `priceCents`, `recurring` and `hidden` (`3062`, `3088`), and hands the product to `save` (`3096`, `3105`). `lib/catalog.ts:1029` (`productWrites`) serializes `listingOf(product)` into the product listing record. `productIds` (`558`) retains index order; `readListings` (`682`) reads inline/head/persisted listings in the requested order. `lib/api-read.ts:88` (`products`) slices the index, reads that slice and explicitly builds the documented fields. `app/api/v1/products/route.ts:7` returns that reader through `apiOkFields` after admission and field validation. This trace includes the draft writer and reader, rather than assuming public-store visibility filtering applies to the API.
- **Leads:** `lib/api-write.ts:98` (`addLead`) requires explicit `agreed: true` (`101`) and calls `importContactRows` (`117`). `lib/contacts.ts:421` (`decideContact`) refuses a previously unsubscribed/suppressed address (`428`); a new agreed contact receives the stored consent/time/name/tag fields (`460`). `importContactRows` (`535`) serializes that decision and writes it through `casWrite` (`559`, `571`). `parseContact` (`155`) reads the stored representation. `lib/api-read.ts:191` (`scanLeads`) maps it to the public names, applies the agreed/not-unsubscribed predicate and carries the scan cursor. `app/api/v1/leads/route.ts:11` returns the charged reader via `apiOkFields`. This is a trace of the healthy row path, not a certification of its unknown-read or acknowledgement handling.
- **Students:** `lib/learn.ts:422` (`touchStudent`) writes normalized email plus whole-second start/last-seen values (`427`, `434`, `437`). `studentPage` (`605`) reads the student hash, total count, completed lesson sets and block state, then maps stored seconds and progress (`651`). `lib/api-read.ts:260` (`students`) reads the course, calculates its current lesson count and serializes those student values (`279`). `app/api/v1/students/route.ts:10` returns the page or the documented course/error statuses. This trace does not grant course access or certify all course records.

## Promise matrix

“Supported” means the inspected healthy production path expresses the promise. “Conditional” identifies a prerequisite or qualification in that path. Execution is stated explicitly where performed; neither label alone means a runtime test or live deployment was verified.

| # | Concrete public promise | Actual implementation evidence | Classification |
|---|---|---|---|
| 1 | API answers are JSON. Developers `117`. | `lib/api-guard.ts:37` and `41` use `Response.json`; inspected list handlers return these helpers or reader refusals. | Supported. Executed JSON responses for healthy product/lead projections; framework-level failures and authenticated routes untested. |
| 2 | Store returns `handle`, `name`, `currency`. Developers `177`. | `lib/api-read.ts:79` explicitly constructs these three fields; `app/api/v1/store/route.ts` wraps it with `apiOkFields`. | Supported after admission; persisted store loading untested. |
| 3 | Products include drafts and retain the store's order. Developers `185`. | Healthy product path above; `productIds` maps all index items, unlike `visibleIds`, which filters drafts (`lib/catalog.ts:558`, `566`). | Supported; executed with persisted draft/public fixtures in explicit index order. Missing/unreadable records are outside this healthy-path finding. |
| 4 | Products never exceed the stated page size and return `next`. Developers `120`. | `lib/api-read.ts:92` slices `from` through `from + API_PAGE`; `108` derives `next` from the index length. | Supported by source. Executed a two-product terminal page only; maximum-size/nonterminal pagination and concurrent edits remain untested. |
| 5 | Product kind is `one_time`, `free`, `membership`, `course` or `call`; membership interval is set. Developers `203`. | `lib/api-read.ts:103` selects those exact kinds and `104` takes `recurring.interval`, otherwise null. | Supported by source. Executed free products with null interval; other kinds remain untested. |
| 6 | Lead rows expose the documented consent, time, product, tag and source fields. Developers `217`. | Lead writer/reader path above; `lib/api-read.ts:205` constructs every outgoing field explicitly, matching `LEAD_FIELDS` (`61`). | Supported. Executed `upsertContact` serialization through `chargedLeads`, exact outgoing field set, consent/product values and UTC dates. API `addLead` admission and equality with the entire CSV export remain unproven. |
| 7 | `?agreed=true` returns contacts who agreed and have not unsubscribed. Developers `213`. | `app/api/v1/leads/route.ts:20` recognizes the literal parameter; `lib/api-read.ts:202` uses `c.agreed && !c.unsub` before adding a row. | Supported. Executed helper filtering with agreed/non-agreed writer controls; unsubscribed records and route parameter parsing remain source-only. No external consent verification claimed. |
| 8 | Field projection selects row fields while preserving root paging fields. Developers `123`. | `lib/api-fields.ts:40` maps only `data` and spreads the surrounding body; `apiOkFields` (`59`) returns the projected body. | Supported; executed product `id,hidden` and lead `email,agreed` projections, preserving `next: null`. Nonterminal and other endpoints remain untested. |
| 9 | Unknown requested fields get `400 unknown_field` before list data is read. Developers `125`. | `badFields` uses the route's fixed known-field list (`lib/api-fields.ts:55`); products/leads/students call it before their reader. | Conditional: this is after `apiStore` admission, not before authentication/store resolution. |
| 10 | Malformed field names or too many names get `400 fields`. Developers `126`. | `fieldsAsked` enforces the grammar and deduplicated name count (`lib/api-fields.ts:20`); `badFields` produces the error (`53`). | Supported; whitespace is trimmed and duplicate names count once. |
| 11 | Members return `404 no_community` when the store has none. Developers `240`. | `app/api/v1/members/route.ts:9` checks `store.community` before the member reader. | Conditional on successful API admission; earlier admission errors remain possible. |
| 12 | Students are paged with total count and progress, without a fixed recent-500 selection. Developers `262`. | Student writer/reader path above; `studentPage` uses `HSCAN`/`HLEN` (`lib/learn.ts:612`), and the API carries `total`, rows and `next` (`lib/api-read.ts:279`). | Supported for a stable readable course; documented mutation/duplicate-row caveat remains necessary. |
| 13 | Bookings reflect the current time after a buyer moves one. Developers `504`. | `lib/api-read.ts:360` uses `paidCalls`; `lib/calls.ts:259` uses `readCallSessions`; its move overlay selects `move.s`, `move.e`, `move.n` (`353`). | Supported by the read trace; booking move persistence and provider history were not executed. |
| 14 | A sale without a readable currency gets `502 unavailable`, not guessed USD. Developers `648`. | `lib/api-sales.ts:183` accepts only the explicit three-letter currency; `sales` rejects an unreadable sale (`245`); `app/api/v1/sales/route.ts:33` maps null to `502`. | Conditional on reaching the selling/admitted sales path; provider transport untested. |
| 15 | A malformed or duplicate sales cursor gets `400 invalid_cursor`. Developers `689`. | `lib/api-sales.ts:91` uses `getAll` and accepts exactly one shaped cursor; `app/api/v1/sales/route.ts:18` maps failure to `badCursor`. Provider `resource_missing` is also mapped (`38`). | Supported for malformed/duplicate query parameters. Repeating a previously used cursor in a separate request is not shown to be rejected; the wording is not classified as a defect without a causal proof and interpretation review. |

The help paragraph at `lib/help-content.ts:800` directs readers to these developer endpoints and describes read/write keys. This audit traces only the listed data/response contracts; key ownership, role checks, revocation and write-authority security remain outside G6 to avoid duplicating the concurrent audit.

## Coordination and unresolved evidence

A candidate at `lib/api-read.ts:195` converts an absent/malformed lead scan result into an empty terminal page, which may conflict with the public unavailable-read answer (`app/developers/page.tsx:157`). It is **unproven in this unit**: no synthetic route experiment was executed, no new defect severity is assigned, and no correction is proposed. C2 currently reserves the remaining API surface, including v1. The candidate was sent to the coordinating agent and its execution is held pending explicit non-duplication clearance.

C2's cited prior evidence is `codex/c-api-read-decision-proof` at `2f6723510f6bea94d0b9288480db91de18dc3f01`. That object is absent from this local clone (`git show --stat` returned `bad object`), so its exact covered source paths were not independently inspected here. No foreign ref was changed or fetched, and absence of the local object is not evidence that C2's proof is absent or incomplete.

Excluded: the already reported help-content example/refund issue at lines 331–334; public API authentication/security audit; financial certification; real data, provider contacts and new commercial promises. There is no invented RED for this documentation-only result.

## Executed proof, validation and limits

Run from the repository root:

```sh
node scripts/t-developer-help-contract.mjs
```

The script installs a fetch/socket/HTTP deny boundary before initializing the production graph. Its only substituted production dependency is Redis transport, backed by the existing `MemoryRedis` implementation. Every synthetic pipeline command, including setup, is counted before execution. The reserved ceiling is 5,000 synthetic commands total, at most 12 cases, 120 seconds and 128 KiB of output, with zero external HTTP/provider calls. No unknown-read/fault/security case is included.

Four cases passed:

1. `productWrites` creates real serialized listing commands; those are persisted in memory and read by real `readListings` and `products`. The assertion checks indexed order, the draft bit and the complete documented API field set.
2. Real `apiOkFields` returns projected product rows with a preserved terminal cursor.
3. Real `upsertContact` writes two contacts with opposite consent values; real `parseContact` and `chargedLeads` recover the documented row shape, normalized address, product reference and UTC dates.
4. Real lead filtering and `apiOkFields` return only the agreed contact, selected fields and a terminal cursor.

Execution accounting: final run **4/4 cases, 22 synthetic commands, zero network attempts, zero external HTTP and zero provider calls**. A repeat after an explicit TypeScript annotation correction also passed; the two executions together consumed **44 commands and eight case executions**, within the pre-reserved total. No production result was altered. No RED was claimed.

Boundaries: products use the real command-building writer, not authenticated `addProduct`; contacts use the existing `room: null` company-list writer mode to isolate serialized data, not API `addLead` financial/data-room admission. Reader reservation callbacks are synthetic acceptors and do not certify funding or change any gate. The student path, authenticated routes, full-page cursor progression, every product kind, unsubscribe lifecycle, external services and deployment remain unexecuted.

The proof's scoped TypeScript check and ESLint cover the new proof; `node --check` covers the runner. Whitespace/public-data validation is recorded with the final handoff. No browser testing, human accessibility testing, production error-log inspection or publication verification was performed.

Accessibility: documentation only, with descriptive headings and a numbered promise table; no customer UI steps or decisions changed. Rendering and assistive-technology checks were not performed. This report does not establish WCAG conformity.
