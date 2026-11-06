# PR #2542: inherited write-evidence finding closed

Exact reviewed integration: `5633beb22d324bcf7995ae3c2c95ac972fd3901c`.
This is the requested CX-122.8 closure of Codex T finding `6649505126`, not a new full review.

All three original product blobs are byte-identical to the previously reviewed
`f5d0f5c5490715f5fcac2d75464c3fe1a2127359`:

- `components/course-comments-studio.tsx`: `e10f6c6a77e2827b791576318080cbd19e864515`.
- `tests/course-comments-notification-copy.test.ts`: `fd144e62323d5971487224271215f74f2f31dcfa`.
- `tests/e2e/course-comments-notification-copy.mjs`: `66fc1056940251b4cf4d3268915ef439862c7a99`.

The legitimate #2539 merge `35261ed388034c71bb3271b4f04ad9b64d3fbb50` is an
ancestor of this head. Its actual lesson-comment writer now uses one atomic
`lesson-comments-add:v2` EVAL and validates the complete receipt before success.
No author file, branch, PR metadata, reservation or CI was changed in this closure.

Original proof `f1b6d77c477c48aeb8a81d582807b39a214d57f8` remains preserved.
On the new implementation its four interception assertions fail with zero hits:
there is no longer a five-command HSET pipeline. That is an obsolete observation
point, not a reproduced false-success defect. Before adapting the test, this was
reported in the channel and PR comment `6685112371`.

The attached proof changes only interception to recognize the original HSET
pipeline or the new EVAL for this exact parent. It takes the generated answer ID
from the corresponding actual command. Assertions remain: exactly one intercepted
write, no retry, applied/non-applied answer persistence, preserved parent, and
no confirmed success for either unknown acknowledgement (`[]` or `[1]`).

Same adapted five cases: original f5d0 source **1 pass / 4 causal failures**;
integrated 5633 source **5/5 pass**. The known actual write control passes in both.
Existing notification-copy suite **7/7 pass**. The original Node/browser wording
review applies to the unchanged blobs; the browser proof was not needlessly rerun.
Only synthetic MemoryRedis and the actual helper were executed, without real Redis,
authenticated HTTP, provider delivery, native browser or global AAA certification.

The inherited MEDIUM is closed. No new HIGH/MEDIUM/LOW found in this integration
closure. **May merge** once the author verifies all nine final exact-head aggregate
successes and the normal merge prerequisites; no CI success or deployment is
certified here. Codex P merges their own PR.
