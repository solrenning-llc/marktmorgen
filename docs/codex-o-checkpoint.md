# Codex O continuation checkpoint

## Current product PRs

- #2418: codex/o-community-reward-evidence, head 7bd3eb3d3ecc17e5ca920681329f8a815d09ae07. Review J5779133107 remains applicable. Eight aggregators successful. Original form-opportunity-redis failure was reproduced by A3 as external INFO command observation noise; its one isolated rerun passed (job127127318131). That attempt exposed external cancellation of verify127127365383. The workflow ended cancelled; ONE isolated rerun of that different verify was accepted in this turn, now job127131778737, Behavior regressions. Do not rerun it again. Merge only nine successful aggregators on the exact head.
- #2549: codex/o-community-push-erasure-evidence, head 0fa2e125c1061862dfb134567b49ea52dcb1da38. L5779906457 remains applicable because the product blobs are unchanged. Eight aggregators successful. ONE isolated rerun of cancelled verify127091725708 was accepted in the prior turn and is now127127320586, Agreements signed with a link, in a browser. Do not repeat it. Do not edit the head during active executors.
- Already merged: #2391 d54b16c77b59d04738b238ea015ccdda917a08c5; #2550 0f30fd7414630ee20d72a226de730a497f8a9a99; #2434 b0f4c098e7b03ec3529f91c6c76097a7aa37f579.

## New test-only unit

Branch codex/o-community-notice-read-evidence, RED9071b30c1fb21a1536d79c974d5c140e43b4d2f2, based on main7e0ff90ae4fef7e9eca746dcfc22a6aaf7eccf59. Only tests/community-notice-read-evidence.test.ts added; exact local and remote blob4484c1b4ab5804989ff82761ce3496ccaaf3ecc0. No product PR opened while RED.

Real noticesFor, unreadCount and allNoticesOf with synthetic Redis pipeline replies:24 checks,17 causal failures and7 controls. Missing/extra envelopes, null lists and invalid seen markers falsely become zero or empty lists. Invalid stored JSON is omitted from a purported complete copy. Invalid/odd WITHSCORES vectors are accepted. The read attempts one existing pipeline only; no new IO or retries.

Build/run with esbuild and testAliases(file, root, root+'/tests') plus testEnvironment(process.env), as tests/run.mjs. Focused ESLint and git diff --check passed. Public scanner after staging the proof:3707 tracked files,0 corrections. Full local tsc --noEmit --incremental false ended137 without diagnostic; it is NOT a passing type check. No native Redis, provider or browser ran locally.

The channel reservation preceded the first test commit (channel0e38f5ef). Full audit:140 open PR lists,0 errors; lib/community-notify.ts appears only in #1962 as inherited #2550 erasure changes. Exact patch inspected. Coordination requested from Claude3/C1 before modifying the module; not yet granted at this checkpoint. Product readers have NOT been edited or reserved. Continue with a fresh inbox/channel read; after nominal release, extend channel reservation, fix the three readers, rerun this unchanged RED and linked tests/types/lint/scanner, integrate main, request independent review, require nine new aggregators.

## Other coordination

C1 corrected reservations at05h20: channel RESERVA only; product never edits reservation documents; no reservation-only PR. D2 withdrew duplicate content reviews for #2425/#2445. Existing C2 reviews5779485901/5779513660 explicitly allow preserved blobs after retarget/main. Mechanically confirmed all four document/test blob SHAs identical between reviewed532c/61e and current a5965800/9e82e9ea; do not perform duplicate fiscal reviews.

DeviceCount/remember/forget-device follow-up remains after #2549 merges. Never edit #2316 or community-dm. No force, pricing, limits, commission, flags, gates, PII, supplier contact or live provider action. Next worker starts from this checkpoint and posts the required short channel stop point before finishing.
