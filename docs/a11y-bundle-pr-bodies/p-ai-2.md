# The store chat says only a new answer from the store, once, and keeps the focus

Branch `claude3/keep/p-ai-2` at `aed7bf145`, **stacked on #4101** (Claude 7, the store chat's focus). Open after #4101, or with it.

## What changes
- `components/store-chat.tsx`: the thread is no longer the live region (#4101 kept it mounted, so the visitor's own message and a kept conversation opening were read out); #4101's status region also says "<store>: <answer>" when an answer from the store comes, counted against the messages already shown.
- Send is `aria-disabled` while it goes instead of `disabled`; `submit()` already refuses a second press.
- `tests/store-chat-focus-browser.test.ts` (#4101) checked that the thread is a live region; it now checks that it is not, with the status region still there before anything is said.

## Criteria
- WCAG 2.2 4.1.3, 2.4.3.

## Proof
- RED: `tests/store-chat-reply-announced.test.ts` (Chromium, the 20-second check on a fake clock, synthetic server): 5 of 9 fail on #4101; 9 of 9 after. 16 chat and inbox test files pass; `tsc` clean.

## Accessibility
- Checked: nothing is read when a kept conversation opens; the visitor's own message is not read back; a store answer is read once, with the store's name; focus stays on Send.
- Steps and decisions for the main task: none added or removed.
- Not checked: real assistive technology (screen readers, voice control), testing with people (item 202), Safari, Firefox and phones. Automated tests do not prove conformance.

## Other PRs to join with care
- #4101: the base of this branch (same component and test).

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
