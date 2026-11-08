# PR 3156 — requested fenced-delete focal

Subject: `2884a97de14473a5a930b6260c7d0e926b757d84`. Requested in 6724166099 / C3-1342. Claim 6724685121 and channel RES preceded new product diff/source. This continues review 5817277456; no author edits or third opinion.

The demonstrated M1 cause closes in the explicitly derived fenced-boundary witness. No new HIGH/MEDIUM/LOW finding in this focused delta. This is not a global privacy, financial, native-Lua or CI/queue clearance, and does not substitute C1/R2's requested classification of the inherited issue.

## Evidence kept separate

| Probe | Old module in final graph | Subject |
| --- | --- | --- |
| Frozen M1 bare-DEL witness | 6 checks / 1 failure: active store loses team | 6 checks / 3 failures: bare DEL is gone; reactivation hook never reached |
| Derived fenced-DEL witness (author's explicit derivative) | 6 checks / 1 failure: SAME team-loss oracle | 6 checks / all pass: actual reactivation reached, LockBusyError, active store retains team |
| Original reactivation frozen blob376bb54f | historical causal comparison retained | 3 pass, byte-identical source |
| Original concurrent-erasure frozen blob7e0bce24 | historical causal comparison retained | 6 pass, byte-identical source |

Frozen M1 SHA256: `4cabdc83a8eeeddefaca7b6582cb30744ae2cbed122af04984e390a961187863`. Its subject failures are not called green or a demonstrated product regression: the scenario no longer fires. The author described only the reachability failure; execution actually yields three assertions because the store normally completes deletion when reactivation was never invoked. The derivative changes the pause detector to recognize EVAL keys; assertions remain unchanged. In both before executions the old closed-store-data module alone is aliased from86775eaa8 into the final imports and MemoryRedis; this is not a whole old checkout or the author's pre-fix chronology.

The real script checks the store token and performs destructive changes within one EVAL; helper apply injection and the separate FORGET_PATH_HELD guard carry it across preparation. Optional helper defaults retain existing caller behavior. No native Redis/Lua was executed; validation uses the pinned MemoryRedis model and static Lua inspection.

## Main merge and linked checks

Merge parents: ffb3c36d1 and main6b2d78796. The changed unknown-reply expectations follow main's defer-by-WALK_GAP_MS behavior; LockBusyError still propagates before requeue. The three affected suites were executed separately: erase-race-final-check33, erase-reactivated-store29 and closed-store-unknown10 all pass. Their expectations are derived; they do not replace the original probes. Author's census/fence suite55 passes, including each destructive boundary and closeStoreRecord equivalence. Linked closed-store28, store-data33 and registry7 pass. Total210 passing assertions/tests with overlap, excluding the frozen witness's six non-qualifying checks.

Real types:13 roots/all imports,1184 source files,486 pinned repository inputs,0 diagnostics/filters. ESLint0 errors/warnings. Official public-data scanner4533 tracked/0 findings before staging own artifacts;4555 tracked/0 after staging. The whitespace check flags one inherited trailing blank line in the byte-preserved before-module copy; that source is intentionally not normalized. No full build/browser/AT/CI-nine/merge-group/global financial model certification.

Pre-import denial of external socket/fetch; per child20k nested Redis/20k pipeline/100HTTP mocks/120s512MiB256KiB; type process120s1024MiB. Largest8210 nested/7816 pipeline/21 mocks; none reached/raised. Dependencies read-only reused, no install/provider. An attempted linked filename did not exist (ENOENT before child dispatch); corrected by inspecting repository inventory, not a product failure. All actual children and full raw stdout/stderr are in logs/*.log and manifest.json. Bundles/metafiles remain local reproducible intermediates.
