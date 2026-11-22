# STN11 unit 1 — local, partial, not integrated

Base: 0e8b8c6b531738d55ae7f60ab96393289cdc2eaa.
Local RED commit: eec6fe5d3 (three source integration assertions fail against unchanged page).

The existing EmailStudio counter is below the composer on narrow layouts and its page uses usedThisMonth, which normalizes malformed replies to zero. usedThisMonthExact already exists. No counter/backend or reserved EmailStudio source has been edited. P requested a narrow Q/U lease in channel CXP-20261109-STN11-Q-SCOPE; silence is not a lease.

Prepared component: EmailUsageSummary reuses the existing UsageMeter. Exact supplied totals (including zero and overuse) remain visible as text. Unknown/invalid totals give a named status and reload advice, without a false zero/progress value. No new IO, effect, opening tracking, persistence, provider or cap.

Executed: source RED 3 tests / 3 failures; current isolated suite 7 tests / 4 passing rendering cases and the SAME 3 still-failing integration requirements. No assertion removed or weakened. This is not a green whole unit. Current email page, reserved EmailStudio and backends remain byte-identical to base. Integration has not been applied.

Validation: scoped semantic TypeScript diagnostics 0 (new component, existing UsageMeter and permanent test); lint 2 files, 0 errors/warnings (React detection warning from lint's dependency resolver is retained in log). React/ReactDOM 19.2.8 match the head. Existing read-only tool cache has Next/eslint-config-next 16.4.2 versus head 16.4.5: this is NOT an exact-lock Next/build certificate. Native Node 24. No dependency installation.

Pre-execution caps: compile 512 MiB, runtime 256 MiB V8 heap, 30 seconds wall / 25 seconds CPU, 256 KiB per output file. First compile refused BEFORE assertions because bundling React exceeded the artifact-size cap. Kept original refusal log. Revised compilation links exact installed React/ReactDOM externally, reducing the artifact, retaining the same caps. This is not a retry of a partially executed runtime or a new allowance for provider IO. Runtime preloader denies fetch/http/https/net/tls before the test graph; no Redis module in this pure graph. Types: 768 MiB, 55s wall / 50s CPU; lint512. No cap increased for a failed runtime. No real provider request.

Accessibility: heading/region associations and unknown status checked in real React SSR; text supplements the reused meter and confirmed limits retain their supplied numbers. No new interaction, time limit or motion. Criteria 1.3.1, 1.4.1, 2.4.10, 3.1.5, 4.1.3 addressed in static/SSR scope. 320px/400% reflow, contrast measurement, browser, screen-reader and human testing NOT done. No AAA certification.

Steps: target is reading usage before writing without scrolling past the composer; no new decision. Not integrated, so no customer step change exists yet. Per-person send-time learning is a separate STN11 unit, not built. WhatsApp and AI video remain forbidden.

Pending: explicit reserved-component lease; wire exact counter availability (known window/list/Redis, malformed response -> null), preserve drafts/composer on unknown, replace the old false-counter display and reuse the existing one read. Add full caller/unknown coverage and run linked tests/types/lint/scanner/diff before requesting review. No review request, PR, push, queue, CI, flag, price, visible limit, account or term change.

Evidence housekeeping: git diff --cached --check reported four trailing-space lines in the raw Node assertion log. The original bytes are preserved in component-wip.log.json with byte count and SHA-256; no assertion/output text changed. The original raw log remains in local parent commit c5fdedd65 and the working directory. Product-source whitespace check is separate.
