# The 23 open Blob sites: what triggers them, what bounds them, what they cost

Claude 5, 6 November 2026. Analysis only: no product code, price, visible limit, commission, flag or gate changes.
Base: `BLOB_SITES` in `tests/blob-sites.test.ts` (#2837, `claude5/blob-sites-guard`, stacked on #2803 + #2801),
23 entries marked `open`. Costs are computed on the current stack #2803 + #2801 + #2843 + #2848 + #2852
(`claude5/blob-list-cost` merged with `claude5/blob-doors-b` in a scratch worktree; the two merge cleanly in
`tests/plan-cost-registry.ts`, only the generated docs conflict).

Rules applied (MR): every operation at its dearest, unknown never zero, a ceiling before the spend. Prices from
`tests/plan-cost-registry.ts`: Advanced Operation `BLOB_ADVANCED_OP` = US$ 5e-6, Simple Operation `BLOB_SIMPLE_OP` =
US$ 0.4e-6, transfer `BLOB_TRANSFER_PER_BYTE` = US$ 0.1e-9, 11 tries (`BLOB_PUT_TRIES`, `BLOB_HEAD_TRIES`,
`BLOB_TOKEN_TRIES`) on every request that goes through the SDK's retrying `requestApi`; a `get` is one plain fetch,
its bytes counted whole (the registry's convention: a cancelled stream is not proof of fewer bytes billed).

Pending decisions with Claude 4 that this document references and does not redo:

- **(c)** the review photo's cost cap: weight 2 on the public figure versus a monthly counter;
- **(d)** the storage of `images/` (line at US$ 67.02 for the refunded first year, above 66);
- **gap 4**: public picture reads (`app/api/image`) and link-preview reads (Open Graph) have no store figure;
- **gap 6**: legacy sold files in Blob, `FILE_DELIVERY_PER_GB = 0` prices only R2 delivery.

## 1. Method for the refunded first year

The same sum as `tests/plan-margin.test.ts`, test "the one exposure is the first payment refunded in full":

    year = worstCost("creator") + providerFeeUsd(PRICES_WITHOUT_COMMISSION.creator.year) + keptToClosing("creator")

computed by a probe compiled with the repository's own test aliases (`tests/test-config.mjs`), kept in the
scratchpad, not in the repository. A candidate line adds its Creator `monthlyUsd` to `worstCost`.

| Base | worstCost (Creator) | Refunded first year | Room below US$ 66 |
| --- | ---: | ---: | ---: |
| #2803 + #2801 (#2837's base) | 7.3313 | 65.6432 | 0.3568 |
| Current stack (+ #2843 + #2848 + #2852) | 7.3832 | **65.6951** | **0.3049** |

The room on the stack is US$ 0.3049 a month of new cost, about 5,544 Advanced Operations with their 11 tries.

## 2. Eleven of the 23 are priced by the stack, a twelfth in part

#2837 was written on #2803 + #2801. On the stack, these entries should move from `open` to `line` when the
branches land together (the guard's count of 23 then drops to 12, the list staying open for `dropStamped`):

| # | Site and operation | Audit | Priced by |
| --- | --- | --- | --- |
| 1-2 | `lib/picture-check.ts` head, get | 1 | `studio-blob` (#2843), each picture checked once per save |
| 3 | `app/api/store/image/upload/route.ts` issueSignedToken | 9 | `studio-blob` (#2843, `STUDIO_DOOR_BLOB`) |
| 4 | `app/api/store/community/upload/route.ts` issueSignedToken | 9 | `buyer-blob` (#2852); the owner's door inside `studio-blob` |
| 5 | `app/api/store/course/task/upload/route.ts` issueSignedToken | 9 | `buyer-blob` (#2852) |
| 6 | `components/community-composer.tsx` uploadPresigned | 7 | `buyer-blob` (#2852) |
| 7-8 | `lib/community-files.ts` head, get | 7 | `buyer-blob` (#2852, `checkCommunityImage`) |
| 9 | `components/lesson-task.tsx` uploadPresigned | 7 | `buyer-blob` (#2852) |
| 10 | `lib/mail-pictures.ts` put | 8 | `mail-picture-blob` (#2852) |
| 11 | `lib/file-store.ts` head | 6 | `buyer-blob` (#2852): `headFile`'s only caller is the hand-in route |
| 12 | `lib/file-store.ts` list | 5 | `blob-list` (#2848) for `filesHeld`; **`listFiles` in `dropStamped` stays open** (no page cap) |

Row 12 is half closed: the storage measure is priced, the legacy stamped-copy listing is not (see 3.6).

## 3. The 12 that stay open on the stack (11 entries and the rest of the list)

Per-request costs (US$): review photo put 11 x 5e-6 = **5.50e-5**; picture read of 1 MB = **1.004e-4**; legacy
PDF read of 50 MiB (`MAX_STAMP_BYTES`) = **5.243e-3**; legacy read through a function of 20 MiB
(`REDIRECT_ABOVE_BYTES`) = **2.098e-3**; legacy signed token = **5.50e-5**. The studio line's dearest request today
(`studioBlobPerRequest()`) is **3.232e-4**: one full picture check (1.048e-4) on top of the dearest kind (2.184e-4,
a product picture reattached with its three copies checked).

### 3.1 `lib/review-photo.ts` put (audit 2)

- **Trigger:** a buyer with a paid order of the store posts a review with a photo (`app/api/store/review`, plain
  form). Every save that carries a photo puts a new one (`allowOverwrite: false`), the old one deleted (free).
- **Bound today:** per connection 20 an hour, per order 10 an hour, and one of the store's **public requests**
  (`withinStore` → `takePublicRequest(store, "public")`), at most `publicVisitLimit(3 x visits + extra)` a month:
  10,165 / 30,400 / 118,750 (Creator / Pro / Scale). `costsPaused` refuses the photo while a renewal is unpaid.
  So it is bounded, but only by a figure that no Blob line reads.
- **Worst month:** every public request a review with a photo.

| Option | Creator | Pro | Scale | Refunded year (Creator) |
| --- | ---: | ---: | ---: | ---: |
| Its own line on the public figure, as coded | 0.5591 | 1.6720 | 6.5313 | **66.2542, fails** |
| Weight 2 on the public figure (decision c) | 0.2795 | 0.8360 | 3.2656 | 65.9746 |
| Taken from the buyer figure (`takeBuyerAction`) | 0 | 0 | 0 | 65.6951 |

Folding into the buyer figure adds nothing because `buyerBlobPerAction()` is 1.10e-4, already above a review put
(5.50e-5): each buyer action is priced at the dearest Blob work one may be. It also bounds the photo's storage growth
to 200 / 1,000 / 3,000 photos of at most 400 KB a month, which matters for decision (d). Its cost is a product
one: past the buyer figure, the words are saved and the photo is refused, as with `photoPaused` today. A monthly
counter of its own also works; it must stay under 5,544 a month on Creator with nothing else added. The choice is
decision (c).

### 3.2 `app/api/store/ai/route.ts` get, the alt text (audit 10)

- **Trigger:** the studio asks for a picture's alt text (`kind: "alt"`). `guardStoreWrite` → `studioAccess` takes one
  studio request first; the picture is any file in the store's own `images/` folder (`ownsImagePath`), at most 1 MB.
- **Bound today:** the studio figure (2,000 / 5,000 / 15,000) and `AI_PER_MINUTE`. The read happens **before** the
  AI budget is checked, so it happens even on Creator, whose `AI_MONTHLY` is 0.
- **Worst month:** 1.004e-4 a request, below the studio line's dearest kind (2.184e-4).
- **Recommendation: fold into `studio-blob`.** Adds US$ 0 on every plan; name the route in the line's sources and
  move the entry to `{ line: "studio-blob" }`. Better still, check the AI budget before the read (3.3).

### 3.3 `lib/file-store.ts` get, put, issueSignedToken; `lib/serve-file.ts` get; `app/api/store/file/download/route.ts` get (audit 6, legacy files)

Five entries, one cause: a product file kept on a Blob path from before the vault (R2). New files cannot be put
there in production (`app/api/store/file/route.ts` throws `files_unavailable`), and every copy made from a file
(stamped copy, preview) follows its original's store (`copyFolder`). So only a store that holds a pre-vault file
reaches them. Whether any production store does is **not measured**: unknown, so counted.

| Trigger (who, request) | Blob work per request | Bounded by |
| --- | --- | --- |
| Buyer's first download of a stamped PDF/EPUB (`stampedCopy`) | read original 50 MiB, put copy, token if > 20 MiB: 5.353e-3 | buyer side of the public figure, 10,700 / 32,000 / 125,000 |
| Visitor opens a PDF preview (`previewCopy`) | read 50 MiB, put: 5.298e-3 | public figure; once per file and page count, kept 400 days |
| Buyer download, lesson video, podcast episode (`serveFile`, `signedMedia`) | get of up to 20 MiB through the function, or a signed token (5.5e-5) and the bytes from Blob | public figure, buyer side (`takeBuyerRead`) |
| Creator's own download in the studio (`/api/store/file/download`) | the same | studio figure |
| AI page from the product's PDF (`kind: "page"`, `readFile`) | read 50 MiB: 5.243e-3, before the AI budget | studio figure |

Priced at the dearest kind per figure (the method of `studio-blob` and `buyer-blob`), **operations and server-side
reads only**, delivery bytes excluded (gap 6):

| Figure | Creator | Pro | Scale | Refunded year (Creator) |
| --- | ---: | ---: | ---: | ---: |
| Public figure, dearest kind (stamped copy) | 57.2801 | 171.3050 | 669.1600 | 122.9752 |
| Studio figure, AI PDF read as a `studio-blob` kind | 10.0498 | 25.1244 | 75.3732 | 75.7448 |
| (for scale) signed tokens alone, public figure | 0.5885 | 1.7600 | 6.8750 | 66.2836 |

The delivery bytes (up to `MAX_FILE_BYTES`, 5 GiB, per signed download from Blob) are gap 6 and not added here.

**Recommendation: close, do not price.** No Creator line can carry this under US$ 66. Either (i) a dated
inventory proving no production store holds a non-vault file path, kept as a test fixture, and then
`notInProduction` entries; or (ii) code that refuses or migrates a legacy path at each door (`readFileWhole`,
`writeFileWhole`, `fileUrl` answering only for `isVaultPath`, after a one-time copy to R2). Independently, the AI
route should check the AI budget before any read: `AI_MONTHLY.creator` is 0, so Creator's cost becomes 0, and Pro and
Scale are bounded by 40 and 80 jobs (US$ 0.21 and 0.42 a month at 5.243e-3) instead of their studio figures.

### 3.4 `app/api/image/[folder]/[file]/route.ts` get and `app/[handle]/p/[product]/opengraph-image.tsx` get (audit 4)

- **Trigger:** any visitor or crawler on a CDN miss: a first visitor in a region, a link preview of a product.
- **Bound today:** the picture route is paced in each server's memory only (`lib/picture-pace.ts`: 120 a minute per
  connection, 30 reads a minute per file, per server); the link preview has no pace of its own. No store figure.
- **Worst month:** no finite figure per plan. Per file and per server instance the pace allows 30 x 60 x 24 x 31 =
  1,339,200 reads a month (US$ 134 of 1 MB reads), multiplied by servers and files.
- This is **gap 4**: no line can be priced until a store figure (or a counted reservation) is taken before the read.

### 3.5 `lib/picture-r2-copy.ts` get (audit 10)

- **Trigger:** a product picture attached in the studio, when the pictures' R2 bucket is on.
- **Bound today:** off in code: `PICTURE_R2_CEILING` is the constant `null` in `lib/picture-r2.ts`, so
  `pictureR2Config()` answers null and nothing is read. On, it would be the studio figure.
- **Worst month when on:** two whole reads of 1 MB on top of the attach kind: the studio line's dearest request rises
  from 3.232e-4 to 5.240e-4, **+0.4016 / +1.0040 / +3.0120** a month, refunded year **66.0967, fails**.
- **Recommendation:** today, `notInProduction` (the guard checks the closing code in the site's own file, so the
  entry needs the guard to accept the closing file `lib/picture-r2.ts`, or the copy to name the constant). Before it
  turns on, read each picture once whole and check its first bytes from those same bytes: the attach then reads no
  more than the line already counts, and the copy adds US$ 0.

### 3.6 `lib/file-store.ts` list in `dropStamped` (rest of audit 5)

- **Trigger:** a stampable product file replaced or deleted in the studio; lists every stamped copy of it.
- **Bound today:** none on pages (`listFiles` loops while `hasMore`); copies are one per sale over the file's whole
  life, so the count grows without a monthly bound. Each page of 1,000 is 11 Advanced Operations (5.5e-5).
- Legacy only (a vault path lists R2). Close with 3.3; otherwise a page cap with the remainder left to the closing job.

### 3.7 `lib/demo-seed.ts` put (audit 10)

- **Trigger:** `/demo` visits and the daily `/api/cron/plans` job, when the seed's fingerprint changed or an item is
  pending; under a lock, retried at most every `RETRY_SECONDS` (10 minutes).
- **Bound today:** time only: at most 4,464 runs a month, each at most 13 puts (3 option files, 2 product pictures,
  2 extras x 3, 2 call pictures; puts are content-addressed and skipped once recorded).
- **Worst month:** 4,464 x 13 x 5.5e-5 = **US$ 3.19**, a company cost, not a plan's.
- **Recommendation:** a fixed-cost line (FX275, minimum base), not in Creator's year; or cap retries a day.

## 4. Summary per site (US$ a month)

| Site (audit) | Bound today | Creator | Pro | Scale | Recommendation |
| --- | --- | ---: | ---: | ---: | --- |
| Review photo put (2) | public figure, no Blob line | 0.5591 | 1.6720 | 6.5313 | fold into buyer figure (0), or weight 2 (0.2795): decision (c) |
| AI alt read (10) | studio figure | 0 folded | 0 | 0 | fold into `studio-blob` |
| Legacy files, 5 entries (6) | public and studio figures; bytes unbounded | 57.2801 + 10.0498 | 171.3050 + 25.1244 | 669.1600 + 75.3732 | close (inventory or refuse/migrate); gap 6 |
| Public picture and link preview reads (4) | per-server pace only | unbounded | unbounded | unbounded | gap 4: store figure first |
| R2 copy read (10) | off in code | 0 off, 0.4016 on | 1.0040 on | 3.0120 on | `notInProduction`; one whole read before turning on |
| `dropStamped` list (5) | none | unbounded | unbounded | unbounded | close with legacy, or page cap |
| Demo seed put (10) | 10-minute retry | 3.19 company | | | fixed costs |

## 5. Refunded first year on Creator (owner's ceiling: below US$ 66)

Stack today: **US$ 65.6951**.

(a) Each line alone on the stack:

| Line alone | Year |
| --- | ---: |
| Review photo, own line on the public figure | 66.2542 (fails) |
| Review photo, weight 2 | 65.9746 |
| Review photo, inside the buyer figure | 65.6951 |
| AI alt read, folded into `studio-blob` | 65.6951 |
| AI PDF read on legacy files, as a studio kind | 75.7448 (fails) |
| Legacy files, public figure | 122.9752 (fails) |
| R2 copy when on, as coded | 66.0967 (fails) |
| Public picture / link preview, `dropStamped` list | no finite figure (fails until bounded) |

(b) All together on the stack:

| Scenario | Year |
| --- | ---: |
| Everything as coded (bounded parts only; gaps 4, 6 and `dropStamped` unbounded on top) | **133.0249**, fails |
| Legacy closed, review as its own line, alt folded, R2 off | 66.2542, fails |
| Legacy closed, review weight 2, alt folded, R2 off | 65.9746 |
| Legacy closed, review in the buyer figure, alt folded, R2 off | **65.6951** |

So the only path under 66 needs all three: legacy closed by proof or code (3.3), the review photo inside an
existing figure or at weight 2 (decision c), and gap 4 bounded by a store figure taken before the read. Decision
(d), the `images/` storage at 67.02, is separate and still above the ceiling on its own; the buyer-figure option for
the review photo is the one that also bounds what (d) has to store.

Not verified: whether any production store holds a legacy Blob file; the real number of servers behind the picture
pace; whether Vercel bills a cancelled stream for fewer bytes (counted whole here). Nothing here is priced in code yet.
