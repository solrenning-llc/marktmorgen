# Creator-supplied course import — 260 [KJ5], units 1 to 4

Status: tested in branches, not merged or published. Units 2 to 4 (Claude 4,
11 November 2026) add the save path for a creator's own outline: applying it
to a new course (`lib/course-import-apply.ts`), writing its lesson texts at
once (`saveNewBodies` in `lib/course.ts`), the route
`app/api/store/course/import` and the studio box
(`components/course-import-box.tsx`). Still missing: uploading the outline's
videos and files (they are listed for the creator to upload through the
existing uploads), any vendor export adapter and a published migration flow.
Item 120 [F2-IMPORTS] still needs real, non-personal export evidence.

## Saving an outline (units 2 to 4)

- **Only a new course.** The outline is applied through the course's own
  edits, as the ready structures are, and only to a course exactly as it is
  made (`templateFits`); a course the creator touched is refused (`not_new`).
- **Nothing changed silently.** Where the editor's own cleaning would keep
  a title or text differently (extra spaces, line ends), the place is listed
  in the preview before anything is saved.
- **Preview, then confirm.** The route checks the outline on the server for
  both; a preview writes nothing, and saving needs `confirm: true`, sent only
  by the box's Import button.
- **Paid before the work.** The outline's size takes one studio request for
  each 50,000 characters past the first before it is read; saving takes one
  more for each lesson (its text, one write) and one for the outline, before
  anything is written (`importUnits`, on the studio line of
  `tests/plan-cost-registry.ts`). The route reads at most 4,000,000 bytes.
- **Whole or nothing.** Under the course's lock, the texts are written
  first, their room taken in one step and each only where no text is kept
  yet; then the outline in one write. If that write fails, the texts are
  taken back. A full store gets nothing written.
- **Media.** Videos and files are never fetched or uploaded here: after the
  import the box lists them by lesson. Their storage and video-hour rights
  are checked by the existing uploads, as for any lesson.

## Official export evidence

Read November 4, 2026 (Fortaleza). These are help pages, not inspected account
exports. No protected area was read, account created or supplier contacted.

