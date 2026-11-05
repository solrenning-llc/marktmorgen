# Codex A3 independent review: PR 2591

Exact author head: `c81428cefc1abc5f89db80d9239b07b9a2b8fe72`.
The complete six-file product delta against main `fb7f253ba0e41f7bb0d2d146e8bc95690d37bc88` was read. Main-only additions since the original 8f4a6e947 commit, including the lesson code-block label and other course words, were distinguished from this unit.

No new high, medium or low finding was reproduced. May merge after the nine final-head aggregators succeed and the normal repository conditions are met. The previously reported movement and buyer-notice issues remain with their existing owner and must be addressed before future activation; this review does not close or recount them. The flag remains off by default.

## Independent browser proof

`scripts/review_a3_2591_browser.mjs` bundles the actual component, React client and its pure library, and compiles the actual class candidates with the installed Tailwind. It serves that isolated fixture on an owned loopback server, blocks external routes and closes the server and disposable Chromium contexts afterward. It does not use a fake Fullscreen API in the primary case.

- Real Chromium native entry and exit work through the visible button. The browser's fullscreen element contains both the video and mark; the label changes to Exit full screen and back after leaving.
- The actual generated CSS normalizes `calc(100vh-6.5rem)` to valid `calc(100vh - 6.5rem)`. Native computed max-height is 496px in the 600px viewport.
- A synthetic HTML-looking mark stays escaped text: no injected image element appears. It remains aria-hidden.
- A separate unsupported-capability context hides the control while keeping the video and mark.
- A separate synthetic rejected-promise context makes exactly one attempted request, does not claim full screen or crash, and unmounts successfully. This is an injected API refusal, distinct from the real native primary case.

This is an isolated component test, not a complete served lesson, paid account, streaming-provider frame, real video playback, phone, Firefox/Safari, assistive technology or human accessibility certification. Fixture button dimensions and reduced-motion settings do not certify production style or movement behavior.

## RED and linked verification

The author's exact final `tests/video-stamp.test.ts` (blob `3d076ca4e374ac155ebaa0612fb832b3448d7ceb`) was run unchanged on its genuine pre-feature parent `161fefa576ad873b58e95bc1db66e1e797bed1da`: 16 checks, one causal wording failure, 15 controls pass. Public RED is `codex/a3-review-2591-red` at `540da7c1c2fb7b02e2ea20a9f47a3d272d45aa98`. It passes 16/16 on the final product. No product, expectation or deadline was relaxed.

Six linked groups pass: video-stamp-player28, video-stamp16, accessibility-inventory16, course-videos18, store-language980 and video-copy3: **1,061 checks/tests**, no failures or skips. The first three passed before an unrelated follow-on command referenced a nonexistent test filename; that command error was not a product failure and was replaced with the actual related test names, without rerunning the successful groups.

Next route type generation and strict scoped TypeScript for all six changed files and their imports pass. Focused lint and diff checks pass. The public-data check is run again with this proof and report staged. No global build, entire CI or deployment is claimed. No author branch, reservation, source or CI was changed.
