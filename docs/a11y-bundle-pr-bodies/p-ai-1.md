# The Store assistant says only the reply, once, and keeps the focus

Branch `claude3/keep/p-ai-1` at `662ce748f`, from main.

## What changes
- `components/store-assistant.tsx`: the thread is no longer the live region (it read out the buyer's own question, the labels, and a kept conversation as it came back); a status region says "AI assistant: <reply>" once a reply comes.
- Ask and the hand-over's Send are `aria-disabled` while waiting instead of `disabled`, which dropped the focus to the page; `ask()` and `handOff()` already refuse a second press.
- The "AI assistant" label is still drawn by the page; replies are plain text, with no links.

## Criteria
- WCAG 2.2 4.1.3, 2.4.3.

## Proof
- RED `6c63834ee`: `tests/store-assistant-reply-announced.test.ts` (Chromium, synthetic server): 5 of 8 fail on main; 8 of 8 after. 44 assistant test files pass; `tsc` clean.

## Accessibility
- Checked: what is added to live and status regions on open and after a reply; the focus while a reply is on its way and after it.
- Steps and decisions for the main task: none added or removed.
- Not checked: real assistive technology (screen readers, voice control), testing with people (item 202), Safari, Firefox and phones. Automated tests do not prove conformance.

## Other PRs to join with care
- **#4101 (Claude 7) touches three of the same lines**: `components/store-assistant.tsx` 66 (state), 98 and 113 (`ask()`). It also adds an always-mounted `<div role="status">` for Sent/Deleted/spent, and its `tests/store-chat-focus-browser.test.ts` expects exactly one status region in the assistant. Whoever joins the two: put this branch's `said` line inside #4101's status region (as `claude3/keep/p-ai-2` does for the store chat), so that test still finds one region.
- #3916, #3922: line 229 (the Ask button's classes).

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