| Platform | What the official help supports | Boundary for this implementation |
| --- | --- | --- |
| Kajabi | [Course template export](https://help.kajabi.com/en/articles/17174523-rename-and-export-a-course-template) produces a ZIP for a Kajabi template. The [product export help in Spanish](https://help.kajabi.com/es/articles/17174471-puedo-exportar-productos-y-todas-sus-propiedades-xlsx-o-json) distinguishes the template from product properties and content, which need a manual backup. | A template ZIP is not evidence of a portable course-content format. The English product-export URL could not be opened; the Spanish official article was available in indexed search. No ZIP parser is claimed. |
| Teachable | [Exporting school content and data](https://support.teachable.com/en/articles/12053250-how-to-export-school-content-and-data) says there is no single course export or bulk content download; media is downloaded individually and text copied to a separate document. User and transaction CSVs are separate. | No invented Teachable JSON/CSV course export. Individual files and a creator-authored outline are a distinct path. |
| Thinkific | [Exporting a course](https://support.thinkific.com/hc/en-us/articles/360056548394-Can-I-export-my-course) says there is no whole-course file or bulk download and describes obtaining individual videos, PDFs, audio, files and text. [Quiz export help](https://support.thinkific.com/hc/en-us/articles/360056480114-Can-I-export-quiz-questions) requires manually copying questions, answers and explanations. | Official indexed article content was available, but the direct course article returned a generic site page. There is no tested native export schema here; quizzes are not imported. |
| Podia | [Downloading files](https://help.podia.com/en/articles/11370487-downloading-items-from-your-files-library) supports individual downloads, not bulk downloads. Downloaded video and audio are processed versions; keeping original files separately is recommended. | No claim of lossless originals, bulk course export, lesson structure or quiz export. |

Inference from these sources: the independent creator-file path expressly
allowed by item 260 is useful. The sources do not prove compatibility with any
unseen vendor file. Synthetic tests exercise only Marktmorgen's own format.

## Input and preview

`previewCourseImport` accepts only a JSON string, never a caller-supplied object.
The exact versioned shape is:

```json
{
  "format": "marktmorgen-course-draft-v1",
  "ownsContent": true,
  "title": "A course",
  "modules": [{
    "title": "Start here",
    "lessons": [{
      "title": "Welcome",
      "text": "Lesson text, kept exactly as written.",
      "video": "media/welcome.mp4",
      "files": ["files/worksheet.pdf"]
    }]
  }]
}
```

`ownsContent: true` is an explicit declaration, not proof of legal ownership.
Use `video: null` and `files: []` when appropriate. Every field is required;
unsupported fields reject the whole outline instead of silently losing quizzes,
drip schedules, preview settings, access rules or other behavior. Existing course
editor limits are imported from `lib/course.ts`; none is changed or duplicated.
The lesson ceiling applies across all modules. No invalid lesson is dropped and
no text or title is truncated. A refusal identifies its expected field location
and returns no partial draft or uploaded assets.

Text is data, not HTML to execute or instructions for an AI model. A future UI
must escape it as plain text. Local asset references are at most 256 characters,
with no URL, absolute/drive path, traversal, backslash, percent escape, query,
fragment, empty path segment, edge whitespace or hidden direction control.
Distinct case/NFC aliases are refused; exact repeated references are listed
once while lesson references are preserved. The preview does not read local
files, unpack archives, inspect MIME signatures, prove existence, measure video,
resolve redirects or download from a supplier. These paths are not ProductFile
objects and cannot be used as stored asset credentials.

The 16 MiB UTF-8 ceiling applies before JSON parsing; it is a technical parsing
bound, not a new plan entitlement. Original lesson text is kept, including
Unicode. A successful result says `state: "preview_only"`; `storageBytes`,
`videoSeconds` and `costUsd` are all `null`, never estimated as zero from names
or user declarations. No ID, access grant, saved course or upload token is made.

## Costs and remaining work

Current productive invocation count: zero; no caller was added. Per execution,
this pure function makes zero Redis commands, file reads, provider requests,
writes, emails, model calls or retained records. Parsing and in-memory copies
are bounded by the 16 MiB input and existing course shape limits. Zero provider
calls is not a zero total supplier/infrastructure cost: future request ingress,
function CPU/memory, retries and rejected previews still need a paid ceiling.
CI and review remain an unknown fixed Marktmorgen cost under FX275.

Before any live route or upload, the next unit must bind the preview to selected
files; verify ownership context, file signatures and measured size/duration;
check current plan storage and video rights; reserve the complete paid upload,
processing, transfer, write, retry and retention envelope **before** the expense;
and use existing store upload/data admission. Unknown cost must refuse that
expense. A preview is never that admission. No plan, commission, commercial
terms, opening flag, tax reading or gate changed in this unit.

Persistence also needs a transactional/idempotent draft protocol with readback,
honest partial-failure reporting and cleanup that never removes the creator's
originals. Do not wire this through other agents' open course/storage PRs or
claim end-to-end migration, measured margin, real export compatibility or
customer availability before those units are tested and published.

## Validation and accessibility

The RED baseline has 93 checks and 10 behavioral failures, including the positive
outline, asset list, unknown-cost fields, global lesson count and refusal location.
The same assertions pass after implementation; an additional UTF-8 byte-bound
check is permanent. `tests/run.mjs` discovers `course-import.test.ts` as part of
the existing test run, without a second runner or test-config override.

No UI changed: 0 to 0 user steps and decisions. No human test, keyboard/browser
journey, complete accessibility audit or AAA certification is claimed. A future
preview must offer one clear review action, exact problems and corrections,
preserve user input, and require deliberate confirmation before saving.
