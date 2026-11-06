# Exact form reads and confirmed response receipts

This follows #2821 (merged as 738a7124c3fd75cdbcf1b3fed4e544cf7d5a8575), under C4-2430 and CX-123 rules 24/30. An unknown form inventory, definition, count or write receipt must never become confirmed absence, zero, a successful submission or released storage room.

## Product behavior

- `readForms` requires its exact HVALS envelope and every readable stored form. It never filters away an unreadable row.
- `readForm` accepts exact HGET null as confirmed absence; another unreadable reply throws `UnknownReply`.
- `responseCounts` requires the exact reply count and native nonnegative safe integers.
- `addResponse` validates both LLEN/LINDEX preflight slots before reserving room. It validates the returned list of readable removed responses before adjusting room. An unknown write retains its reservation and never proceeds to downstream submission effects.
- `dropForm` requires both deletion receipts to be native zero or one before giving room back.
- Studio Forms reports an unread inventory with a status notice and suppresses the editor, preserving healthy and confirmed-empty behavior.
- Public submission returns 503 for an unreadable definition. Confirmed absence remains closed. An unknown KEEP receipt uses the existing error return, without enrollment, funnel completion or a success redirect in the tested scenarios.
- CSV/PDF return 503 for unavailable definitions; confirmed absence remains 404. CRUD maps `UnknownReply` to 503 before any confirmed edit/removal.
- Email reads form choices once only when the existing nonzero-allowance branch would use them. An unread inventory blocks workflow configuration and template creation, with a specific status notice. Healthy choices and known-empty inventories remain distinct.
- Public own-page and result-page form reads propagate unknown/transport failures to the existing `app/error.tsx` retry boundary. Confirmed missing records retain their previous behavior. Only the two form-read catches changed; page storage, metadata and SEO were not edited.

## Durable causal history

| Evidence | Before | After |
| --- | --- | --- |
| Original sibling proof `9f8d9092c5b6fcd1cfd14b0879eb37fb48894db8`, byte-identical and retained as a parent | 29 checks, 5 failures | Same 29 pass |
| Shape and real privacy-export proof `d3e4ef90dd6d3246f2a50442a181aeb1bb3f1a68` | 117 checks, 56 failures | Same 117 pass |
| Definition/CRUD HTTP proof `afc70f325a09c207ae7ad42b64e060f25c69be4d` | 12 Node tests, 4 failures, 8 controls | Same 12 pass |
| Studio inventory proof in `ddea6c5fc18e49616fd57d06e9d288eb9accdc04` / later controls in `b2e0846b` | 16 Node tests, only inventory fails | Same 16 pass after `83f71b5a` |
| Email and public submission proof `af9a6ed85a54511488e15d16c90f786a72c52320` | 21 Node tests/2 failures; 61 submission checks/4 failures | Same 21 and 61 pass |
| Real public pages `4caa7750a7c834f58a0bd1c860c4a2b799e75e4f` | 9 Node tests, 4 failures, 5 controls | Same 9 pass |

The initial shape-test EVAL matcher accidentally targeted data-room admission. `0e25f2e` corrected it to the actual `form-keep` script and reran the unchanged old helper (111/53). Matcher/build-mounting errors are not product findings. No product expectation or timeout was weakened.

After the helper repair, corroboration extended the shape proof to 121 checks: real person copier, store export, funnel receiver and store-copy preview. Replaying those exact bytes against original helper 738a7124 gives 59 failures; repaired 121/121. This corroboration was added after repair, not claimed as the original chronology. The four consumers encounter four selected unknown replies after repair, versus five before: the old preview incorrectly continues to read the target after accepting an unknown source. It is not 59 independently lost records.

The privacy copier throws; the real store stream omits forms and emits `unreadPart4`; funnel capacity refuses unknown; `previewCopy` refuses planning a false zero-form copy. Their existing exception handling needs no product changes. Preview is not execution of a whole store copy or proof about a copied payload.

## Verification

Before main integration: 16 canonical files, **452 custom checks and 31 Node tests pass**, including public pages, real HTTP handlers, real form helpers, room accounting/races, erasure, capacity, opportunities, privacy copy/stream, store-copy and funnel setup/review. Actual TypeScript over 17 source/test roots and real imports: zero diagnostics. Directed lint over those roots and the isolated test wiring: zero errors.

The repository test runner discovers the evidence through its existing per-file wiring. Only the existing form-response block and two new independent per-file blocks changed. Application modules are real unless explicitly identified as synthetic service/rendering boundaries in each fixture.

## Read ceilings and limits of the evidence

Synthetic application command ceilings are checked before each batch: 20 per helper/submission case, 10 per public-page case, and 300 across the privacy-copy/export/receiver/preview group. The final group observes 29 commands after repair (34 in the old-helper replay). Setup and direct fixture inspection are separate. Public submission observes 5/1/1/1/5 commands across its five cases. Public pages observe one HGET, or none for a page without a form.

No productive command, key, retry, retention, provider operation, price, limit, commission or gate is added. Moving the email form read preserves the existing zero-allowance skip. The submission fixture has `offerList=false`: it does not certify absence of an email attempt for an offer-list form, whose existing join request precedes KEEP.

Redis is MemoryRedis; selected malformed receipts and service/auth/rendering boundaries are synthetic. No native Redis, provider, real payment, browser/assistive-technology session, production deployment, complete journey or global accessibility certification is claimed. The public-page tests prove rejection into the application error boundary, not a particular HTTP status from Next streaming.

## Accessibility

Unavailable inventory and email configuration use `role=status` and plain recovery text. Controls based on unknown inventory are withheld; healthy tasks retain their existing controls. Public pages reuse the existing error boundary with its Try again and Home page controls, without new public copy or language changes. Failure recovery can require one reload; this is not claimed as zero extra steps. Automated server rendering verifies notices and control suppression; keyboard, screen-reader and AAA certification are not claimed here.

## Coordination

Reservations are channel-only; no reservation document is changed. Fresh inventories found no public-page PR overlap. #1969 no longer changes Studio Forms/Email; #2287 only changes enrollment comments outside the definition read; #1965 workflow flags and #2314 health table lines remain intact. U was notified of form-only public catches; its page-storage/metadata work remains separate. C5 empty-state design follows the Forms repair. All original heads and REDs are preserved.
