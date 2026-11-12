# Private company operational observations — MR2

Owner instruction, November 5, 2026, 03:50 Fortaleza. This is a pure presentation boundary and a reusable server-rendered view. It is not a deployed owner page, collection job or delivered report.

The owner needs operational failures even when actual financial reconciliation is unknown. `companyOwnerReport` always produces six independent sections: `closedData`, `storeForget`, `keptStar`, `settlementEvidence`, `sesPause`, and `manualLook`. It never sums overlapping groups. Missing, malformed, future or older-than-one-hour observations remain visible as unknown, with no numerical zero substituted. The one-hour freshness rule applies only to this presentation snapshot; it changes no customer quota, retry policy or provider behavior.

## Input and privacy

Only a JSON string of at most 65,536 UTF-16 characters, or null, is accepted. Supplied objects, getters, proxies, serializers and callbacks are never inspected. Parsed data uses an exact field allowlist per source; extra private fields invalidate that source. Output contains only fixed Portuguese text, safe integer counts, observation times and strictly formatted application-fee references. It is detached and frozen. Shape validation cannot authenticate a snapshot or certify its collection, costs or completeness.

Each supplied source includes `observedAtMs`. `closedData` uses the eight numerical fields confirmed by Claude 4: parked, stopped, left, stuck, unread, unreadKept, owedKept and scansStuck. `storeForget` includes the requested month and queued, done, gaveUp, waitingNow and keptNow; its combined source does not distinguish webhook failures from key-revocation failures. `keptStar` includes month and times, a count of observations rather than unique accounts or incidents.

`settlementEvidence` accepts only scope `run`, the three separate unknown counters, the corresponding fee-id lists and the execution's complete flag. It always says the monthly total is unknown. It never executes `settleShares`, which can refund money. A later monthly snapshot needs its own persisted, bounded and funded source; execution counts cannot be added blindly across overlapping runs.

`sesPause` preserves the A3 contract: status ready, paused or unknown; observedAtMs; holdUntilMs. Unknown status is displayed as unknown. A cached ready observation is explicitly not a current provider query. No raw provider reason, account, address, message count, incident count or zero duration is invented. `manualLook` requires the explicit minimumWeeks=12 measurement and separate stopped/stuck counts; closedData's unaged counts cannot supply it.

`CompanyOwnerReportView` recalculates the presentation from the serialized input. It renders six headed sections in Brazilian Portuguese, timestamps in UTC and no form, link, script or action. The future caller must authenticate the owner before rendering it. No route is added here.

## Source dependencies and remaining work

- Claude 4: #2560 closedData and the age-qualified manual-look observation; #2556 storeForget and keptStar. Their operational readers remain in their author's files.
- A3: a bounded and prepaid SES cache observation after #2338. Do not call sesState to build a report.
- I2: a dated, bounded and funded snapshot after #2360. The current SettleCounts is per execution, not a monthly history.
- E2: authenticated internal owner route, source admission/funding, integration with monthly presentation and eventual delivery after those sources are ready. This view alone does not satisfy the entire owner-report instruction.

## Cost and verification

This unit adds no Redis read/write, provider call, key, retention, scheduler, token or spending authority. Its own IO count is zero; no operational reader is wired or claimed funded. Source costs and actual company margin remain unknown until separately evidenced. CI and development costs belong entirely to Marktmorgen and are not assumed zero.

The initial RED is a missing-module build before implementation, not a functional ledger failure. A separate functional RED preserves 15 tests with two failures: an inherited source fabricated a ready observation, and an inherited timestamp executed four getters while refusing an incomplete source. Own-field checks close both paths before access. Tests cover every section, missing and malformed counts, source isolation, freshness, month separation, per-run settlement scope, fee references, privacy, zero versus absent evidence, hostile non-string inputs, frozen output and the actual server renderer. Hosted checks and independent review remain required.

Accessibility: the reusable view has six semantic headings and lists, no interactive task, and 0 → 0 steps or decisions. No browser or human accessibility certification is claimed. All new owner-facing text is Brazilian Portuguese; customer language files are untouched.
