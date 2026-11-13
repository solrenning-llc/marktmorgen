# Email accessibility: what waits for PR #3755 (13 November 2026)

AX274 item 5. Found by the studio and email audit of 13 November 2026 (Claude 3,
cloud session P), after [the audit of 11 November](accessibility-email-pdf-audit-2026-11-11.md).
These are recorded so they are not lost; none is fixed here, and none is a pass.

## Waiting for PR #3755 to be merged

PR #3755 ("HTML service emails are whole pages with the subject as title")
rewrites both functions below, on the lines next to the fix. Changing them
before it is merged would conflict with it, so each follows once it is in main.

| Letter | Where | Gap | WCAG | Fix to make |
| --- | --- | --- | --- | --- |
| Store-closing notice to buyers | `lib/closing-buyers-rules.ts`, `letterHtml`, the `linked` helper | A web address in the letter becomes a link whose words are the address; with no space to break at, a long one makes a phone scroll sideways | 1.4.10 Reflow | Give that link `word-break:break-all;overflow-wrap:anywhere`, as `lib/mail-body.ts` `linked` does since branch `claude3/keep/p-mail-a11y-2` |
| Import letters: moved purchases, member invitations | `lib/imports.ts`, `letterHtml` | The letter's addresses are plain text in a `<p>` with no wrapping rule, so a long one also overflows a phone | 1.4.10 Reflow | Let the paragraphs wrap a long word (`overflow-wrap:anywhere`) in the whole-page version #3755 makes |

How to check each, after the fix: render the real letter with a synthetic store
and a long address, open it in Chromium on an emulated iPhone 13 and at 320 px,
and confirm `document.documentElement.scrollWidth` equals the window's width,
with no axe violation under the A, AA and AAA tags.

## Not ours to change now

- `lib/api-write.ts` (access given through the API) and `lib/inbound-mail.ts`
  (mail forwarded to a creator): reserved by Codex (`docs/reservations/codex.md`).
  Their gaps are in the audit of 11 November.
- The signed agreement copy's missing viewport: PR #3768.

## Done on 13 November 2026, not merged (branches without a pull request)

- `claude3/keep/p-mail-a11y-1`: the moved or canceled event email
  (`lib/community-event-mail.ts`, `noticeHtml`) has a head, character set,
  viewport and the subject as its title (2.4.2, 3.1.1, 1.4.10).
- `claude3/keep/p-mail-a11y-2`: a long address in a store email's text wraps
  on a phone (`lib/mail-body.ts`, `linked`; 1.4.10).
