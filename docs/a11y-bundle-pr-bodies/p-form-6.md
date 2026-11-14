# The unsubscribe page's "not saved" line is read out

> Now in the `community` bundle (`claude3/keep/p-bundle-community`): open that bundle, not this branch. Its overlap list is the bundle's, against the PRs open on 14 Nov 2026.

Branch `claude3/keep/p-form-6` at `6a7e92b1c`, **stacked on `claude3/keep/p-form-4`** (in the community bundle), which adds `components/community-flash.tsx`. Open after the community bundle.

## What changes
- `components/community-flash.tsx`: `FocusedStatus`, the community line's behavior without its look (focus once, `tabIndex -1`); `CommunityFlash` draws it.
- `app/unsubscribe/page.tsx`: the three "not saved" lines (list, review requests, community announcements) are `FocusedStatus`, drawn only when the last press was not saved.
- `tests/unsub-link-exact.test.ts`: its renderer awaits only async server components and leaves a client one to `renderToStaticMarkup`; its checks are unchanged (49 pass).

## Criteria
- WCAG 2.2 4.1.3 (a role=status already there at load is not read).

## Proof
- RED: `tests/unsubscribe-not-saved-announced.test.ts` (source and Chromium) fails on the base; passes after. 13 unsubscribe and community-flash test files pass; `tsc` clean.

## Accessibility
- Checked: focus lands on the line once when the page opens, it keeps `role=status`, it is not a Tab stop, the next Tab reaches the button.
- Steps and decisions for the main task: none added or removed.
- Not checked: real assistive technology (screen readers, voice control), testing with people (item 202), Safari, Firefox and phones. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3, snapshot 13 Nov 2026 23:15 UTC-3)
- #3476: `app/unsubscribe/page.tsx` 14 (imports).

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
